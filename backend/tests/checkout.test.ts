import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { endSales, expireReservations } from '../src/jobs/saleTicker';
import { resetDb } from './helpers/db';
import { createSale, createUser, createUsers } from './helpers/factories';
import {
  cancelRequest,
  checkoutRequest,
  countBy,
  currentCartRequest,
  outcome,
  reserveRequest,
  resolveRequest,
} from './helpers/http';
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
});

async function reserveFor(saleId: number, userId: number): Promise<number> {
  const res = await reserveRequest(server, saleId, userId);
  expect(outcome(res)).toBe('201 OK');
  return res.body.reservation.id;
}

async function getSale(id: number) {
  return prisma.sale.findUniqueOrThrow({ where: { id } });
}

async function getReservation(id: number) {
  return prisma.reservation.findUniqueOrThrow({ where: { id } });
}

describe('POST /api/reservations/:id/checkout', () => {
  it('(a) SUCCESS: Order PAID with the sale price, Reservation COMPLETED, exactly one ORDER_PAID outbox row', async () => {
    const sale = await createSale({ totalStock: 3, priceCents: 2599, ...openWindow });
    const user = await createUser();
    const reservationId = await reserveFor(sale.id, user.id);
    const key = randomUUID();

    const res = await checkoutRequest(server, reservationId, user.id, 'SUCCESS', key).send({
      outcome: 'SUCCESS',
      amountCents: 1,
    });

    expect(outcome(res)).toBe('200 OK');
    expect(res.body.order).toMatchObject({
      reservationId,
      saleId: sale.id,
      userId: user.id,
      amountCents: 2599,
      status: 'PAID',
    });
    expect(res.body.payment).toMatchObject({ orderId: res.body.order.id, status: 'SUCCESS', idempotencyKey: key });

    expect((await getReservation(reservationId)).status).toBe('COMPLETED');
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
    const outbox = await prisma.emailOutbox.findMany();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      type: 'ORDER_PAID',
      orderId: res.body.order.id,
      userId: user.id,
      toEmail: user.email,
      status: 'PENDING',
    });
    expect((await getSale(sale.id)).availableStock).toBe(2);
    expect((await currentCartRequest(server, user.id)).body.reservation).toBeNull();
    await assertStockInvariant(sale.id);
  });

  it('(b) 10 parallel checkouts with the SAME key: one Order, one Payment, identical bodies', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reservationId = await reserveFor(sale.id, user.id);
    const key = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => checkoutRequest(server, reservationId, user.id, 'SUCCESS', key)),
    );

    expect(countBy(responses, outcome)).toEqual({ '200 OK': 10 });
    for (const res of responses) expect(res.body).toEqual(responses[0].body);
    expect(responses[0].body.order.status).toBe('PAID');
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.emailOutbox.count({ where: { type: 'ORDER_PAID' } })).toBe(1);
    await assertStockInvariant(sale.id);

    const freshKey = await checkoutRequest(server, reservationId, user.id, 'SUCCESS');
    expect(outcome(freshKey)).toBe('200 OK');
    expect(freshKey.body).toEqual(responses[0].body);
    expect(await prisma.payment.count()).toBe(1);
    await assertStockInvariant(sale.id);
  });

  it('(c) 10 parallel checkouts with DIFFERENT keys: one paid Order, one SUCCESS Payment, no 500', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reservationId = await reserveFor(sale.id, user.id);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => checkoutRequest(server, reservationId, user.id, 'SUCCESS')),
    );

    expect(countBy(responses, outcome)).toEqual({ '200 OK': 10 });
    const orderIds = new Set(responses.map((res) => res.body.order.id));
    expect(orderIds.size).toBe(1);
    for (const res of responses) expect(res.body.order.status).toBe('PAID');
    const orders = await prisma.order.findMany();
    expect(orders.map((o) => o.status)).toEqual(['PAID']);
    const payments = await prisma.payment.findMany();
    expect(payments.map((p) => p.status)).toEqual(['SUCCESS']);
    expect(await prisma.emailOutbox.count({ where: { type: 'ORDER_PAID' } })).toBe(1);
    expect((await getReservation(reservationId)).status).toBe('COMPLETED');
    await assertStockInvariant(sale.id);
  });

  it('(d) the same key on another reservation or by another user returns 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const saleA = await createSale({ totalStock: 3, ...openWindow });
    const saleB = await createSale({ totalStock: 3, ...openWindow });
    const [owner, stranger] = await createUsers(2);
    const key = randomUUID();
    const first = await reserveFor(saleA.id, owner.id);
    const paid = await checkoutRequest(server, first, owner.id, 'SUCCESS', key);
    expect(outcome(paid)).toBe('200 OK');

    const ownerSecond = await reserveFor(saleB.id, owner.id);
    const strangerRes = await reserveFor(saleA.id, stranger.id);

    expect(outcome(await checkoutRequest(server, ownerSecond, owner.id, 'SUCCESS', key))).toBe(
      '409 IDEMPOTENCY_KEY_REUSED',
    );
    expect(outcome(await checkoutRequest(server, strangerRes, stranger.id, 'SUCCESS', key))).toBe(
      '409 IDEMPOTENCY_KEY_REUSED',
    );

    const replay = await checkoutRequest(server, first, owner.id, 'SUCCESS', key);
    expect(outcome(replay)).toBe('200 OK');
    expect(replay.body).toEqual(paid.body);

    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
    expect((await getReservation(ownerSecond)).status).toBe('ACTIVE');
    expect((await getReservation(strangerRes)).status).toBe('ACTIVE');
    await assertStockInvariant(saleA.id);
    await assertStockInvariant(saleB.id);
  });

  it('(e) checkout of an expired reservation before the ticker ran: 409 RESERVATION_EXPIRED, stock unchanged', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reservationId = await reserveFor(sale.id, user.id);

    clock = at(HOLD_MS - 1);
    const stillValid = await checkoutRequest(server, reservationId, user.id, 'FAILED');
    expect(outcome(stillValid)).toBe('200 OK');

    clock = at(HOLD_MS);
    const res = await checkoutRequest(server, reservationId, user.id, 'SUCCESS');

    expect(outcome(res)).toBe('409 RESERVATION_EXPIRED');
    expect((await getReservation(reservationId)).status).toBe('ACTIVE');
    expect((await getSale(sale.id)).availableStock).toBe(2);
    expect(await prisma.payment.count({ where: { status: 'SUCCESS' } })).toBe(0);
    expect(await prisma.emailOutbox.count()).toBe(0);
    await assertStockInvariant(sale.id);
  });

  it('(e) checkout after the sale end time returns 409 SALE_NOT_ACTIVE, even before the ticker ran', async () => {
    const sale = await createSale({ totalStock: 3, startsAt: at(-30 * MINUTE), endsAt: at(5 * MINUTE) });
    const user = await createUser();
    const reservationId = await reserveFor(sale.id, user.id);

    clock = at(5 * MINUTE);
    const res = await checkoutRequest(server, reservationId, user.id, 'SUCCESS');

    expect(outcome(res)).toBe('409 SALE_NOT_ACTIVE');
    expect((await getReservation(reservationId)).status).toBe('ACTIVE');
    expect((await getSale(sale.id)).availableStock).toBe(2);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    await assertStockInvariant(sale.id);

    await endSales(at(5 * MINUTE));
    const afterEnd = await checkoutRequest(server, reservationId, user.id, 'SUCCESS');
    expect(outcome(afterEnd)).toBe('409 RESERVATION_NOT_ACTIVE');
    await assertStockInvariant(sale.id);
  });

  it('(f) PENDING holds the unit; expiry, sale end and cancel do not touch it; a new key returns the same order', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reservationId = await reserveFor(sale.id, user.id);

    const res = await checkoutRequest(server, reservationId, user.id, 'PENDING');

    expect(outcome(res)).toBe('200 OK');
    expect(res.body.order.status).toBe('PENDING');
    expect(res.body.payment.status).toBe('PENDING');
    expect((await getReservation(reservationId)).status).toBe('PAYMENT_PENDING');
    expect((await getSale(sale.id)).availableStock).toBe(2);
    await assertStockInvariant(sale.id);

    const again = await checkoutRequest(server, reservationId, user.id, 'SUCCESS');
    expect(outcome(again)).toBe('200 OK');
    expect(again.body.order).toEqual(res.body.order);
    expect(again.body.payment).toEqual(res.body.payment);
    expect(await prisma.payment.count()).toBe(1);

    await expireReservations(at(60 * MINUTE));
    expect((await getReservation(reservationId)).status).toBe('PAYMENT_PENDING');
    expect((await getSale(sale.id)).availableStock).toBe(2);
    await assertStockInvariant(sale.id);

    await endSales(new Date(sale.endsAt.getTime() + 1));
    expect((await getReservation(reservationId)).status).toBe('PAYMENT_PENDING');
    const ended = await getSale(sale.id);
    expect(ended.status).toBe('ENDED');
    expect(ended.availableStock).toBe(2);
    expect(await prisma.emailOutbox.count()).toBe(0);
    await assertStockInvariant(sale.id);

    expect(outcome(await cancelRequest(server, reservationId, user.id))).toBe('409 RESERVATION_NOT_ACTIVE');
    expect((await getReservation(reservationId)).status).toBe('PAYMENT_PENDING');
    expect((await getSale(sale.id)).availableStock).toBe(2);
    await assertStockInvariant(sale.id);
  });

  it('(i) FAILED, then a retry with a new key and SUCCESS: one Order PAID, two Payments', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reservationId = await reserveFor(sale.id, user.id);
    const failedKey = randomUUID();

    const failed = await checkoutRequest(server, reservationId, user.id, 'FAILED', failedKey);
    expect(outcome(failed)).toBe('200 OK');
    expect(failed.body.order.status).toBe('FAILED');
    expect(failed.body.payment.status).toBe('FAILED');
    expect((await getReservation(reservationId)).status).toBe('ACTIVE');
    expect((await getSale(sale.id)).availableStock).toBe(2);
    expect(await prisma.emailOutbox.count()).toBe(0);
    await assertStockInvariant(sale.id);

    const retry = await checkoutRequest(server, reservationId, user.id, 'SUCCESS');
    expect(outcome(retry)).toBe('200 OK');
    expect(retry.body.order.id).toBe(failed.body.order.id);
    expect(retry.body.order.status).toBe('PAID');
    expect(retry.body.payment.status).toBe('SUCCESS');

    expect(await prisma.order.count()).toBe(1);
    const payments = await prisma.payment.findMany({ orderBy: { id: 'asc' } });
    expect(payments.map((p) => p.status)).toEqual(['FAILED', 'SUCCESS']);
    expect((await getReservation(reservationId)).status).toBe('COMPLETED');
    expect(await prisma.emailOutbox.count({ where: { type: 'ORDER_PAID' } })).toBe(1);

    const replayFailed = await checkoutRequest(server, reservationId, user.id, 'SUCCESS', failedKey);
    expect(outcome(replayFailed)).toBe('200 OK');
    expect(replayFailed.body.payment).toEqual(failed.body.payment);
    expect(replayFailed.body.order.status).toBe('PAID');
    expect(await prisma.payment.count()).toBe(2);
    await assertStockInvariant(sale.id);
  });

  it('(k) last unit: A pays PENDING, B gets SOLD_OUT; after resolve FAILED B can reserve', async () => {
    const sale = await createSale({ totalStock: 1, ...openWindow });
    const [a, b] = await createUsers(2);
    const reservationId = await reserveFor(sale.id, a.id);

    const pending = await checkoutRequest(server, reservationId, a.id, 'PENDING');
    expect(outcome(pending)).toBe('200 OK');
    expect(outcome(await reserveRequest(server, sale.id, b.id))).toBe('409 SOLD_OUT');
    await assertStockInvariant(sale.id);

    const resolved = await resolveRequest(server, pending.body.payment.id, 'FAILED');
    expect(outcome(resolved)).toBe('200 OK');
    expect((await getSale(sale.id)).availableStock).toBe(1);
    await assertStockInvariant(sale.id);

    expect(outcome(await reserveRequest(server, sale.id, b.id))).toBe('201 OK');
    expect((await getSale(sale.id)).availableStock).toBe(0);
    await assertStockInvariant(sale.id);
  });

  it('returns 400 when Idempotency-Key is missing or empty', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reservationId = await reserveFor(sale.id, user.id);

    for (const key of [null, '', '   ']) {
      const res = await checkoutRequest(server, reservationId, user.id, 'SUCCESS', key);
      expect(outcome(res)).toBe('400 VALIDATION_ERROR');
    }
    expect(await prisma.order.count()).toBe(0);
    await assertStockInvariant(sale.id);
  });

  it('returns 400 for an invalid outcome', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reservationId = await reserveFor(sale.id, user.id);

    const res = await checkoutRequest(server, reservationId, user.id, 'SUCCESS').send({ outcome: 'MAYBE' });

    expect(outcome(res)).toBe('400 VALIDATION_ERROR');
    expect(await prisma.order.count()).toBe(0);
  });

  it("returns 404 for an unknown or another user's reservation", async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const [owner, stranger] = await createUsers(2);
    const reservationId = await reserveFor(sale.id, owner.id);

    expect(outcome(await checkoutRequest(server, 999_999, owner.id, 'SUCCESS'))).toBe(
      '404 RESERVATION_NOT_FOUND',
    );
    expect(outcome(await checkoutRequest(server, reservationId, stranger.id, 'SUCCESS'))).toBe(
      '404 RESERVATION_NOT_FOUND',
    );
    expect((await getReservation(reservationId)).status).toBe('ACTIVE');
    expect(await prisma.order.count()).toBe(0);
    await assertStockInvariant(sale.id);
  });

  it('requires X-User-Id', async () => {
    const res = await checkoutRequest(server, 1, 999_999, 'SUCCESS');

    expect(outcome(res)).toBe('401 UNAUTHORIZED');
  });
});

describe('DELETE and checkout in parallel on the same ACTIVE reservation', () => {
  it('ends either cancelled or paid, never both, no 500, over 10 rounds', async () => {
    const ROUNDS = 10;
    const sale = await createSale({ totalStock: ROUNDS, ...openWindow });
    const users = await createUsers(ROUNDS);
    const winners: string[] = [];

    for (const user of users) {
      const reservationId = await reserveFor(sale.id, user.id);

      const [cancel, pay] = await Promise.all([
        cancelRequest(server, reservationId, user.id),
        checkoutRequest(server, reservationId, user.id, 'SUCCESS'),
      ]);

      const pair = [outcome(cancel), outcome(pay)];
      const reservation = await getReservation(reservationId);
      const orders = await prisma.order.findMany({ where: { reservationId } });
      if (pair[0] === '200 OK') {
        expect(pair).toEqual(['200 OK', '409 RESERVATION_NOT_ACTIVE']);
        expect(reservation.status).toBe('CANCELLED');
        expect(orders).toEqual([]);
        winners.push('cancel');
      } else {
        expect(pair).toEqual(['409 RESERVATION_NOT_ACTIVE', '200 OK']);
        expect(pay.body.order.status).toBe('PAID');
        expect(reservation.status).toBe('COMPLETED');
        expect(orders.map((o) => o.status)).toEqual(['PAID']);
        winners.push('pay');
      }
      await assertStockInvariant(sale.id);
    }

    const counts = countBy(winners, (w) => w);
    const paid = counts.pay ?? 0;
    expect((counts.cancel ?? 0) + paid).toBe(ROUNDS);
    expect(await prisma.payment.count({ where: { status: 'SUCCESS' } })).toBe(paid);
    expect(await prisma.emailOutbox.count({ where: { type: 'ORDER_PAID' } })).toBe(paid);
    expect((await getSale(sale.id)).availableStock).toBe(ROUNDS - paid);
    await assertStockInvariant(sale.id);
  });
});
