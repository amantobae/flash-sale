/**
 * Repeatable HTTP demo against a running backend (docker compose).
 * Each scenario creates its own sale. BASE_URL defaults to http://localhost:3000.
 *
 * The 10-minute hold is not waited out. It is proven by
 * backend/tests/saleTicker.test.ts
 * "(d) expires exactly at createdAt + 10 min, not 1 ms earlier, and is idempotent".
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const PRICE_CENTS = 2500;

type ApiResult = { status: number; body: unknown };

type Sale = {
  id: number;
  status: string;
  priceCents: number;
  totalStock: number;
  availableStock: number;
  startsAt: string;
  endsAt: string;
};

type Dashboard = {
  sale: Sale;
  availableStock: number;
  unsold: number | null;
  held: number;
  pending: number;
  sold: number;
  revenueCents: number;
  recentOrders: { id: number; username: string; status: string; amountCents: number }[];
  outbox: { pending: number; sent: number; failed: number };
  serverTime: string;
};

type Reservation = {
  id: number;
  saleId: number;
  userId: number;
  status: string;
  expiresAt: string;
};

type User = { id: number; username: string };

type Result = { id: string; name: string; pass: boolean; evidence: string };

const results: Result[] = [];

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

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, count]) => `${count} x ${key}`)
    .join(', ');
}

function tally(responses: ApiResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const res of responses) {
    const key = explain(res);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function api(
  method: string,
  path: string,
  opts?: { body?: unknown; userId?: number; idempotencyKey?: string },
): Promise<ApiResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts?.body !== undefined) headers['content-type'] = 'application/json';
  if (opts?.userId !== undefined) headers['x-user-id'] = String(opts.userId);
  if (opts?.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(`${BASE_URL}${path}`, {
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
  if (res.status !== 200) {
    throw new Error(`GET /api/sales/current returned ${explain(res)}: ${JSON.stringify(res.body)}`);
  }
  return new Date(str(asObj(res.body).serverTime, 'serverTime'));
}

function readSale(value: unknown): Sale {
  const sale = asObj(value);
  return {
    id: num(sale.id, 'sale.id'),
    status: str(sale.status, 'sale.status'),
    priceCents: num(sale.priceCents, 'sale.priceCents'),
    totalStock: num(sale.totalStock, 'sale.totalStock'),
    availableStock: num(sale.availableStock, 'sale.availableStock'),
    startsAt: str(sale.startsAt, 'sale.startsAt'),
    endsAt: str(sale.endsAt, 'sale.endsAt'),
  };
}

function readDashboard(body: unknown): Dashboard {
  const root = asObj(body);
  const outbox = asObj(root.outbox);
  const orders = Array.isArray(root.recentOrders) ? root.recentOrders : [];
  return {
    sale: readSale(root.sale),
    availableStock: num(root.availableStock, 'availableStock'),
    unsold: root.unsold === null ? null : num(root.unsold, 'unsold'),
    held: num(root.held, 'held'),
    pending: num(root.pending, 'pending'),
    sold: num(root.sold, 'sold'),
    revenueCents: num(root.revenueCents, 'revenueCents'),
    recentOrders: orders.map((order, index) => {
      const row = asObj(order);
      return {
        id: num(row.id, `recentOrders[${index}].id`),
        username: str(row.username, `recentOrders[${index}].username`),
        status: str(row.status, `recentOrders[${index}].status`),
        amountCents: num(row.amountCents, `recentOrders[${index}].amountCents`),
      };
    }),
    outbox: {
      pending: num(outbox.pending, 'outbox.pending'),
      sent: num(outbox.sent, 'outbox.sent'),
      failed: num(outbox.failed, 'outbox.failed'),
    },
    serverTime: str(root.serverTime, 'serverTime'),
  };
}

async function getDashboard(saleId: number): Promise<Dashboard> {
  const res = await api('GET', `/api/dashboard/sales/${saleId}`);
  if (res.status !== 200) throw new Error(`GET dashboard ${saleId} returned ${explain(res)}`);
  return readDashboard(res.body);
}

async function login(username: string): Promise<User> {
  const res = await api('POST', '/api/users/login', { body: { username } });
  if (res.status !== 200) throw new Error(`login ${username} returned ${explain(res)}`);
  const user = asObj(asObj(res.body).user);
  return { id: num(user.id, 'user.id'), username: str(user.username, 'user.username') };
}

async function createSale(input: { stock: number; startsAt: Date; endsAt: Date; priceCents?: number }): Promise<Sale> {
  const res = await api('POST', '/api/dashboard/sales', {
    body: {
      priceCents: input.priceCents ?? PRICE_CENTS,
      totalStock: input.stock,
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
    },
  });
  if (res.status === 404 && errorCode(res.body) === 'PRODUCT_NOT_FOUND') {
    throw new Error(
      'POST /api/dashboard/sales returned 404 PRODUCT_NOT_FOUND. Seed once so a product exists:\n' +
        '  docker compose exec backend npx tsx prisma/seed.ts',
    );
  }
  if (res.status !== 201) throw new Error(`create sale returned ${explain(res)} ${JSON.stringify(res.body)}`);
  return readSale(asObj(res.body).sale);
}

async function openSale(stock: number, durationMs = 30 * 60_000): Promise<Sale> {
  const now = await serverNow();
  return createSale({
    stock,
    startsAt: new Date(now.getTime() - 5_000),
    endsAt: new Date(now.getTime() + durationMs),
  });
}

function readReservation(body: unknown): Reservation {
  const reservation = asObj(asObj(body).reservation);
  return {
    id: num(reservation.id, 'reservation.id'),
    saleId: num(reservation.saleId, 'reservation.saleId'),
    userId: num(reservation.userId, 'reservation.userId'),
    status: str(reservation.status, 'reservation.status'),
    expiresAt: str(reservation.expiresAt, 'reservation.expiresAt'),
  };
}

async function reserve(saleId: number, userId: number): Promise<ApiResult> {
  return api('POST', `/api/sales/${saleId}/reservations`, { userId });
}

async function expectReserve(saleId: number, userId: number): Promise<Reservation> {
  const res = await reserve(saleId, userId);
  if (res.status !== 201) throw new Error(`reserve sale ${saleId} user ${userId} returned ${explain(res)}`);
  return readReservation(res.body);
}

async function checkout(
  reservationId: number,
  userId: number,
  outcome: 'SUCCESS' | 'FAILED' | 'PENDING',
  idempotencyKey: string,
): Promise<ApiResult> {
  return api('POST', `/api/reservations/${reservationId}/checkout`, {
    userId,
    idempotencyKey,
    body: { outcome },
  });
}

function readPayment(body: unknown): { orderId: number; orderStatus: string; paymentId: number; paymentStatus: string } {
  const order = asObj(asObj(body).order);
  const payment = asObj(asObj(body).payment);
  return {
    orderId: num(order.id, 'order.id'),
    orderStatus: str(order.status, 'order.status'),
    paymentId: num(payment.id, 'payment.id'),
    paymentStatus: str(payment.status, 'payment.status'),
  };
}

async function resolve(paymentId: number, status: 'SUCCESS' | 'FAILED'): Promise<ApiResult> {
  return api('POST', `/api/payments/${paymentId}/resolve`, { body: { status } });
}

async function myCart(userId: number): Promise<{ reservation: Reservation | null; serverTime: string }> {
  const res = await api('GET', '/api/reservations/me', { userId });
  if (res.status !== 200) throw new Error(`GET /api/reservations/me returned ${explain(res)}`);
  const root = asObj(res.body);
  return {
    reservation: root.reservation === null ? null : readReservation(res.body),
    serverTime: str(root.serverTime, 'serverTime'),
  };
}

async function myOrders(userId: number): Promise<{ id: number; status: string; amountCents: number }[]> {
  const res = await api('GET', '/api/orders/me', { userId });
  if (res.status !== 200) throw new Error(`GET /api/orders/me returned ${explain(res)}`);
  const orders = asObj(res.body).orders;
  if (!Array.isArray(orders)) throw new Error('orders is not an array');
  return orders.map((order, index) => {
    const row = asObj(order);
    return {
      id: num(row.id, `orders[${index}].id`),
      status: str(row.status, `orders[${index}].status`),
      amountCents: num(row.amountCents, `orders[${index}].amountCents`),
    };
  });
}

async function waitFor(
  saleId: number,
  ready: (dashboard: Dashboard) => boolean,
  timeoutMs: number,
  label: string,
): Promise<Dashboard> {
  const started = Date.now();
  let last: Dashboard | undefined;
  while (Date.now() - started <= timeoutMs) {
    last = await getDashboard(saleId);
    if (ready(last)) return last;
    await sleep(200);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

async function run(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  console.log(`\n--- ${id} ${name}`);
  try {
    const evidence = await fn();
    results.push({ id, name, pass: true, evidence });
    console.log(`PASS  ${id} ${name}`);
    for (const line of evidence.split('\n')) console.log(`      ${line}`);
  } catch (err) {
    const evidence = err instanceof Error ? err.message : String(err);
    results.push({ id, name, pass: false, evidence });
    console.log(`FAIL  ${id} ${name}`);
    for (const line of evidence.split('\n')) console.log(`      ${line}`);
  }
}

async function ensureProduct(): Promise<void> {
  const health = await api('GET', '/health');
  if (health.status !== 200) {
    throw new Error(`GET /health returned ${health.status}. Start the stack with: docker compose up --build`);
  }
  const current = await api('GET', '/api/sales/current');
  if (current.status === 404 && errorCode(current.body) === 'SALE_NOT_FOUND') {
    throw new Error(
      'No sale exists yet, so a new sale cannot reuse a product (POST /api/dashboard/sales would return 404 PRODUCT_NOT_FOUND).\n' +
        'Seed once, then re-run npm run demo:\n' +
        '  docker compose exec backend npx tsx prisma/seed.ts',
    );
  }
  if (current.status !== 200) {
    throw new Error(`GET /api/sales/current returned ${explain(current)}`);
  }
}

async function holdExpiryNote(): Promise<string> {
  return [
    'Not waited out in this demo (no backend flag, no 10-minute sleep).',
    'Proven by backend/tests/saleTicker.test.ts',
    '"(d) expires exactly at createdAt + 10 min, not 1 ms earlier, and is idempotent".',
  ].join('\n');
}

async function beforeAndAfterStart(): Promise<string> {
  const user = await login('demo-early');
  const now = await serverNow();
  const startsAt = new Date(now.getTime() + 4_000);
  const sale = await createSale({
    stock: 2,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 10 * 60_000),
  });
  const before = await reserve(sale.id, user.id);
  assert(
    before.status === 409 && errorCode(before.body) === 'SALE_NOT_ACTIVE',
    `expected 409 SALE_NOT_ACTIVE before start, got ${explain(before)}`,
  );
  const opened = await waitFor(
    sale.id,
    (dashboard) => new Date(dashboard.serverTime).getTime() >= startsAt.getTime(),
    15_000,
    'serverTime reaching startsAt',
  );
  const after = await reserve(sale.id, user.id);
  assert(after.status === 201, `expected 201 right after start, got ${explain(after)}`);
  const reservation = readReservation(after.body);
  return [
    `sale ${sale.id} startsAt ${startsAt.toISOString()}`,
    `before start: ${explain(before)}`,
    `after serverTime ${opened.serverTime}: ${explain(after)} reservation ${reservation.id}`,
    `sale status when the reserve was accepted: ${opened.sale.status} (reserve uses the time window, not only ACTIVE)`,
  ].join('\n');
}

async function parallelBuyers(): Promise<string> {
  const sale = await openSale(5);
  const users = await Promise.all(Array.from({ length: 20 }, (_, index) => login(`demo-buyer-${index + 1}`)));
  const responses = await Promise.all(users.map((user) => reserve(sale.id, user.id)));
  const counts = tally(responses);
  const wins = responses.filter((res) => res.status === 201).map((res) => readReservation(res.body).id);
  assert(counts['201 OK'] === 5, `expected 5 x 201 OK, got ${formatCounts(counts)}`);
  assert(counts['409 SOLD_OUT'] === 15, `expected 15 x 409 SOLD_OUT, got ${formatCounts(counts)}`);
  const dashboard = await getDashboard(sale.id);
  return [
    `sale ${sale.id} stock 5`,
    formatCounts(counts),
    `reservation ids: ${wins.join(', ')}`,
    `dashboard available ${dashboard.availableStock} held ${dashboard.held} pending ${dashboard.pending} sold ${dashboard.sold}`,
  ].join('\n');
}

async function sameUserParallel(): Promise<string> {
  const sale = await openSale(10);
  const user = await login('demo-repeat');
  const responses = await Promise.all(Array.from({ length: 10 }, () => reserve(sale.id, user.id)));
  const counts = tally(responses);
  const ids = responses.filter((res) => res.status === 201).map((res) => readReservation(res.body).id);
  assert(counts['201 OK'] === 1, `expected 1 x 201 OK, got ${formatCounts(counts)}`);
  assert(counts['409 ALREADY_RESERVED'] === 9, `expected 9 x 409 ALREADY_RESERVED, got ${formatCounts(counts)}`);
  assert(new Set(ids).size === 1, `expected one reservation id, got ${ids.join(', ')}`);
  return [`sale ${sale.id} user ${user.id} (${user.username})`, formatCounts(counts), `reservation ${ids[0]}`].join('\n');
}

async function sameIdempotencyKey(): Promise<string> {
  const sale = await openSale(1);
  const user = await login('demo-idem');
  const reservation = await expectReserve(sale.id, user.id);
  const key = randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => checkout(reservation.id, user.id, 'SUCCESS', key)),
  );
  const counts = tally(responses);
  assert(counts['200 OK'] === 10, `expected 10 x 200 OK, got ${formatCounts(counts)}`);
  const payments = responses.map((res) => readPayment(res.body));
  const orderIds = new Set(payments.map((payment) => payment.orderId));
  const paymentIds = new Set(payments.map((payment) => payment.paymentId));
  assert(orderIds.size === 1, `expected 1 order, got ${[...orderIds].join(', ')}`);
  assert(paymentIds.size === 1, `expected 1 payment, got ${[...paymentIds].join(', ')}`);
  const orders = await myOrders(user.id);
  const forSale = orders.filter((order) => order.id === payments[0].orderId);
  assert(forSale.length === 1 && forSale[0].status === 'PAID', `orders/me: ${JSON.stringify(orders)}`);
  return [
    `sale ${sale.id} reservation ${reservation.id} key ${key}`,
    formatCounts(counts),
    `order ${payments[0].orderId} payment ${payments[0].paymentId} status ${payments[0].orderStatus}/${payments[0].paymentStatus}`,
  ].join('\n');
}

async function pendingHoldsUnit(): Promise<string> {
  const sale = await openSale(1);
  const holder = await login('demo-pending');
  const other = await login('demo-other');
  const reservation = await expectReserve(sale.id, holder.id);
  const hung = await checkout(reservation.id, holder.id, 'PENDING', randomUUID());
  assert(hung.status === 200, `PENDING checkout returned ${explain(hung)}`);
  const hungPayment = readPayment(hung.body);
  assert(hungPayment.orderStatus === 'PENDING' && hungPayment.paymentStatus === 'PENDING', JSON.stringify(hungPayment));
  const soldOut = await reserve(sale.id, other.id);
  assert(soldOut.status === 409 && errorCode(soldOut.body) === 'SOLD_OUT', `other buyer got ${explain(soldOut)}`);
  const held = await getDashboard(sale.id);
  assert(held.availableStock === 0 && held.pending === 1 && held.held === 0 && held.sold === 0, JSON.stringify(held));

  const resolved = await resolve(hungPayment.paymentId, 'SUCCESS');
  assert(resolved.status === 200, `resolve SUCCESS returned ${explain(resolved)}`);
  const paid = readPayment(resolved.body);
  assert(paid.orderId === hungPayment.orderId && paid.orderStatus === 'PAID' && paid.paymentStatus === 'SUCCESS', JSON.stringify(paid));
  const afterSuccess = await getDashboard(sale.id);
  const cart = await myCart(holder.id);
  assert(
    afterSuccess.sold === 1 && afterSuccess.pending === 0 && afterSuccess.availableStock === 0 && afterSuccess.held === 0,
    `after SUCCESS: available ${afterSuccess.availableStock} held ${afterSuccess.held} pending ${afterSuccess.pending} sold ${afterSuccess.sold}`,
  );
  assert(cart.reservation === null, `expected empty cart after SUCCESS, got ${JSON.stringify(cart.reservation)}`);

  const sale2 = await openSale(1);
  const holder2 = await login('demo-pending-fail');
  const reservation2 = await expectReserve(sale2.id, holder2.id);
  const hung2 = await checkout(reservation2.id, holder2.id, 'PENDING', randomUUID());
  const hung2Payment = readPayment(hung2.body);
  const beforeFail = await getDashboard(sale2.id);
  assert(beforeFail.availableStock === 0 && beforeFail.pending === 1, JSON.stringify(beforeFail));
  const wave = await Promise.all(Array.from({ length: 10 }, () => resolve(hung2Payment.paymentId, 'FAILED')));
  const waveCounts = tally(wave);
  assert(waveCounts['200 OK'] === 10, `parallel resolve FAILED: ${formatCounts(waveCounts)}`);
  const failed = wave.map((res) => readPayment(res.body));
  assert(new Set(failed.map((payment) => payment.orderId)).size === 1, 'parallel resolves returned more than one order');
  assert(failed.every((payment) => payment.orderStatus === 'FAILED'), JSON.stringify(failed[0]));
  const afterFail = await getDashboard(sale2.id);
  const repeated = await resolve(hung2Payment.paymentId, 'FAILED');
  const afterRepeat = await getDashboard(sale2.id);
  assert(afterFail.availableStock === 1 && afterRepeat.availableStock === 1, `stock after fail ${afterFail.availableStock}, after repeat ${afterRepeat.availableStock}`);
  assert(afterRepeat.pending === 0 && afterRepeat.held === 0 && afterRepeat.sold === 0, JSON.stringify(afterRepeat));

  return [
    `sale ${sale.id}: other buyer ${explain(soldOut)}; dashboard pending ${held.pending} available ${held.availableStock}`,
    `resolve SUCCESS order ${paid.orderId} payment ${paid.paymentId} -> ${paid.orderStatus}/${paid.paymentStatus}; sold ${afterSuccess.sold}; cart empty`,
    'GET /api/reservations/me does not return COMPLETED. sold=1 is the dashboard evidence; reservation COMPLETED is proven by backend/tests/realtime.test.ts "resolve SUCCESS emits order:updated PAID and reservation:updated COMPLETED, no sale:stock".',
    `sale ${sale2.id}: 10 parallel resolve FAILED ${formatCounts(waveCounts)}; order ${failed[0].orderId}; available ${beforeFail.availableStock} -> ${afterFail.availableStock}, still ${afterRepeat.availableStock} after one more resolve`,
  ].join('\n');
}

async function dashboardInvariant(): Promise<string> {
  const sale = await openSale(4);
  const paidUser = await login('demo-paid');
  const pendingUser = await login('demo-dash-pending');
  const heldUser = await login('demo-held');
  const failedUser = await login('demo-failed');

  const paidReservation = await expectReserve(sale.id, paidUser.id);
  const paidCheckout = await checkout(paidReservation.id, paidUser.id, 'SUCCESS', randomUUID());
  assert(paidCheckout.status === 200, explain(paidCheckout));
  const paid = readPayment(paidCheckout.body);

  const pendingReservation = await expectReserve(sale.id, pendingUser.id);
  const pendingCheckout = await checkout(pendingReservation.id, pendingUser.id, 'PENDING', randomUUID());
  assert(pendingCheckout.status === 200, explain(pendingCheckout));

  await expectReserve(sale.id, heldUser.id);

  const failedReservation = await expectReserve(sale.id, failedUser.id);
  const failedCheckout = await checkout(failedReservation.id, failedUser.id, 'FAILED', randomUUID());
  assert(failedCheckout.status === 200, explain(failedCheckout));
  assert(readPayment(failedCheckout.body).orderStatus === 'FAILED', 'expected FAILED order');

  const dashboard = await getDashboard(sale.id);
  const sum = dashboard.availableStock + dashboard.held + dashboard.pending + dashboard.sold;
  const paidFromOrders = dashboard.recentOrders
    .filter((order) => order.status === 'PAID')
    .reduce((total, order) => total + order.amountCents, 0);
  // orders/me is the user's whole history, so only the order created on this sale counts.
  const thisPaid = (await myOrders(paidUser.id)).filter((order) => order.id === paid.orderId);
  assert(thisPaid.length === 1 && thisPaid[0].status === 'PAID', `orders/me missing order ${paid.orderId}`);
  assert(sum === dashboard.sale.totalStock, `available+held+pending+sold ${sum} != total ${dashboard.sale.totalStock}`);
  assert(dashboard.revenueCents === paidFromOrders, `revenueCents ${dashboard.revenueCents} != recentOrders PAID sum ${paidFromOrders}`);
  assert(dashboard.revenueCents === thisPaid[0].amountCents, `revenueCents ${dashboard.revenueCents} != order ${paid.orderId} amount ${thisPaid[0].amountCents}`);
  assert(dashboard.revenueCents === PRICE_CENTS, `expected revenue ${PRICE_CENTS}, got ${dashboard.revenueCents} (FAILED must not count)`);

  return [
    `sale ${sale.id} total ${dashboard.sale.totalStock}`,
    `available ${dashboard.availableStock} + held ${dashboard.held} + pending ${dashboard.pending} + sold ${dashboard.sold} = ${sum}`,
    `revenueCents ${dashboard.revenueCents}; PAID recentOrders ${paidFromOrders}; order ${paid.orderId} amount ${thisPaid[0].amountCents}`,
    `recentOrders: ${dashboard.recentOrders.map((order) => `#${order.id} ${order.username} ${order.status} ${order.amountCents}`).join('; ')}`,
  ].join('\n');
}

type LiveClient = { socket: Socket; events: [string, unknown][] };

async function connectClient(): Promise<LiveClient> {
  const socket = io(BASE_URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  const events: [string, unknown][] = [];
  socket.onAny((event: string, payload: unknown) => events.push([event, payload]));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 5_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return { socket, events };
}

async function twoSockets(): Promise<string> {
  const sale = await openSale(3);
  const user = await login('demo-socket');
  const clients = await Promise.all([connectClient(), connectClient()]);
  try {
    for (const client of clients) {
      const ack = await client.socket.timeout(2_000).emitWithAck('sale:join', { saleId: sale.id });
      assert(JSON.stringify(ack) === JSON.stringify({ ok: true }), `sale:join ack ${JSON.stringify(ack)}`);
    }
    for (const client of clients) client.events.length = 0;
    const reservation = await expectReserve(sale.id, user.id);
    await Promise.all(clients.map((client) => client.socket.timeout(2_000).emitWithAck('sale:join', {})));
    const stocks = clients.map((client) =>
      client.events.filter(([event, payload]) => {
        if (event !== 'sale:stock') return false;
        const body = asObj(payload);
        return body.saleId === sale.id && body.availableStock === sale.totalStock - 1;
      }),
    );
    assert(stocks[0].length >= 1 && stocks[1].length >= 1, `sale:stock counts ${stocks[0].length} and ${stocks[1].length}; events ${JSON.stringify(clients.map((c) => c.events))}`);
    return [
      `sale ${sale.id} reservation ${reservation.id}`,
      `client A events: ${JSON.stringify(clients[0].events)}`,
      `client B events: ${JSON.stringify(clients[1].events)}`,
    ].join('\n');
  } finally {
    for (const client of clients) client.socket.disconnect();
  }
}

async function oneOrderEmail(): Promise<string> {
  const sale = await openSale(1);
  const user = await login('demo-mail');
  const reservation = await expectReserve(sale.id, user.id);
  const paid = await checkout(reservation.id, user.id, 'SUCCESS', randomUUID());
  assert(paid.status === 200, explain(paid));
  const payment = readPayment(paid.body);
  const sent = await waitFor(sale.id, (dashboard) => dashboard.outbox.sent === 1 && dashboard.outbox.pending === 0, 20_000, 'ORDER_PAID dispatch');
  await sleep(1_500);
  const again = await getDashboard(sale.id);
  assert(again.outbox.sent === 1 && again.outbox.failed === 0, `outbox changed after the extra wait: ${JSON.stringify(again.outbox)}`);
  return [
    `sale ${sale.id} order ${payment.orderId}`,
    `outbox pending ${sent.outbox.pending} sent ${sent.outbox.sent} failed ${sent.outbox.failed}; still sent ${again.outbox.sent} after 1.5s`,
    'The dashboard counter does not include the email type. Exactly one ORDER_PAID row is proven by backend/tests/emails.test.ts "(a) sends one ORDER_PAID email..." and "(d) parallel SUCCESS checkouts with the same and different keys send one order email".',
  ].join('\n');
}

async function shortSaleEnd(): Promise<string> {
  const activeOwner = await login('demo-end-active');
  const pendingOwner = await login('demo-end-pending');
  const now = await serverNow();
  const endsAt = new Date(now.getTime() + 10_000);
  const sale = await createSale({
    stock: 2,
    startsAt: new Date(now.getTime() - 5_000),
    endsAt,
  });
  const active = await expectReserve(sale.id, activeOwner.id);
  const pendingReservation = await expectReserve(sale.id, pendingOwner.id);
  const hung = await checkout(pendingReservation.id, pendingOwner.id, 'PENDING', randomUUID());
  assert(hung.status === 200, explain(hung));
  const ended = await waitFor(
    sale.id,
    (dashboard) => dashboard.sale.status === 'ENDED' && dashboard.outbox.sent === 1 && dashboard.outbox.pending === 0,
    20_000,
    'sale end and one sent email',
  );
  const activeCart = await myCart(activeOwner.id);
  const pendingCart = await myCart(pendingOwner.id);
  assert(activeCart.reservation === null, `ACTIVE cart was not cleared: ${JSON.stringify(activeCart.reservation)}`);
  assert(
    pendingCart.reservation?.id === pendingReservation.id && pendingCart.reservation.status === 'PAYMENT_PENDING',
    `PENDING cart: ${JSON.stringify(pendingCart.reservation)}`,
  );
  assert(ended.outbox.sent === 1, `expected exactly 1 sent email, got ${ended.outbox.sent}`);
  assert(ended.unsold === ended.availableStock, `unsold ${ended.unsold} != available ${ended.availableStock}`);
  return [
    `sale ${sale.id} endsAt ${endsAt.toISOString()} status ${ended.sale.status}`,
    `cleared reservation ${active.id}: GET /api/reservations/me is null`,
    `PENDING reservation ${pendingReservation.id} still ${pendingCart.reservation?.status}`,
    `outbox pending ${ended.outbox.pending} sent ${ended.outbox.sent} failed ${ended.outbox.failed}`,
    `available ${ended.availableStock} held ${ended.held} pending ${ended.pending} sold ${ended.sold} unsold ${ended.unsold}`,
    'Recipient and type are not in the dashboard API. One SALE_ENDED_CART_CLEARED per ACTIVE cart and none for the PENDING owner are proven by backend/tests/emails.test.ts "(e) 2 parallel endSales and 2 parallel dispatches send one cart-cleared email per ACTIVE cart, none to the PENDING owner".',
  ].join('\n');
}

function printSummary(): void {
  console.log('\n======== summary ========');
  const width = Math.max(...results.map((result) => result.name.length), 10);
  for (const result of results) {
    console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.id.padEnd(2)}  ${result.name.padEnd(width)}`);
  }
  const failed = results.filter((result) => !result.pass).length;
  console.log(`${results.length - failed} passed, ${failed} failed`);
}

async function main(): Promise<void> {
  console.log(`Flash Sale demo  BASE_URL=${BASE_URL}`);
  await ensureProduct();
  await run('0', 'hold expiry (10 min) — cited test, not waited', holdExpiryNote);
  await run('1', 'before start rejected, right after start accepted', beforeAndAfterStart);
  await run('2', '20 parallel buyers, stock 5', parallelBuyers);
  await run('3', 'same user, parallel reserve', sameUserParallel);
  await run('4', '10 parallel pays, one Idempotency-Key', sameIdempotencyKey);
  await run('5', 'PENDING holds the unit; resolve SUCCESS and FAILED', pendingHoldsUnit);
  await run('6', 'dashboard invariant and PAID revenue', dashboardInvariant);
  await run('7', 'two socket clients receive sale:stock', twoSockets);
  await run('8', 'exactly one sent email after ORDER_PAID', oneOrderEmail);
  await run('9', 'short sale end clears the unpaid cart once', shortSaleEnd);
  printSummary();
  if (results.some((result) => !result.pass)) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
