import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { resetDb } from './helpers/db';
import { createReservation, createSale, createUser } from './helpers/factories';
import { cancelRequest, countBy, currentCartRequest, outcome, reserveRequest } from './helpers/http';
import { assertStockInvariant } from './helpers/invariant';
import { close, listen } from './helpers/server';

const NOW = new Date('2026-01-01T12:00:00Z');
const MINUTE = 60_000;
const HOLD_MS = 10 * MINUTE;

const openWindow = {
  startsAt: new Date(NOW.getTime() - 30 * MINUTE),
  endsAt: new Date(NOW.getTime() + 30 * MINUTE),
};

let server: Server;

beforeAll(async () => {
  server = await listen(createApp({ now: () => NOW }));
});

afterAll(async () => {
  await close(server);
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

async function availableStock(saleId: number) {
  const sale = await prisma.sale.findUniqueOrThrow({ where: { id: saleId } });
  return sale.availableStock;
}

describe('GET /api/reservations/me', () => {
  it('returns null and serverTime when the user has no cart', async () => {
    const user = await createUser();

    const res = await currentCartRequest(server, user.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reservation: null, serverTime: NOW.toISOString() });
  });

  it('returns the ACTIVE reservation', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reserved = await reserveRequest(server, sale.id, user.id);
    expect(outcome(reserved)).toBe('201 OK');

    const res = await currentCartRequest(server, user.id);

    expect(res.status).toBe(200);
    expect(res.body.serverTime).toBe(NOW.toISOString());
    expect(res.body.reservation).toMatchObject({
      id: reserved.body.reservation.id,
      saleId: sale.id,
      userId: user.id,
      status: 'ACTIVE',
      quantity: 1,
      expiresAt: new Date(NOW.getTime() + HOLD_MS).toISOString(),
    });
    await assertStockInvariant(sale.id);
  });

  it('returns the PAYMENT_PENDING reservation', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const pending = await createReservation({
      saleId: sale.id,
      userId: user.id,
      status: 'PAYMENT_PENDING',
      expiresAt: new Date(NOW.getTime() + HOLD_MS),
    });

    const res = await currentCartRequest(server, user.id);

    expect(res.body.reservation).toMatchObject({ id: pending.id, status: 'PAYMENT_PENDING' });
    await assertStockInvariant(sale.id);
  });

  it('ignores EXPIRED, CANCELLED and COMPLETED reservations and other users carts', async () => {
    const sale = await createSale({ totalStock: 5, ...openWindow });
    const user = await createUser();
    const other = await createUser();
    for (const status of ['EXPIRED', 'CANCELLED', 'COMPLETED'] as const) {
      await createReservation({ saleId: sale.id, userId: user.id, status, expiresAt: NOW });
    }
    await createReservation({
      saleId: sale.id,
      userId: other.id,
      status: 'ACTIVE',
      expiresAt: new Date(NOW.getTime() + HOLD_MS),
    });

    const res = await currentCartRequest(server, user.id);

    expect(res.body).toEqual({ reservation: null, serverTime: NOW.toISOString() });
    await assertStockInvariant(sale.id);
  });

  it('requires X-User-Id', async () => {
    const res = await currentCartRequest(server, 999_999);

    expect(outcome(res)).toBe('401 UNAUTHORIZED');
  });
});

describe('DELETE /api/reservations/:id', () => {
  it('(a) cancels the own ACTIVE reservation and returns the unit to stock', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reserved = await reserveRequest(server, sale.id, user.id);
    expect(await availableStock(sale.id)).toBe(2);

    const res = await cancelRequest(server, reserved.body.reservation.id, user.id);

    expect(outcome(res)).toBe('200 OK');
    expect(res.body.reservation).toMatchObject({ id: reserved.body.reservation.id, status: 'CANCELLED' });
    expect(await availableStock(sale.id)).toBe(3);
    const stored = await prisma.reservation.findUniqueOrThrow({ where: { id: reserved.body.reservation.id } });
    expect(stored.status).toBe('CANCELLED');
    const cart = await currentCartRequest(server, user.id);
    expect(cart.body.reservation).toBeNull();
    await assertStockInvariant(sale.id);
  });

  it('(b) 2 parallel cancels of the same reservation: one 200, one 409, stock returned once', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reserved = await reserveRequest(server, sale.id, user.id);
    const reservationId = reserved.body.reservation.id;
    const before = await availableStock(sale.id);

    const responses = await Promise.all([
      cancelRequest(server, reservationId, user.id),
      cancelRequest(server, reservationId, user.id),
    ]);

    expect(countBy(responses, outcome)).toEqual({ '200 OK': 1, '409 RESERVATION_NOT_ACTIVE': 1 });
    expect(await availableStock(sale.id)).toBe(before + 1);
    await assertStockInvariant(sale.id);
  });

  it('a repeated cancel returns 409 and does not return stock again', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reserved = await reserveRequest(server, sale.id, user.id);
    const reservationId = reserved.body.reservation.id;

    expect(outcome(await cancelRequest(server, reservationId, user.id))).toBe('200 OK');
    expect(outcome(await cancelRequest(server, reservationId, user.id))).toBe('409 RESERVATION_NOT_ACTIVE');
    expect(await availableStock(sale.id)).toBe(3);
    await assertStockInvariant(sale.id);
  });

  it("(c) cancelling another user's reservation returns 404 and changes nothing", async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const owner = await createUser();
    const stranger = await createUser();
    const reserved = await reserveRequest(server, sale.id, owner.id);

    const res = await cancelRequest(server, reserved.body.reservation.id, stranger.id);

    expect(outcome(res)).toBe('404 RESERVATION_NOT_FOUND');
    const stored = await prisma.reservation.findUniqueOrThrow({ where: { id: reserved.body.reservation.id } });
    expect(stored.status).toBe('ACTIVE');
    expect(await availableStock(sale.id)).toBe(2);
    await assertStockInvariant(sale.id);
  });

  it('(c) cancelling a PAYMENT_PENDING reservation returns 409 and keeps the unit held', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const pending = await createReservation({
      saleId: sale.id,
      userId: user.id,
      status: 'PAYMENT_PENDING',
      expiresAt: new Date(NOW.getTime() + HOLD_MS),
    });

    const res = await cancelRequest(server, pending.id, user.id);

    expect(outcome(res)).toBe('409 RESERVATION_NOT_ACTIVE');
    const stored = await prisma.reservation.findUniqueOrThrow({ where: { id: pending.id } });
    expect(stored.status).toBe('PAYMENT_PENDING');
    expect(await availableStock(sale.id)).toBe(2);
    await assertStockInvariant(sale.id);
  });

  it('returns 404 for an unknown reservation', async () => {
    const user = await createUser();

    const res = await cancelRequest(server, 999_999, user.id);

    expect(outcome(res)).toBe('404 RESERVATION_NOT_FOUND');
  });
});
