import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { resetDb } from './helpers/db';
import { createSale, createUsers } from './helpers/factories';
import { type CheckoutOutcome, checkoutRequest, myOrdersRequest, outcome, reserveRequest } from './helpers/http';
import { assertStockInvariant } from './helpers/invariant';
import { close, listen } from './helpers/server';

const NOW = new Date('2026-01-01T12:00:00Z');
const MINUTE = 60_000;
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
});

async function reserveFor(saleId: number, userId: number): Promise<number> {
  const res = await reserveRequest(server, saleId, userId);
  expect(outcome(res)).toBe('201 OK');
  return res.body.reservation.id;
}

const paymentIds = new Map<number, number>();

// Returns the order id and remembers the id of the order's latest payment.
async function pay(reservationId: number, userId: number, result: CheckoutOutcome) {
  const res = await checkoutRequest(server, reservationId, userId, result);
  expect(outcome(res)).toBe('200 OK');
  paymentIds.set(res.body.order.id, res.body.payment.id);
  return res.body.order.id as number;
}

describe('GET /api/orders/me', () => {
  it("(l) lists only the user's own orders, newest first, with order and latest payment status and id", async () => {
    const sales = [];
    for (const priceCents of [1000, 2000, 3000, 4000]) {
      sales.push(await createSale({ totalStock: 3, priceCents, ...openWindow }));
    }
    const [buyer, other, empty] = await createUsers(3);

    clock = NOW;
    const paidId = await pay(await reserveFor(sales[0].id, buyer.id), buyer.id, 'SUCCESS');
    const otherId = await pay(await reserveFor(sales[0].id, other.id), other.id, 'SUCCESS');

    clock = at(MINUTE);
    const pendingId = await pay(await reserveFor(sales[1].id, buyer.id), buyer.id, 'PENDING');

    clock = at(2 * MINUTE);
    const retried = await reserveFor(sales[2].id, buyer.id);
    const retriedId = await pay(retried, buyer.id, 'FAILED');
    const failedAttemptId = paymentIds.get(retriedId);
    clock = at(3 * MINUTE);
    expect(await pay(retried, buyer.id, 'SUCCESS')).toBe(retriedId);

    clock = at(4 * MINUTE);
    const failedId = await pay(await reserveFor(sales[3].id, buyer.id), buyer.id, 'FAILED');

    const res = await myOrdersRequest(server, buyer.id);

    expect(outcome(res)).toBe('200 OK');
    expect(
      res.body.orders.map((o: Record<string, unknown>) => [o.id, o.saleId, o.amountCents, o.status, o.paymentStatus]),
    ).toEqual([
      [failedId, sales[3].id, 4000, 'FAILED', 'FAILED'],
      [retriedId, sales[2].id, 3000, 'PAID', 'SUCCESS'],
      [pendingId, sales[1].id, 2000, 'PENDING', 'PENDING'],
      [paidId, sales[0].id, 1000, 'PAID', 'SUCCESS'],
    ]);
    expect(res.body.orders.map((o: { id: number; paymentId: number }) => [o.id, o.paymentId])).toEqual(
      [failedId, retriedId, pendingId, paidId].map((id) => [id, paymentIds.get(id)]),
    );
    const retriedOrder = res.body.orders.find((o: { id: number }) => o.id === retriedId);
    expect(retriedOrder.paymentId).not.toBe(failedAttemptId);
    expect(res.body.orders[0]).toMatchObject({
      reservationId: expect.any(Number),
      createdAt: at(4 * MINUTE).toISOString(),
    });

    const otherRes = await myOrdersRequest(server, other.id);
    expect(otherRes.body.orders.map((o: { id: number }) => o.id)).toEqual([otherId]);

    const emptyRes = await myOrdersRequest(server, empty.id);
    expect(emptyRes.body).toEqual({ orders: [] });

    for (const sale of sales) await assertStockInvariant(sale.id);
  });

  it('requires X-User-Id', async () => {
    const res = await myOrdersRequest(server, 999_999);

    expect(outcome(res)).toBe('401 UNAUTHORIZED');
  });
});
