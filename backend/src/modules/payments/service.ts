import { Prisma, type Order, type OrderStatus, type Payment, type PaymentStatus, type SaleStatus } from '@prisma/client';
import { prisma } from '../../db';
import { AppError } from '../../errors';
import { isSaleOpen } from '../reservations/service';
import { charge, type MockOutcome } from './mockProvider';

type LockedSale = {
  id: number;
  status: SaleStatus;
  starts_at: Date;
  ends_at: Date;
  price_cents: number;
};

type Db = Prisma.TransactionClient;

export type PaymentResult = {
  order: Order;
  payment: Payment;
  // false when an existing result was returned and nothing was written.
  changed: boolean;
};

const ORDER_STATUS: Record<PaymentStatus, OrderStatus> = {
  SUCCESS: 'PAID',
  PENDING: 'PENDING',
  FAILED: 'FAILED',
};

async function lockSale(tx: Db, saleId: number): Promise<LockedSale | undefined> {
  const [sale] = await tx.$queryRaw<LockedSale[]>`
    SELECT id, status, starts_at, ends_at, price_cents
    FROM "Sale"
    WHERE id = ${saleId}
    FOR UPDATE
  `;
  return sale;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function latestPayment(db: Db, orderId: number): Promise<Payment> {
  return db.payment.findFirstOrThrow({
    where: { orderId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

// Returns the stored result for this key and reservation, or the PAID/PENDING order of the reservation.
async function findExisting(
  db: Db,
  reservationId: number,
  userId: number,
  idempotencyKey: string,
): Promise<PaymentResult | null> {
  const byKey = await db.payment.findUnique({ where: { idempotencyKey }, include: { order: true } });
  if (byKey) {
    const { order, ...payment } = byKey;
    if (order.reservationId !== reservationId || order.userId !== userId) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used for another payment');
    }
    return { order, payment, changed: false };
  }

  const open = await db.order.findFirst({ where: { reservationId, status: { in: ['PAID', 'PENDING'] } } });
  if (open) {
    return { order: open, payment: await latestPayment(db, open.id), changed: false };
  }
  return null;
}

async function insertOrderPaidEmail(tx: Db, order: Order): Promise<void> {
  const user = await tx.user.findUniqueOrThrow({ where: { id: order.userId }, select: { email: true } });
  await tx.emailOutbox.createMany({
    data: [
      {
        type: 'ORDER_PAID',
        userId: order.userId,
        toEmail: user.email,
        orderId: order.id,
        payload: { orderId: order.id, saleId: order.saleId, amountCents: order.amountCents },
      },
    ],
    skipDuplicates: true,
  });
}

export async function checkout(
  reservationId: number,
  userId: number,
  idempotencyKey: string,
  outcome: MockOutcome,
  now: Date,
): Promise<PaymentResult> {
  const found = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { saleId: true, userId: true },
  });
  if (!found || found.userId !== userId) {
    throw new AppError(404, 'RESERVATION_NOT_FOUND', `Reservation ${reservationId} not found`);
  }

  let result: PaymentResult;
  try {
    result = await prisma.$transaction(async (tx) => {
      const sale = await lockSale(tx, found.saleId);
      if (!sale) {
        throw new AppError(404, 'SALE_NOT_FOUND', `Sale ${found.saleId} not found`);
      }

      const existing = await findExisting(tx, reservationId, userId, idempotencyKey);
      if (existing) return existing;

      const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
      if (reservation.status !== 'ACTIVE') {
        throw new AppError(409, 'RESERVATION_NOT_ACTIVE', `Reservation is ${reservation.status}`);
      }
      if (reservation.expiresAt.getTime() <= now.getTime()) {
        throw new AppError(409, 'RESERVATION_EXPIRED', 'Reservation hold has expired');
      }
      if (!isSaleOpen({ status: sale.status, startsAt: sale.starts_at, endsAt: sale.ends_at }, now)) {
        throw new AppError(409, 'SALE_NOT_ACTIVE', 'Sale is not active');
      }

      const { status: paymentStatus } = charge(outcome);
      const orderStatus = ORDER_STATUS[paymentStatus];
      const order = await tx.order.upsert({
        where: { reservationId },
        create: {
          userId,
          saleId: reservation.saleId,
          reservationId,
          amountCents: sale.price_cents * reservation.quantity,
          status: orderStatus,
          createdAt: now,
        },
        update: { status: orderStatus },
      });
      const payment = await tx.payment.create({
        data: { orderId: order.id, idempotencyKey, status: paymentStatus, createdAt: now },
      });

      if (paymentStatus === 'SUCCESS') {
        await tx.reservation.update({ where: { id: reservationId }, data: { status: 'COMPLETED' } });
        await insertOrderPaidEmail(tx, order);
      } else if (paymentStatus === 'PENDING') {
        await tx.reservation.update({ where: { id: reservationId }, data: { status: 'PAYMENT_PENDING' } });
      }
      return { order, payment, changed: true };
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await findExisting(prisma, reservationId, userId, idempotencyKey);
    if (!existing) throw err;
    result = existing;
  }

  if (result.changed) await afterCheckoutCommit(result);
  return result;
}

// Must only be called after the checkout transaction has committed.
export async function afterCheckoutCommit(_result: PaymentResult): Promise<void> {}

export async function resolvePayment(paymentId: number, status: 'SUCCESS' | 'FAILED'): Promise<PaymentResult> {
  const found = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { order: { select: { saleId: true } } },
  });
  if (!found) {
    throw new AppError(404, 'PAYMENT_NOT_FOUND', `Payment ${paymentId} not found`);
  }

  const result = await prisma.$transaction(async (tx) => {
    await lockSale(tx, found.order.saleId);

    const { order: current, ...currentPayment } = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { order: true },
    });
    if (currentPayment.status !== 'PENDING') {
      return { order: current, payment: currentPayment, changed: false };
    }

    const payment = await tx.payment.update({ where: { id: paymentId }, data: { status } });
    const order = await tx.order.update({ where: { id: current.id }, data: { status: ORDER_STATUS[status] } });
    if (status === 'SUCCESS') {
      await tx.reservation.update({ where: { id: order.reservationId }, data: { status: 'COMPLETED' } });
      await insertOrderPaidEmail(tx, order);
    } else {
      const reservation = await tx.reservation.update({
        where: { id: order.reservationId },
        data: { status: 'CANCELLED' },
      });
      await tx.sale.update({
        where: { id: order.saleId },
        data: { availableStock: { increment: reservation.quantity } },
      });
    }
    return { order, payment, changed: true };
  });

  if (result.changed) await afterResolveCommit(result);
  return result;
}

// Must only be called after the resolve transaction has committed.
export async function afterResolveCommit(_result: PaymentResult): Promise<void> {}
