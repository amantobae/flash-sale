import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../prisma/seed';
import { prisma } from '../src/db';
import { resetDb } from './helpers/db';

const NOW = new Date('2026-01-01T12:00:00Z');
const MINUTE = 60_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

describe('prisma/seed.ts seedDemo', () => {
  it('creates one product and one SCHEDULED sale: stock 10, starts in 1 minute, lasts 10 minutes', async () => {
    const { sale, created } = await seedDemo({ now: NOW });

    expect(created).toBe(true);
    expect(sale).toMatchObject({
      status: 'SCHEDULED',
      totalStock: 10,
      availableStock: 10,
      startsAt: at(MINUTE),
      endsAt: at(11 * MINUTE),
    });
    expect(sale.priceCents).toBeGreaterThan(0);
    expect(Number.isInteger(sale.priceCents)).toBe(true);
    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.sale.count()).toBe(1);
  });

  it('is idempotent: a second run keeps the existing non-ENDED sale', async () => {
    const first = await seedDemo({ now: NOW });
    const second = await seedDemo({ now: at(5 * MINUTE) });

    expect(second.created).toBe(false);
    expect(second.sale.id).toBe(first.sale.id);
    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.sale.count()).toBe(1);
  });

  it('creates a new sale for the same product once the previous one has ENDED', async () => {
    const first = await seedDemo({ now: NOW });
    await prisma.sale.update({ where: { id: first.sale.id }, data: { status: 'ENDED' } });

    const second = await seedDemo({ now: at(20 * MINUTE) });

    expect(second.created).toBe(true);
    expect(second.sale.id).not.toBe(first.sale.id);
    expect(second.sale.productId).toBe(first.sale.productId);
    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.sale.count()).toBe(2);
  });

  it('takes stock, start offset, duration and price from options', async () => {
    const { sale } = await seedDemo({
      now: NOW,
      stock: 3,
      startsInMs: 5 * MINUTE,
      durationMs: 2 * MINUTE,
      priceCents: 1234,
    });

    expect(sale).toMatchObject({
      totalStock: 3,
      availableStock: 3,
      priceCents: 1234,
      startsAt: at(5 * MINUTE),
      endsAt: at(7 * MINUTE),
    });
  });
});
