import type { Prisma, Reservation, SaleStatus } from '@prisma/client';
import { prisma } from '../db';

type LockedSale = {
  id: number;
  status: SaleStatus;
  starts_at: Date;
  ends_at: Date;
};

async function lockSale(tx: Prisma.TransactionClient, saleId: number): Promise<LockedSale | undefined> {
  const [sale] = await tx.$queryRaw<LockedSale[]>`
    SELECT id, status, starts_at, ends_at
    FROM "Sale"
    WHERE id = ${saleId}
    FOR UPDATE
  `;
  return sale;
}

export type StartSaleResult = {
  saleId: number;
  status: SaleStatus;
  startsAt: Date;
  endsAt: Date;
};

export async function startSales(now: Date): Promise<StartSaleResult[]> {
  const candidates = await prisma.sale.findMany({
    where: { status: 'SCHEDULED', startsAt: { lte: now } },
    select: { id: true },
  });

  const started: StartSaleResult[] = [];
  for (const { id } of candidates) {
    const result = await prisma.$transaction(async (tx) => {
      const sale = await lockSale(tx, id);
      if (!sale || sale.status !== 'SCHEDULED' || sale.starts_at.getTime() > now.getTime()) return null;
      const updated = await tx.sale.update({ where: { id }, data: { status: 'ACTIVE' } });
      return { saleId: id, status: updated.status, startsAt: updated.startsAt, endsAt: updated.endsAt };
    });
    if (result) {
      await afterStartSaleCommit(result);
      started.push(result);
    }
  }
  return started;
}

// Must only be called after the start-sale transaction has committed.
export async function afterStartSaleCommit(_result: StartSaleResult): Promise<void> {}

export type EndSaleResult = {
  saleId: number;
  availableStock: number;
  clearedReservations: Reservation[];
};

export async function endSales(now: Date): Promise<EndSaleResult[]> {
  const candidates = await prisma.sale.findMany({
    where: { status: { not: 'ENDED' }, endsAt: { lte: now } },
    select: { id: true },
  });

  const ended: EndSaleResult[] = [];
  for (const { id } of candidates) {
    const result = await prisma.$transaction(async (tx) => {
      const sale = await lockSale(tx, id);
      if (!sale || sale.status === 'ENDED' || sale.ends_at.getTime() > now.getTime()) return null;

      const carts = await tx.reservation.findMany({
        where: { saleId: id, status: 'ACTIVE' },
        include: { user: { select: { email: true } } },
      });
      const ids = carts.map((r) => r.id);
      const returned = carts.reduce((sum, r) => sum + r.quantity, 0);

      if (carts.length > 0) {
        await tx.reservation.updateMany({
          where: { id: { in: ids }, status: 'ACTIVE' },
          data: { status: 'EXPIRED' },
        });
        await tx.emailOutbox.createMany({
          data: carts.map((r) => ({
            type: 'SALE_ENDED_CART_CLEARED' as const,
            userId: r.userId,
            toEmail: r.user.email,
            reservationId: r.id,
            payload: { saleId: id },
          })),
          skipDuplicates: true,
        });
      }
      const updated = await tx.sale.update({
        where: { id },
        data: { status: 'ENDED', availableStock: { increment: returned } },
        select: { availableStock: true },
      });
      const clearedReservations = await tx.reservation.findMany({ where: { id: { in: ids } } });
      return { saleId: id, availableStock: updated.availableStock, clearedReservations };
    });
    if (result) {
      await afterEndSaleCommit(result);
      ended.push(result);
    }
  }
  return ended;
}

// Must only be called after the end-sale transaction has committed.
export async function afterEndSaleCommit(_result: EndSaleResult): Promise<void> {}

export type ExpireReservationsResult = {
  saleId: number;
  availableStock: number;
  expiredReservations: Reservation[];
};

export async function expireReservations(now: Date): Promise<ExpireReservationsResult[]> {
  const candidates = await prisma.reservation.findMany({
    where: { status: 'ACTIVE', expiresAt: { lte: now } },
    distinct: ['saleId'],
    select: { saleId: true },
  });

  const expired: ExpireReservationsResult[] = [];
  for (const { saleId } of candidates) {
    const result = await prisma.$transaction(async (tx) => {
      const sale = await lockSale(tx, saleId);
      if (!sale) return null;

      const due = await tx.reservation.findMany({
        where: { saleId, status: 'ACTIVE', expiresAt: { lte: now } },
      });
      if (due.length === 0) return null;
      const ids = due.map((r) => r.id);

      await tx.reservation.updateMany({ where: { id: { in: ids } }, data: { status: 'EXPIRED' } });
      const updated = await tx.sale.update({
        where: { id: saleId },
        data: { availableStock: { increment: due.reduce((sum, r) => sum + r.quantity, 0) } },
        select: { availableStock: true },
      });
      const expiredReservations = await tx.reservation.findMany({ where: { id: { in: ids } } });
      return { saleId, availableStock: updated.availableStock, expiredReservations };
    });
    if (result) {
      await afterExpireReservationsCommit(result);
      expired.push(result);
    }
  }
  return expired;
}

// Must only be called after the expire transaction for this sale has committed.
export async function afterExpireReservationsCommit(_result: ExpireReservationsResult): Promise<void> {}

export async function runTick(now: Date): Promise<void> {
  await startSales(now);
  await endSales(now);
  await expireReservations(now);
}

export function startTicker({
  intervalMs = 1000,
  clock = () => new Date(),
}: { intervalMs?: number; clock?: () => Date } = {}): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runTick(clock());
    } catch (err) {
      console.error('Sale ticker tick failed', err);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
