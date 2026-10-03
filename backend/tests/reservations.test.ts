import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { resetDb } from './helpers/db';
import { createSale, createUser, createUsers } from './helpers/factories';
import { countBy, outcome, reserveRequest as reserve } from './helpers/http';
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

describe('POST /api/sales/:id/reservations: concurrency', () => {
  it('stock 1, 20 users in parallel: exactly 1 success and 19 SOLD_OUT', async () => {
    const sale = await createSale({ totalStock: 1, ...openWindow });
    const users = await createUsers(20);

    const responses = await Promise.all(users.map((u) => reserve(server, sale.id, u.id)));

    expect(countBy(responses, outcome)).toEqual({ '201 OK': 1, '409 SOLD_OUT': 19 });
    const after = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(after.availableStock).toBe(0);
    expect(await prisma.reservation.count({ where: { saleId: sale.id } })).toBe(1);
    await assertStockInvariant(sale.id);
  });

  it('stock 5, 20 users in parallel: exactly 5 successes', async () => {
    const sale = await createSale({ totalStock: 5, ...openWindow });
    const users = await createUsers(20);

    const responses = await Promise.all(users.map((u) => reserve(server, sale.id, u.id)));

    expect(countBy(responses, outcome)).toEqual({ '201 OK': 5, '409 SOLD_OUT': 15 });
    const after = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(after.availableStock).toBe(0);
    const reservations = await prisma.reservation.findMany({ where: { saleId: sale.id } });
    expect(reservations).toHaveLength(5);
    expect(new Set(reservations.map((r) => r.userId)).size).toBe(5);
    await assertStockInvariant(sale.id);
  });

  it('same user, 2 parallel requests on stock 10: exactly 1 reservation and 1 ALREADY_RESERVED', async () => {
    const sale = await createSale({ totalStock: 10, ...openWindow });
    const user = await createUser();

    const responses = await Promise.all([
      reserve(server, sale.id, user.id),
      reserve(server, sale.id, user.id),
    ]);

    expect(countBy(responses, outcome)).toEqual({ '201 OK': 1, '409 ALREADY_RESERVED': 1 });
    const after = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(after.availableStock).toBe(9);
    expect(await prisma.reservation.count({ where: { saleId: sale.id, userId: user.id } })).toBe(1);
    await assertStockInvariant(sale.id);
  });
});

describe('POST /api/sales/:id/reservations: sale window', () => {
  const startsAt = new Date('2026-01-01T12:00:00Z');
  const endsAt = new Date('2026-01-01T13:00:00Z');

  async function reserveAt(now: Date, status: 'SCHEDULED' | 'ACTIVE' | 'ENDED') {
    const sale = await createSale({ totalStock: 3, startsAt, endsAt, status });
    const user = await createUser();
    const clockServer = await listen(createApp({ now: () => now }));
    try {
      const res = await reserve(clockServer, sale.id, user.id);
      return { res, sale };
    } finally {
      await close(clockServer);
    }
  }

  it('returns 409 SALE_NOT_ACTIVE before startsAt', async () => {
    const { res, sale } = await reserveAt(new Date(startsAt.getTime() - 1), 'SCHEDULED');

    expect(outcome(res)).toBe('409 SALE_NOT_ACTIVE');
    const after = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(after.availableStock).toBe(3);
    await assertStockInvariant(sale.id);
  });

  it('allows reserving exactly at startsAt while status is still SCHEDULED', async () => {
    const { res, sale } = await reserveAt(startsAt, 'SCHEDULED');

    expect(outcome(res)).toBe('201 OK');
    expect(res.body.reservation).toMatchObject({ saleId: sale.id, status: 'ACTIVE', quantity: 1 });
    expect(new Date(res.body.reservation.expiresAt).getTime()).toBe(startsAt.getTime() + HOLD_MS);
    const after = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(after.availableStock).toBe(2);
    await assertStockInvariant(sale.id);
  });

  it('returns 409 SALE_NOT_ACTIVE exactly at endsAt', async () => {
    const { res, sale } = await reserveAt(endsAt, 'ACTIVE');

    expect(outcome(res)).toBe('409 SALE_NOT_ACTIVE');
    await assertStockInvariant(sale.id);
  });

  it('returns 409 SALE_NOT_ACTIVE after endsAt', async () => {
    const { res, sale } = await reserveAt(new Date(endsAt.getTime() + MINUTE), 'ACTIVE');

    expect(outcome(res)).toBe('409 SALE_NOT_ACTIVE');
    await assertStockInvariant(sale.id);
  });

  it('returns 409 SALE_NOT_ACTIVE when status is ENDED inside the window', async () => {
    const { res, sale } = await reserveAt(new Date(startsAt.getTime() + 10 * MINUTE), 'ENDED');

    expect(outcome(res)).toBe('409 SALE_NOT_ACTIVE');
    const after = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(after.availableStock).toBe(3);
    await assertStockInvariant(sale.id);
  });

  it('returns 404 SALE_NOT_FOUND for an unknown sale', async () => {
    const user = await createUser();

    const res = await reserve(server, 999_999, user.id);

    expect(outcome(res)).toBe('404 SALE_NOT_FOUND');
  });
});
