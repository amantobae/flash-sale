import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { endSales, expireReservations, runTick, startSales } from '../src/jobs/saleTicker';
import { resetDb } from './helpers/db';
import { createReservation, createSale, createUser, createUsers } from './helpers/factories';
import { outcome, reserveRequest } from './helpers/http';
import { assertStockInvariant } from './helpers/invariant';
import { close, listen } from './helpers/server';

const NOW = new Date('2026-01-01T12:00:00Z');
const MINUTE = 60_000;
const HOLD_MS = 10 * MINUTE;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const openWindow = { startsAt: at(-30 * MINUTE), endsAt: at(30 * MINUTE) };

let server: Server;
let serverAfterHold: Server;

beforeAll(async () => {
  server = await listen(createApp({ now: () => NOW }));
  serverAfterHold = await listen(createApp({ now: () => at(HOLD_MS) }));
});

afterAll(async () => {
  await close(server);
  await close(serverAfterHold);
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

async function getSale(id: number) {
  return prisma.sale.findUniqueOrThrow({ where: { id } });
}

async function getReservation(id: number) {
  return prisma.reservation.findUniqueOrThrow({ where: { id } });
}

describe('expireReservations', () => {
  it('(d) expires exactly at createdAt + 10 min, not 1 ms earlier, and is idempotent', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const reserved = await reserveRequest(server, sale.id, user.id);
    expect(outcome(reserved)).toBe('201 OK');
    const { id, createdAt } = await getReservation(reserved.body.reservation.id);
    expect(createdAt.toISOString()).toBe(NOW.toISOString());

    await expireReservations(new Date(createdAt.getTime() + HOLD_MS - 1));
    expect((await getReservation(id)).status).toBe('ACTIVE');
    expect((await getSale(sale.id)).availableStock).toBe(2);
    await assertStockInvariant(sale.id);

    await expireReservations(new Date(createdAt.getTime() + HOLD_MS));
    expect((await getReservation(id)).status).toBe('EXPIRED');
    expect((await getSale(sale.id)).availableStock).toBe(3);
    await assertStockInvariant(sale.id);

    await expireReservations(new Date(createdAt.getTime() + HOLD_MS));
    expect((await getReservation(id)).status).toBe('EXPIRED');
    expect((await getSale(sale.id)).availableStock).toBe(3);
    await assertStockInvariant(sale.id);
  });

  it('(e) an expired unit can be reserved again by someone else', async () => {
    const sale = await createSale({ totalStock: 1, ...openWindow });
    const [first, second] = await createUsers(2);
    expect(outcome(await reserveRequest(server, sale.id, first.id))).toBe('201 OK');
    expect(outcome(await reserveRequest(server, sale.id, second.id))).toBe('409 SOLD_OUT');

    await expireReservations(at(HOLD_MS));

    const res = await reserveRequest(serverAfterHold, sale.id, second.id);
    expect(outcome(res)).toBe('201 OK');
    expect((await getSale(sale.id)).availableStock).toBe(0);
    await assertStockInvariant(sale.id);
  });

  it('(f) race: expiry and reserve of the last unit in parallel keep the invariant, no 500', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 5; round++) {
      const sale = await createSale({ totalStock: 1, ...openWindow });
      const [holder, buyer] = await createUsers(2);
      const held = await createReservation({
        saleId: sale.id,
        userId: holder.id,
        status: 'ACTIVE',
        expiresAt: at(HOLD_MS),
        createdAt: NOW,
      });

      const [, res] = await Promise.all([
        expireReservations(at(HOLD_MS)),
        reserveRequest(serverAfterHold, sale.id, buyer.id),
      ]);

      outcomes.push(outcome(res));
      expect(['201 OK', '409 SOLD_OUT']).toContain(outcome(res));
      expect((await getReservation(held.id)).status).toBe('EXPIRED');
      expect((await getSale(sale.id)).availableStock).toBe(res.status === 201 ? 0 : 1);
      await assertStockInvariant(sale.id);
    }
    expect(outcomes).toHaveLength(5);
  });

  it('(g) PAYMENT_PENDING is never expired, neither by the hold timer nor by sale end', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const user = await createUser();
    const pending = await createReservation({
      saleId: sale.id,
      userId: user.id,
      status: 'PAYMENT_PENDING',
      expiresAt: at(HOLD_MS),
      createdAt: NOW,
    });

    await expireReservations(at(60 * MINUTE));
    expect((await getReservation(pending.id)).status).toBe('PAYMENT_PENDING');
    expect((await getSale(sale.id)).availableStock).toBe(2);
    await assertStockInvariant(sale.id);

    await endSales(new Date(sale.endsAt.getTime() + 1));
    expect((await getReservation(pending.id)).status).toBe('PAYMENT_PENDING');
    const after = await getSale(sale.id);
    expect(after.status).toBe('ENDED');
    expect(after.availableStock).toBe(2);
    expect(await prisma.emailOutbox.count()).toBe(0);
    await assertStockInvariant(sale.id);
  });
});

describe('endSales', () => {
  it('(h) ends the sale, clears ACTIVE carts, keeps unsold stock, one outbox row per cleared cart', async () => {
    const sale = await createSale({ totalStock: 5, ...openWindow });
    const [cartA, cartB, pendingUser, buyer] = await createUsers(4);
    const activeA = await createReservation({
      saleId: sale.id,
      userId: cartA.id,
      status: 'ACTIVE',
      expiresAt: at(HOLD_MS),
    });
    const activeB = await createReservation({
      saleId: sale.id,
      userId: cartB.id,
      status: 'ACTIVE',
      expiresAt: at(HOLD_MS),
    });
    const pending = await createReservation({
      saleId: sale.id,
      userId: pendingUser.id,
      status: 'PAYMENT_PENDING',
      expiresAt: at(HOLD_MS),
    });
    const completed = await createReservation({
      saleId: sale.id,
      userId: buyer.id,
      status: 'COMPLETED',
      expiresAt: at(HOLD_MS),
    });
    expect((await getSale(sale.id)).availableStock).toBe(1);

    await Promise.all([endSales(sale.endsAt), endSales(sale.endsAt)]);

    const after = await getSale(sale.id);
    expect(after.status).toBe('ENDED');
    expect(after.availableStock).toBe(3);
    expect((await getReservation(activeA.id)).status).toBe('EXPIRED');
    expect((await getReservation(activeB.id)).status).toBe('EXPIRED');
    expect((await getReservation(pending.id)).status).toBe('PAYMENT_PENDING');
    expect((await getReservation(completed.id)).status).toBe('COMPLETED');
    await assertStockInvariant(sale.id);

    const outbox = await prisma.emailOutbox.findMany({ orderBy: { reservationId: 'asc' } });
    expect(outbox).toHaveLength(2);
    expect(outbox.map((row) => [row.type, row.reservationId, row.userId, row.toEmail, row.status])).toEqual([
      ['SALE_ENDED_CART_CLEARED', activeA.id, cartA.id, cartA.email, 'PENDING'],
      ['SALE_ENDED_CART_CLEARED', activeB.id, cartB.id, cartB.email, 'PENDING'],
    ]);

    await endSales(new Date(sale.endsAt.getTime() + MINUTE));
    expect(await prisma.emailOutbox.count()).toBe(2);

    const lateBuyer = await createUser();
    const res = await reserveRequest(server, sale.id, lateBuyer.id);
    expect(outcome(res)).toBe('409 SALE_NOT_ACTIVE');
    expect((await getSale(sale.id)).availableStock).toBe(3);
    await assertStockInvariant(sale.id);
  });

  it('does not end a sale before endsAt', async () => {
    const sale = await createSale({ totalStock: 2, ...openWindow });
    const user = await createUser();
    const active = await createReservation({
      saleId: sale.id,
      userId: user.id,
      status: 'ACTIVE',
      expiresAt: sale.endsAt,
    });

    await endSales(new Date(sale.endsAt.getTime() - 1));

    expect((await getSale(sale.id)).status).toBe('ACTIVE');
    expect((await getReservation(active.id)).status).toBe('ACTIVE');
    expect(await prisma.emailOutbox.count()).toBe(0);
    await assertStockInvariant(sale.id);
  });

  it('ends a SCHEDULED sale whose endsAt has already passed', async () => {
    const sale = await createSale({ totalStock: 2, ...openWindow, status: 'SCHEDULED' });

    await endSales(sale.endsAt);

    const after = await getSale(sale.id);
    expect(after.status).toBe('ENDED');
    expect(after.availableStock).toBe(2);
    await assertStockInvariant(sale.id);
  });
});

describe('startSales', () => {
  it('(i) activates a SCHEDULED sale at startsAt, not before, and is idempotent', async () => {
    const sale = await createSale({
      totalStock: 4,
      startsAt: at(5 * MINUTE),
      endsAt: at(30 * MINUTE),
      status: 'SCHEDULED',
    });

    await startSales(new Date(sale.startsAt.getTime() - 1));
    expect((await getSale(sale.id)).status).toBe('SCHEDULED');

    await startSales(sale.startsAt);
    expect((await getSale(sale.id)).status).toBe('ACTIVE');

    await startSales(sale.startsAt);
    const after = await getSale(sale.id);
    expect(after.status).toBe('ACTIVE');
    expect(after.availableStock).toBe(4);
    await assertStockInvariant(sale.id);
  });

  it('does not reopen an ENDED sale', async () => {
    const sale = await createSale({ totalStock: 1, ...openWindow, status: 'ENDED' });

    await startSales(NOW);

    expect((await getSale(sale.id)).status).toBe('ENDED');
  });
});

describe('runTick', () => {
  it('(j) two parallel ticks start, end and expire exactly once', async () => {
    const tickAt = at(HOLD_MS);
    const toStart = await createSale({
      totalStock: 2,
      startsAt: at(5 * MINUTE),
      endsAt: at(60 * MINUTE),
      status: 'SCHEDULED',
    });
    const toEnd = await createSale({ totalStock: 4, startsAt: at(-60 * MINUTE), endsAt: at(5 * MINUTE) });
    const toExpire = await createSale({ totalStock: 3, ...openWindow });
    const [u1, u2, u3, u4, u5] = await createUsers(5);

    const endCartA = await createReservation({
      saleId: toEnd.id,
      userId: u1.id,
      status: 'ACTIVE',
      expiresAt: at(20 * MINUTE),
    });
    const endCartB = await createReservation({
      saleId: toEnd.id,
      userId: u2.id,
      status: 'ACTIVE',
      expiresAt: at(20 * MINUTE),
    });
    const endPending = await createReservation({
      saleId: toEnd.id,
      userId: u3.id,
      status: 'PAYMENT_PENDING',
      expiresAt: at(-MINUTE),
    });
    const expiring = await createReservation({
      saleId: toExpire.id,
      userId: u4.id,
      status: 'ACTIVE',
      expiresAt: tickAt,
    });
    const notYet = await createReservation({
      saleId: toExpire.id,
      userId: u5.id,
      status: 'ACTIVE',
      expiresAt: new Date(tickAt.getTime() + 1),
    });

    await Promise.all([runTick(tickAt), runTick(tickAt)]);

    expect((await getSale(toStart.id)).status).toBe('ACTIVE');

    const ended = await getSale(toEnd.id);
    expect(ended.status).toBe('ENDED');
    expect(ended.availableStock).toBe(3);
    expect((await getReservation(endCartA.id)).status).toBe('EXPIRED');
    expect((await getReservation(endCartB.id)).status).toBe('EXPIRED');
    expect((await getReservation(endPending.id)).status).toBe('PAYMENT_PENDING');
    const outbox = await prisma.emailOutbox.findMany({ orderBy: { reservationId: 'asc' } });
    expect(outbox.map((row) => row.reservationId)).toEqual([endCartA.id, endCartB.id]);

    expect((await getReservation(expiring.id)).status).toBe('EXPIRED');
    expect((await getReservation(notYet.id)).status).toBe('ACTIVE');
    expect((await getSale(toExpire.id)).availableStock).toBe(2);

    for (const sale of [toStart, toEnd, toExpire]) await assertStockInvariant(sale.id);
  });
});
