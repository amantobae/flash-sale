import type { Reservation, SaleStatus } from '@prisma/client';
import { prisma } from '../../db';
import { AppError } from '../../errors';

export const RESERVATION_HOLD_MS = 10 * 60 * 1000;

type LockedSale = {
  id: number;
  status: SaleStatus;
  starts_at: Date;
  ends_at: Date;
  available_stock: number;
};

export type ReserveResult = {
  reservation: Reservation;
  availableStock: number;
};

export function isSaleOpen(
  sale: { status: SaleStatus; startsAt: Date; endsAt: Date },
  now: Date,
): boolean {
  return (
    sale.status !== 'ENDED' &&
    sale.startsAt.getTime() <= now.getTime() &&
    now.getTime() < sale.endsAt.getTime()
  );
}

export async function reserve(saleId: number, userId: number, now: Date): Promise<ReserveResult> {
  const result = await prisma.$transaction(async (tx) => {
    const [sale] = await tx.$queryRaw<LockedSale[]>`
      SELECT id, status, starts_at, ends_at, available_stock
      FROM "Sale"
      WHERE id = ${saleId}
      FOR UPDATE
    `;
    if (!sale) {
      throw new AppError(404, 'SALE_NOT_FOUND', `Sale ${saleId} not found`);
    }
    if (!isSaleOpen({ status: sale.status, startsAt: sale.starts_at, endsAt: sale.ends_at }, now)) {
      throw new AppError(409, 'SALE_NOT_ACTIVE', 'Sale is not active');
    }

    const existing = await tx.reservation.findFirst({
      where: { saleId, userId, status: { in: ['ACTIVE', 'PAYMENT_PENDING'] } },
      select: { id: true },
    });
    if (existing) {
      throw new AppError(409, 'ALREADY_RESERVED', 'You already have a reservation for this sale');
    }
    if (sale.available_stock < 1) {
      throw new AppError(409, 'SOLD_OUT', 'Sold out');
    }

    const updated = await tx.sale.update({
      where: { id: saleId },
      data: { availableStock: { decrement: 1 } },
      select: { availableStock: true },
    });
    const reservation = await tx.reservation.create({
      data: {
        saleId,
        userId,
        quantity: 1,
        status: 'ACTIVE',
        expiresAt: new Date(now.getTime() + RESERVATION_HOLD_MS),
      },
    });
    return { reservation, availableStock: updated.availableStock };
  });

  await afterReserveCommit(result);
  return result;
}

// Must only be called after the reserve transaction has committed.
export async function afterReserveCommit(_result: ReserveResult): Promise<void> {}
