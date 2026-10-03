import { expect } from 'vitest';
import { prisma } from '../../src/db';

type StockRow = { total: number; available: number; held: number; sold: number };

export async function getStockCounts(saleId: number): Promise<StockRow> {
  const rows = await prisma.$queryRaw<StockRow[]>`
    SELECT
      s.total_stock AS total,
      s.available_stock AS available,
      COALESCE(SUM(r.quantity) FILTER (WHERE r.status IN ('ACTIVE', 'PAYMENT_PENDING')), 0)::int AS held,
      COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'COMPLETED'), 0)::int AS sold
    FROM "Sale" s
    LEFT JOIN "Reservation" r ON r.sale_id = s.id
    WHERE s.id = ${saleId}
    GROUP BY s.id
  `;
  if (rows.length !== 1) throw new Error(`Sale ${saleId} not found`);
  return rows[0];
}

export async function assertStockInvariant(saleId: number) {
  const { total, available, held, sold } = await getStockCounts(saleId);
  expect(
    available + held + sold,
    `available (${available}) + held (${held}) + sold (${sold}) must equal total (${total})`,
  ).toBe(total);
}
