import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { endSales, runTick } from '../src/jobs/saleTicker';
import { dispatchEmails } from '../src/modules/emails/dispatcher';
import { mockMailer, resetSent, sent } from '../src/modules/emails/mockMailer';
import { resetDb } from './helpers/db';
import { createReservation, createSale, createUser, createUsers } from './helpers/factories';
import { failCommitsOn } from './helpers/failOnCommit';
import { checkoutRequest, countBy, outcome, reserveRequest, resolveRequest } from './helpers/http';
import { assertStockInvariant } from './helpers/invariant';
import { close, listen } from './helpers/server';

const NOW = new Date('2026-01-01T12:00:00Z');
const MINUTE = 60_000;
const HOLD_MS = 10 * MINUTE;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const openWindow = { startsAt: at(-30 * MINUTE), endsAt: at(30 * MINUTE) };

let clock = NOW;
let server: Server;

beforeAll(async () => {
  server = await listen(createApp({ now: () => clock }));
});

afterAll(async () => {
  await close(server);
  await prisma.$disconnect();
});

beforeEach(async () => {
  clock = NOW;
  await resetDb();
  resetSent();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function reserveFor(saleId: number, userId: number): Promise<number> {
  const res = await reserveRequest(server, saleId, userId);
  expect(outcome(res)).toBe('201 OK');
  return res.body.reservation.id;
}

// Reserves and pays, which inserts one ORDER_PAID outbox row; returns the order id.
async function buy(saleId: number, userId: number): Promise<number> {
  const res = await checkoutRequest(server, await reserveFor(saleId, userId), userId, 'SUCCESS');
  expect(outcome(res)).toBe('200 OK');
  return res.body.order.id;
}

const outboxRows = () => prisma.emailOutbox.findMany({ orderBy: { id: 'asc' } });

describe('dispatchEmails', () => {
  it('(a) sends one ORDER_PAID email, marks the row SENT with sentAt; a second call sends nothing', async () => {
    const sale = await createSale({ totalStock: 3, priceCents: 4999, ...openWindow });
    const user = await createUser();
    const orderId = await buy(sale.id, user.id);
    const [row] = await outboxRows();

    const first = await dispatchEmails(at(MINUTE));

    expect(first).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ outboxId: row.id, type: 'ORDER_PAID', to: user.email });
    expect(sent[0].subject).toContain(`#${orderId}`);
    expect(sent[0].body).toContain('$49.99');
    expect(await outboxRows()).toMatchObject([{ id: row.id, status: 'SENT', attempts: 1, sentAt: at(MINUTE) }]);

    const second = await dispatchEmails(at(2 * MINUTE));

    expect(second).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(await outboxRows()).toMatchObject([{ status: 'SENT', attempts: 1, sentAt: at(MINUTE) }]);
  });

  it('(b) 5 parallel calls with 3 pending rows send exactly 3 emails, each once', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const users = await createUsers(3);
    for (const user of users) await buy(sale.id, user.id);
    const rows = await outboxRows();
    expect(rows).toHaveLength(3);

    const results = await Promise.all(Array.from({ length: 5 }, () => dispatchEmails(at(MINUTE))));

    expect(results.reduce((sum, r) => sum + r.sent, 0)).toBe(3);
    expect(sent).toHaveLength(3);
    expect(countBy(sent, (m) => String(m.outboxId))).toEqual(Object.fromEntries(rows.map((r) => [r.id, 1])));
    expect(sent.map((m) => m.to).sort()).toEqual(users.map((u) => u.email).sort());
    expect((await outboxRows()).map((r) => [r.status, r.attempts])).toEqual([
      ['SENT', 1],
      ['SENT', 1],
      ['SENT', 1],
    ]);
  });

  it('(c) a throwing mailer puts the row back to PENDING with lastError; after 3 attempts it is FAILED and not retried', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    await buy(sale.id, user.id);
    const send = vi.spyOn(mockMailer, 'send').mockRejectedValue(new Error('SMTP down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await dispatchEmails(at(MINUTE))).toEqual({ sent: 0, retried: 1, failed: 0 });
    expect(await outboxRows()).toMatchObject([{ status: 'PENDING', attempts: 1, sentAt: null }]);
    expect((await outboxRows())[0].lastError).toContain('SMTP down');

    expect(await dispatchEmails(at(2 * MINUTE))).toEqual({ sent: 0, retried: 1, failed: 0 });
    expect(await outboxRows()).toMatchObject([{ status: 'PENDING', attempts: 2 }]);

    expect(await dispatchEmails(at(3 * MINUTE))).toEqual({ sent: 0, retried: 0, failed: 1 });
    expect(await outboxRows()).toMatchObject([{ status: 'FAILED', attempts: 3, sentAt: null }]);
    expect(send).toHaveBeenCalledTimes(3);

    expect(await dispatchEmails(at(4 * MINUTE))).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(send).toHaveBeenCalledTimes(3);

    send.mockRestore();
    expect(await dispatchEmails(at(5 * MINUTE))).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(sent).toEqual([]);
    expect(await outboxRows()).toMatchObject([{ status: 'FAILED', attempts: 3, lastError: expect.stringContaining('SMTP down') }]);
  });

  it('a mailer that recovers after one failure sends the email on the next call', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    await buy(sale.id, user.id);
    vi.spyOn(mockMailer, 'send').mockRejectedValueOnce(new Error('timeout'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await dispatchEmails(at(MINUTE));
    expect(await dispatchEmails(at(2 * MINUTE))).toEqual({ sent: 1, retried: 0, failed: 0 });

    expect(sent).toHaveLength(1);
    expect(await outboxRows()).toMatchObject([{ status: 'SENT', attempts: 2, sentAt: at(2 * MINUTE) }]);
  });
});

describe('exactly one email, end to end', () => {
  it('(d) parallel checkouts (same and different keys), double resolve and 2 parallel dispatches send one order email', async () => {
    const sale = await createSale({ totalStock: 3, priceCents: 2500, ...openWindow });
    const user = await createUser();
    const reservationId = await reserveFor(sale.id, user.id);
    const key = randomUUID();

    const checkouts = await Promise.all([
      ...Array.from({ length: 5 }, () => checkoutRequest(server, reservationId, user.id, 'PENDING', key)),
      ...Array.from({ length: 5 }, () => checkoutRequest(server, reservationId, user.id, 'PENDING')),
    ]);
    expect(checkouts.map(outcome)).toEqual(Array(10).fill('200 OK'));
    const orderIds = new Set(checkouts.map((r) => r.body.order.id));
    expect(orderIds.size).toBe(1);
    const paymentId = checkouts[0].body.payment.id;

    const resolves = await Promise.all([
      resolveRequest(server, paymentId, 'SUCCESS'),
      resolveRequest(server, paymentId, 'SUCCESS'),
    ]);
    expect(resolves.map(outcome)).toEqual(['200 OK', '200 OK']);
    const replays = await Promise.all([
      checkoutRequest(server, reservationId, user.id, 'SUCCESS', key),
      checkoutRequest(server, reservationId, user.id, 'SUCCESS'),
    ]);
    expect(replays.map(outcome)).toEqual(['200 OK', '200 OK']);

    await Promise.all([dispatchEmails(at(MINUTE)), dispatchEmails(at(MINUTE))]);

    const [orderId] = orderIds;
    expect(await prisma.payment.count()).toBe(1);
    expect(await outboxRows()).toMatchObject([{ type: 'ORDER_PAID', orderId, status: 'SENT', attempts: 1 }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'ORDER_PAID', to: user.email });
    expect(sent[0].body).toContain(`#${orderId}`);
    expect(sent[0].body).toContain('$25.00');
    await assertStockInvariant(sale.id);
  });

  it('(d) parallel SUCCESS checkouts with the same and different keys send one order email', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reservationId = await reserveFor(sale.id, user.id);
    const key = randomUUID();

    const checkouts = await Promise.all([
      ...Array.from({ length: 5 }, () => checkoutRequest(server, reservationId, user.id, 'SUCCESS', key)),
      ...Array.from({ length: 5 }, () => checkoutRequest(server, reservationId, user.id, 'SUCCESS')),
    ]);
    expect(checkouts.map(outcome)).toEqual(Array(10).fill('200 OK'));

    await Promise.all([dispatchEmails(at(MINUTE)), dispatchEmails(at(MINUTE))]);

    expect(await outboxRows()).toMatchObject([{ type: 'ORDER_PAID', status: 'SENT' }]);
    expect(sent.map((m) => [m.type, m.to])).toEqual([['ORDER_PAID', user.email]]);
    await assertStockInvariant(sale.id);
  });

  it('(e) 2 parallel endSales and 2 parallel dispatches send one cart-cleared email per ACTIVE cart, none to the PENDING owner', async () => {
    const sale = await createSale({ totalStock: 5, ...openWindow });
    const [a, b, pendingOwner] = await createUsers(3);
    await reserveFor(sale.id, a.id);
    await reserveFor(sale.id, b.id);
    const pending = await checkoutRequest(server, await reserveFor(sale.id, pendingOwner.id), pendingOwner.id, 'PENDING');
    expect(outcome(pending)).toBe('200 OK');

    await Promise.all([endSales(openWindow.endsAt), endSales(openWindow.endsAt)]);
    await Promise.all([dispatchEmails(openWindow.endsAt), dispatchEmails(openWindow.endsAt)]);

    const cleared = sent.filter((m) => m.type === 'SALE_ENDED_CART_CLEARED');
    expect(cleared).toHaveLength(2);
    expect(sent).toHaveLength(2);
    expect(cleared.map((m) => m.to).sort()).toEqual([a.email, b.email].sort());
    expect(sent.some((m) => m.to === pendingOwner.email)).toBe(false);
    expect((await outboxRows()).map((r) => [r.type, r.status])).toEqual([
      ['SALE_ENDED_CART_CLEARED', 'SENT'],
      ['SALE_ENDED_CART_CLEARED', 'SENT'],
    ]);
    await assertStockInvariant(sale.id);
  });

  it('(f) a rolled back checkout leaves no outbox row and sends no email', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reservationId = await reserveFor(sale.id, user.id);

    const restore = await failCommitsOn('Payment');
    try {
      expect(outcome(await checkoutRequest(server, reservationId, user.id, 'SUCCESS'))).toBe('500 INTERNAL_ERROR');
    } finally {
      await restore();
    }
    await dispatchEmails(at(MINUTE));

    expect(await prisma.emailOutbox.count()).toBe(0);
    expect(sent).toEqual([]);
    expect(await prisma.order.count()).toBe(0);
    await assertStockInvariant(sale.id);
  });
});

describe('runTick with email dispatch', () => {
  it('(k) a failing dispatchEmails does not block start, end and expire', async () => {
    const tickAt = at(HOLD_MS);
    const toStart = await createSale({ totalStock: 2, startsAt: tickAt, endsAt: at(HOLD_MS + MINUTE), status: 'SCHEDULED' });
    const toEnd = await createSale({ totalStock: 2, startsAt: at(-MINUTE), endsAt: tickAt });
    const open = await createSale({ totalStock: 2, ...openWindow });
    const user = await createUser();
    const due = await createReservation({ saleId: open.id, userId: user.id, status: 'ACTIVE', expiresAt: tickAt });
    await prisma.emailOutbox.create({
      data: { type: 'ORDER_PAID', userId: user.id, toEmail: user.email, payload: { saleId: open.id } },
    });

    const failure = new Error('outbox exploded');
    const realFindMany = prisma.emailOutbox.findMany.bind(prisma.emailOutbox);
    vi.spyOn(prisma.emailOutbox, 'findMany')
      .mockImplementation(realFindMany as never)
      .mockRejectedValueOnce(failure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runTick(tickAt)).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('dispatchEmails'), failure);
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: toStart.id } })).status).toBe('ACTIVE');
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: toEnd.id } })).status).toBe('ENDED');
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: due.id } })).status).toBe('EXPIRED');
    expect(sent).toEqual([]);
    expect((await outboxRows()).map((r) => r.status)).toEqual(['PENDING']);
    for (const sale of [toStart, toEnd, open]) await assertStockInvariant(sale.id);
  });

  it('(k) a failing earlier step does not block dispatchEmails', async () => {
    const user = await createUser();
    await prisma.emailOutbox.create({
      data: { type: 'ORDER_PAID', userId: user.id, toEmail: user.email, payload: { orderId: 1, amountCents: 100 } },
    });
    const realFindMany = prisma.sale.findMany.bind(prisma.sale);
    vi.spyOn(prisma.sale, 'findMany')
      .mockImplementation(realFindMany as never)
      .mockRejectedValueOnce(new Error('startSales exploded'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runTick(NOW);

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('startSales'), expect.any(Error));
    expect(sent.map((m) => m.to)).toEqual([user.email]);
    expect((await outboxRows()).map((r) => r.status)).toEqual(['SENT']);
  });
});
