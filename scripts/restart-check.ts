/**
 * Restart check against a running compose stack.
 * Creates a sale, reserves one unit, restarts the backend container,
 * then confirms the reservation, stock and outbox are unchanged and the
 * ticker still moves a new sale to ACTIVE.
 *
 * Run from the repo root: npm run restart-check
 * BASE_URL defaults to http://localhost:3000.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const HEALTH_TIMEOUT_MS = 60_000;

type ApiResult = { status: number; body: unknown };
type Outbox = { pending: number; sent: number; failed: number };
type Result = { name: string; pass: boolean; evidence: string };

type Snapshot = {
  saleId: number;
  reservationId: number;
  status: string;
  expiresAt: string;
  availableStock: number;
  held: number;
  pending: number;
  sold: number;
  outbox: Outbox;
};

const results: Result[] = [];

function repoRoot(): string {
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, 'docker-compose.yml'))) return cwd;
  return path.resolve(__dirname, '..');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function asObj(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function num(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} is not a number: ${JSON.stringify(value)}`);
  return value;
}

function str(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is not a string: ${JSON.stringify(value)}`);
  return value;
}

function errorCode(body: unknown): string | undefined {
  const code = asObj(asObj(body).error).code;
  return typeof code === 'string' ? code : undefined;
}

function explain(res: ApiResult): string {
  return `${res.status} ${errorCode(res.body) ?? 'OK'}`;
}

async function api(method: string, pathName: string, opts?: { body?: unknown; userId?: number }): Promise<ApiResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts?.body !== undefined) headers['content-type'] = 'application/json';
  if (opts?.userId !== undefined) headers['x-user-id'] = String(opts.userId);
  const res = await fetch(`${BASE_URL}${pathName}`, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

async function serverNow(): Promise<Date> {
  const res = await api('GET', '/api/sales/current');
  if (res.status !== 200) throw new Error(`GET /api/sales/current returned ${explain(res)} ${JSON.stringify(res.body)}`);
  return new Date(str(asObj(res.body).serverTime, 'serverTime'));
}

async function login(username: string): Promise<number> {
  const res = await api('POST', '/api/users/login', { body: { username } });
  if (res.status !== 200) throw new Error(`login returned ${explain(res)}`);
  return num(asObj(asObj(res.body).user).id, 'user.id');
}

async function createSale(startsAt: Date, endsAt: Date, stock: number): Promise<number> {
  const res = await api('POST', '/api/dashboard/sales', {
    body: {
      priceCents: 2500,
      totalStock: stock,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    },
  });
  if (res.status === 404 && errorCode(res.body) === 'PRODUCT_NOT_FOUND') {
    throw new Error(
      'No product to attach the sale to. Seed once:\n  docker compose exec backend npx tsx prisma/seed.ts',
    );
  }
  if (res.status !== 201) throw new Error(`create sale returned ${explain(res)} ${JSON.stringify(res.body)}`);
  return num(asObj(asObj(res.body).sale).id, 'sale.id');
}

async function readSnapshot(saleId: number, userId: number): Promise<Snapshot> {
  const cart = await api('GET', '/api/reservations/me', { userId });
  if (cart.status !== 200) throw new Error(`GET /api/reservations/me returned ${explain(cart)}`);
  const reservation = asObj(asObj(cart.body).reservation);
  if (asObj(cart.body).reservation === null) throw new Error('cart is empty');
  const reservationSaleId = num(reservation.saleId, 'reservation.saleId');
  if (reservationSaleId !== saleId) {
    throw new Error(`cart reservation ${reservation.id} belongs to sale ${reservationSaleId}, not ${saleId}`);
  }
  const dashRes = await api('GET', `/api/dashboard/sales/${saleId}`);
  if (dashRes.status !== 200) throw new Error(`GET dashboard returned ${explain(dashRes)}`);
  const dash = asObj(dashRes.body);
  const outbox = asObj(dash.outbox);
  return {
    saleId,
    reservationId: num(reservation.id, 'reservation.id'),
    status: str(reservation.status, 'reservation.status'),
    expiresAt: str(reservation.expiresAt, 'reservation.expiresAt'),
    availableStock: num(dash.availableStock, 'availableStock'),
    held: num(dash.held, 'held'),
    pending: num(dash.pending, 'pending'),
    sold: num(dash.sold, 'sold'),
    outbox: {
      pending: num(outbox.pending, 'outbox.pending'),
      sent: num(outbox.sent, 'outbox.sent'),
      failed: num(outbox.failed, 'outbox.failed'),
    },
  };
}

function formatSnapshot(snapshot: Snapshot): string {
  return [
    `sale ${snapshot.saleId} reservation ${snapshot.reservationId} ${snapshot.status} expiresAt ${snapshot.expiresAt}`,
    `available ${snapshot.availableStock} held ${snapshot.held} pending ${snapshot.pending} sold ${snapshot.sold}`,
    `outbox pending ${snapshot.outbox.pending} sent ${snapshot.outbox.sent} failed ${snapshot.outbox.failed}`,
  ].join('\n');
}

function restartBackend(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', ['compose', 'restart', 'backend'], { cwd: repoRoot() }, (err, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
      if (err) reject(new Error(`docker compose restart backend failed: ${output || err.message}`));
      else resolve(output || '(no output)');
    });
  });
}

async function waitHealthy(): Promise<string> {
  const started = Date.now();
  let last = 'no response';
  while (Date.now() - started <= HEALTH_TIMEOUT_MS) {
    try {
      const res = await api('GET', '/health');
      const body = asObj(res.body);
      if (res.status === 200 && body.status === 'ok' && body.db === 'ok') {
        return `healthy after ${Date.now() - started}ms ${JSON.stringify(body)}`;
      }
      last = `${res.status} ${JSON.stringify(res.body)}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(1_000);
  }
  throw new Error(`backend did not become healthy within ${HEALTH_TIMEOUT_MS}ms; last: ${last}`);
}

async function record(name: string, fn: () => Promise<string>): Promise<boolean> {
  console.log(`\n--- ${name}`);
  try {
    const evidence = await fn();
    results.push({ name, pass: true, evidence });
    console.log(`PASS  ${name}`);
    for (const line of evidence.split('\n')) console.log(`      ${line}`);
    return true;
  } catch (err) {
    const evidence = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, evidence });
    console.log(`FAIL  ${name}`);
    for (const line of evidence.split('\n')) console.log(`      ${line}`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log(`Flash Sale restart check  BASE_URL=${BASE_URL}`);
  console.log(`repo ${repoRoot()}`);

  const health = await api('GET', '/health').catch((err: unknown) => {
    throw new Error(
      `Cannot reach ${BASE_URL}/health (${err instanceof Error ? err.message : err}). Start the stack with: docker compose up --build`,
    );
  });
  if (health.status !== 200) throw new Error(`GET /health returned ${health.status}. Start the stack with: docker compose up --build`);

  const current = await api('GET', '/api/sales/current');
  if (current.status === 404 && errorCode(current.body) === 'SALE_NOT_FOUND') {
    throw new Error('No sale exists yet. Seed once:\n  docker compose exec backend npx tsx prisma/seed.ts');
  }

  let before: Snapshot | undefined;
  let userId = 0;
  const reserved = await record('reserve before restart', async () => {
    const now = await serverNow();
    const saleId = await createSale(new Date(now.getTime() - 5_000), new Date(now.getTime() + 30 * 60_000), 3);
    userId = await login('restart-check');
    const reservedRes = await api('POST', `/api/sales/${saleId}/reservations`, { userId });
    if (reservedRes.status !== 201) throw new Error(`reserve returned ${explain(reservedRes)}`);
    before = await readSnapshot(saleId, userId);
    assert(before.status === 'ACTIVE', `expected ACTIVE, got ${before.status}`);
    assert(before.availableStock === 2 && before.held === 1, `unexpected stock ${formatSnapshot(before)}`);
    return formatSnapshot(before);
  });
  if (!reserved || !before) {
    printSummary();
    process.exitCode = 1;
    return;
  }
  const baseline = before;

  const restarted = await record('docker compose restart backend', async () => {
    const output = await restartBackend();
    const healthy = await waitHealthy();
    return `${output}\n${healthy}`;
  });
  if (!restarted) {
    printSummary();
    process.exitCode = 1;
    return;
  }

  const intact = await record('reservation, stock and outbox intact', async () => {
    const after = await readSnapshot(baseline.saleId, userId);
    assert(after.reservationId === baseline.reservationId, `reservation id ${after.reservationId} != ${baseline.reservationId}`);
    assert(after.status === baseline.status, `status ${after.status} != ${baseline.status}`);
    assert(after.expiresAt === baseline.expiresAt, `expiresAt ${after.expiresAt} != ${baseline.expiresAt}`);
    assert(after.availableStock === baseline.availableStock, `available ${after.availableStock} != ${baseline.availableStock}`);
    assert(after.held === baseline.held && after.pending === baseline.pending && after.sold === baseline.sold, 'stock counters changed');
    assert(
      after.outbox.pending === baseline.outbox.pending &&
        after.outbox.sent === baseline.outbox.sent &&
        after.outbox.failed === baseline.outbox.failed,
      `outbox changed: ${JSON.stringify(after.outbox)} vs ${JSON.stringify(baseline.outbox)}`,
    );
    return `before\n${formatSnapshot(baseline)}\nafter\n${formatSnapshot(after)}`;
  });
  if (!intact) {
    printSummary();
    process.exitCode = 1;
    return;
  }

  await record('ticker still starts a sale', async () => {
    const now = await serverNow();
    const startsAt = new Date(now.getTime() + 3_000);
    const saleId = await createSale(startsAt, new Date(startsAt.getTime() + 2 * 60_000), 1);
    const started = Date.now();
    let lastStatus = '';
    let lastServerTime = '';
    while (Date.now() - started <= 20_000) {
      const dash = await api('GET', `/api/dashboard/sales/${saleId}`);
      if (dash.status !== 200) throw new Error(`GET dashboard returned ${explain(dash)}`);
      const root = asObj(dash.body);
      const sale = asObj(root.sale);
      lastStatus = str(sale.status, 'sale.status');
      lastServerTime = str(root.serverTime, 'serverTime');
      if (lastStatus === 'ACTIVE' && new Date(lastServerTime).getTime() >= startsAt.getTime()) {
        return `sale ${saleId} startsAt ${startsAt.toISOString()} status ${lastStatus} serverTime ${lastServerTime} after ${Date.now() - started}ms`;
      }
      await sleep(300);
    }
    throw new Error(`sale ${saleId} did not become ACTIVE within 20s; status ${lastStatus} serverTime ${lastServerTime} startsAt ${startsAt.toISOString()}`);
  });

  printSummary();
  if (results.some((result) => !result.pass)) process.exitCode = 1;
}

function printSummary(): void {
  console.log('\n======== summary ========');
  for (const result of results) console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}`);
  const failed = results.filter((result) => !result.pass).length;
  console.log(`${results.length - failed} passed, ${failed} failed`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
