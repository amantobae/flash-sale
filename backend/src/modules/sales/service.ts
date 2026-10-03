import type { Product, Sale } from '@prisma/client';
import { prisma } from '../../db';
import { AppError } from '../../errors';

export type SaleWithProduct = Sale & { product: Product };

// The single non-ENDED sale; if every sale has ended, the one that ended last.
export async function getCurrentSale(): Promise<SaleWithProduct> {
  const open = await prisma.sale.findFirst({
    where: { status: { not: 'ENDED' } },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    include: { product: true },
  });
  if (open) return open;

  const latest = await prisma.sale.findFirst({
    orderBy: [{ endsAt: 'desc' }, { id: 'desc' }],
    include: { product: true },
  });
  if (!latest) throw new AppError(404, 'SALE_NOT_FOUND', 'No sale found');
  return latest;
}
