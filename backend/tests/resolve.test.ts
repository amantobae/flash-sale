import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { endSales, expireReservations } from '../src/jobs/saleTicker';
import { resetDb } from './helpers/db';
import { createReservation, createSale, createUser, createUsers } from './helpers/factories';
import { checkoutRequest, countBy, outcome, reserveRequest, resolveRequest } from './helpers/http';
import { assertStockInvariant, getStockCounts } from './helpers/invariant';
import { close, listen } from './helpers/server';

const NOW = new Date('2026-01-01T12:00:00Z');
const MINUTE = 60_000;
const HOLD_MS = 10 * MINUTE;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const openWindow = { startsAt: at(-30 * MINUTE), endsAt: at(40 * MINUTE) };

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

async function getSale(id: number) {
  return prisma.sale.findUniqueOrThrow({ where: { id } });
}

async function getReservation(id: number) {
  return prisma.reservation.findUniqueOrThrow({ where: { id } });
}

// Reserves through the API at the current clock and pays with outcome PENDING.
async function pendingPayment(saleId: number, userId: number) {
  const reserved = await reserveRequest(server, saleId, userId);
  expect(outcome(reserved)).toBe('201 OK');
  const reservationId: number = reserved.body.reservation.id;
  const res = await checkoutRequest(server, reservationId, userId, 'PENDING');
  expect(outcome(res)).toBe('200 OK');
  expect(res.body.payment.status).toBe('PENDING');
  return { reservationId, orderId: res.body.order.id as number, paymentId: res.body.payment.id as number };
}

// Two other users hold units, so a double return stays under total_stock and only the invariant catches it.
async function holdTwoOtherUnits(saleId: number) {
  for (const user of await createUsers(2)) {
    await createReservation({ saleId, userId: user.id, status: 'ACTIVE', expiresAt: at(HOLD_MS) });
  }
}

describe('POST /api/payments/:id/resolve', () => {
  it('(g) a payment started before expiry completes when the provider answers later, even after the sale ended', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const { reservationId, orderId, paymentId } = await pendingPayment(sale.id, user.id);

    clock = at(30 * MINUTE);
    await expireReservations(clock);
    expect((await getReservation(reservationId)).status).toBe('PAYMENT_PENDING');

    const resolved = await resolveRequest(server, paymentId, 'SUCCESS');
    expect(outcome(resolved)).toBe('200 OK');
    expect(resolved.body.order).toMatchObject({ id: orderId, status: 'PAID' });
    expect(resolved.body.payment).toMatchObject({ id: paymentId, status: 'SUCCESS' });
    expect((await getReservation(reservationId)).status).toBe('COMPLETED');
    expect(await getStockCounts(sale.id)).toEqual({ total: 3, available: 2, held: 0, sold: 1 });
    await assertStockInvariant(sale.id);

    clock = new Date(sale.endsAt.getTime() + MINUTE);
    await endSales(clock);
    expect((await getSale(sale.id)).status).toBe('ENDED');

    const again = await resolveRequest(server, paymentId, 'SUCCESS');
    expect(outcome(again)).toBe('200 OK');
    expect(again.body).toEqual(resolved.body);
    expect((await getReservation(reservationId)).status).toBe('COMPLETED');
    expect(await getStockCounts(sale.id)).toEqual({ total: 3, available: 2, held: 0, sold: 1 });
    const outbox = await prisma.emailOutbox.findMany();
    expect(outbox.map((row) => [row.type, row.orderId, row.userId])).toEqual([['ORDER_PAID', orderId, user.id]]);
    await assertStockInvariant(sale.id);
  });

  it('(g) PENDING checkout at T resolved SUCCESS only after the sale ended still completes', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const { reservationId, paymentId } = await pendingPayment(sale.id, user.id);

    clock = new Date(sale.endsAt.getTime() + MINUTE);
    await endSales(clock);

    const resolved = await resolveRequest(server, paymentId, 'SUCCESS');
    expect(outcome(resolved)).toBe('200 OK');
    expect(resolved.body.order.status).toBe('PAID');
    expect((await getReservation(reservationId)).status).toBe('COMPLETED');
    expect(await getStockCounts(sale.id)).toEqual({ total: 3, available: 2, held: 0, sold: 1 });
    expect(await prisma.emailOutbox.count({ where: { type: 'ORDER_PAID' } })).toBe(1);
    await assertStockInvariant(sale.id);
  });

  it('(h) FAILED cancels the reservation and returns the unit exactly once, also on a repeated resolve', async () => {
    const sale = await createSale({ totalStock: 5, ...openWindow });
    await holdTwoOtherUnits(sale.id);
    const user = await createUser();
    const { reservationId, orderId, paymentId } = await pendingPayment(sale.id, user.id);
    expect((await getSale(sale.id)).availableStock).toBe(2);

    const resolved = await resolveRequest(server, paymentId, 'FAILED');
    expect(outcome(resolved)).toBe('200 OK');
    expect(resolved.body.order).toMatchObject({ id: orderId, status: 'FAILED' });
    expect(resolved.body.payment).toMatchObject({ id: paymentId, status: 'FAILED' });
    expect((await getReservation(reservationId)).status).toBe('CANCELLED');
    expect((await getSale(sale.id)).availableStock).toBe(3);
    await assertStockInvariant(sale.id);

    for (const status of ['FAILED', 'SUCCESS'] as const) {
      const again = await resolveRequest(server, paymentId, status);
      expect(outcome(again)).toBe('200 OK');
      expect(again.body).toEqual(resolved.body);
    }
    expect((await getReservation(reservationId)).status).toBe('CANCELLED');
    expect((await getSale(sale.id)).availableStock).toBe(3);
    expect(await prisma.emailOutbox.count()).toBe(0);
    await assertStockInvariant(sale.id);
  });

  it('(h) 10 parallel FAILED resolves return the unit exactly once', async () => {
    const sale = await createSale({ totalStock: 5, ...openWindow });
    await holdTwoOtherUnits(sale.id);
    const user = await createUser();
    const { reservationId, paymentId } = await pendingPayment(sale.id, user.id);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => resolveRequest(server, paymentId, 'FAILED')),
    );

    expect(countBy(responses, outcome)).toEqual({ '200 OK': 10 });
    for (const res of responses) expect(res.body).toEqual(responses[0].body);
    expect(responses[0].body.order.status).toBe('FAILED');
    expect((await getReservation(reservationId)).status).toBe('CANCELLED');
    expect((await getSale(sale.id)).availableStock).toBe(3);
    await assertStockInvariant(sale.id);
  });

  it('(h) FAILED after the sale ended: the unit stays unsold and the sale stays closed', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const { reservationId, paymentId } = await pendingPayment(sale.id, user.id);

    clock = new Date(sale.endsAt.getTime() + MINUTE);
    await endSales(clock);

    const resolved = await resolveRequest(server, paymentId, 'FAILED');
    expect(outcome(resolved)).toBe('200 OK');
    expect((await getReservation(reservationId)).status).toBe('CANCELLED');
    const after = await getSale(sale.id);
    expect(after.status).toBe('ENDED');
    expect(after.availableStock).toBe(3);
    await assertStockInvariant(sale.id);

    const late = await createUser();
    expect(outcome(await reserveRequest(server, sale.id, late.id))).toBe('409 SALE_NOT_ACTIVE');
    await assertStockInvariant(sale.id);
  });

  it('(j) 10 parallel plus 2 repeated SUCCESS resolves create exactly one ORDER_PAID outbox row', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const { reservationId, orderId, paymentId } = await pendingPayment(sale.id, user.id);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => resolveRequest(server, paymentId, 'SUCCESS')),
    );
    expect(countBy(responses, outcome)).toEqual({ '200 OK': 10 });
    for (const res of responses) expect(res.body).toEqual(responses[0].body);

    for (let i = 0; i < 2; i++) {
      expect(outcome(await resolveRequest(server, paymentId, 'SUCCESS'))).toBe('200 OK');
    }

    const outbox = await prisma.emailOutbox.findMany({ where: { type: 'ORDER_PAID' } });
    expect(outbox.map((row) => row.orderId)).toEqual([orderId]);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('SUCCESS');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PAID');
    expect((await getReservation(reservationId)).status).toBe('COMPLETED');
    await assertStockInvariant(sale.id);
  });

  it('(j) the ORDER_PAID insert tolerates an existing row for the order: 200, still one row', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const { reservationId, orderId, paymentId } = await pendingPayment(sale.id, user.id);
    await prisma.emailOutbox.create({
      data: { type: 'ORDER_PAID', userId: user.id, toEmail: user.email, orderId, payload: {} },
    });

    const res = await resolveRequest(server, paymentId, 'SUCCESS');

    expect(outcome(res)).toBe('200 OK');
    expect(res.body.order.status).toBe('PAID');
    expect((await getReservation(reservationId)).status).toBe('COMPLETED');
    expect(await prisma.emailOutbox.count({ where: { type: 'ORDER_PAID', orderId } })).toBe(1);
    await assertStockInvariant(sale.id);
  });

  it('a payment that is not PENDING is not changed by resolve', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reserved = await reserveRequest(server, sale.id, user.id);
    const paid = await checkoutRequest(server, reserved.body.reservation.id, user.id, 'SUCCESS');
    expect(outcome(paid)).toBe('200 OK');

    const res = await resolveRequest(server, paid.body.payment.id, 'FAILED');

    expect(outcome(res)).toBe('200 OK');
    expect(res.body).toEqual(paid.body);
    expect((await getReservation(reserved.body.reservation.id)).status).toBe('COMPLETED');
    expect((await getSale(sale.id)).availableStock).toBe(2);
    expect(await prisma.emailOutbox.count()).toBe(1);
    await assertStockInvariant(sale.id);
  });

  it('returns 404 for an unknown payment', async () => {
    const res = await resolveRequest(server, 999_999, 'SUCCESS');

    expect(outcome(res)).toBe('404 PAYMENT_NOT_FOUND');
  });

  it('returns 400 for an invalid status', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const { paymentId } = await pendingPayment(sale.id, user.id);

    const res = await resolveRequest(server, paymentId, 'PENDING' as 'SUCCESS');

    expect(outcome(res)).toBe('400 VALIDATION_ERROR');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('PENDING');
    await assertStockInvariant(sale.id);
  });
});
