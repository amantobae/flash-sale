import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { resetDb } from './helpers/db';

async function createSale(totalStock: number, availableStock: number) {
  const product = await prisma.product.create({
    data: { name: 'Test product', description: 'Test', imageUrl: 'https://example.test/p.png' },
  });
  return prisma.sale.create({
    data: {
      productId: product.id,
      priceCents: 1000,
      totalStock,
      availableStock,
      startsAt: new Date('2026-01-01T00:00:00Z'),
      endsAt: new Date('2026-01-01T01:00:00Z'),
    },
  });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Sale available_stock CHECK constraint', () => {
  it('rejects a raw update that makes available_stock negative', async () => {
    const sale = await createSale(5, 1);

    await expect(
      prisma.$executeRaw`UPDATE "Sale" SET available_stock = available_stock - 2 WHERE id = ${sale.id}`,
    ).rejects.toThrow(/Sale_available_stock_check/);

    const after = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(after.availableStock).toBe(1);
  });

  it('rejects a raw update that makes available_stock exceed total_stock', async () => {
    const sale = await createSale(5, 5);

    await expect(
      prisma.$executeRaw`UPDATE "Sale" SET available_stock = available_stock + 1 WHERE id = ${sale.id}`,
    ).rejects.toThrow(/Sale_available_stock_check/);

    const after = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(after.availableStock).toBe(5);
  });
});
