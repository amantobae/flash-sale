import {
  Prisma,
  type Order,
  type OrderStatus,
  type Payment,
  type PaymentStatus,
  type Reservation,
  type SaleStatus,
} from '@prisma/client';
import { prisma } from '../../db';
import { AppError } from '../../errors';
import { emitOrderUpdated, emitReservationUpdated, emitSaleStock } from '../../realtime/socket';
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
  reservation: Reservation;
  // Set only when the unit went back to the sale.
  availableStock?: number;
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
  const byKey = await db.payment.findUnique({
    where: { idempotencyKey },
    include: { order: { include: { reservation: true } } },
  });
  if (byKey) {
    const {
      order: { reservation, ...order },
      ...payment
    } = byKey;
    if (order.reservationId !== reservationId || order.userId !== userId) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used for another payment');
    }
    return { order, payment, reservation, changed: false };
  }

  const open = await db.order.findFirst({
    where: { reservationId, status: { in: ['PAID', 'PENDING'] } },
    include: { reservation: true },
  });
  if (open) {
    const { reservation, ...order } = open;
    return { order, payment: await latestPayment(db, order.id), reservation, changed: false };
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

      let updated = reservation;
      if (paymentStatus === 'SUCCESS') {
        updated = await tx.reservation.update({ where: { id: reservationId }, data: { status: 'COMPLETED' } });
        await insertOrderPaidEmail(tx, order);
      } else if (paymentStatus === 'PENDING') {
        updated = await tx.reservation.update({ where: { id: reservationId }, data: { status: 'PAYMENT_PENDING' } });
      }
      return { order, payment, reservation: updated, changed: true };
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
export async function afterCheckoutCommit(result: PaymentResult): Promise<void> {
  emitPaymentEffects(result);
}

function emitPaymentEffects({ order, reservation, availableStock }: PaymentResult): void {
  emitOrderUpdated(order.userId, { orderId: order.id, status: order.status });
  emitReservationUpdated(reservation.userId, { reservationId: reservation.id, status: reservation.status });
  if (availableStock !== undefined) emitSaleStock({ saleId: order.saleId, availableStock });
}

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

    const {
      order: { reservation: currentReservation, ...current },
      ...currentPayment
    } = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { order: { include: { reservation: true } } },
    });
    if (currentPayment.status !== 'PENDING') {
      return { order: current, payment: currentPayment, reservation: currentReservation, changed: false };
    }

    const payment = await tx.payment.update({ where: { id: paymentId }, data: { status } });
    const order = await tx.order.update({ where: { id: current.id }, data: { status: ORDER_STATUS[status] } });
    if (status === 'SUCCESS') {
      const reservation = await tx.reservation.update({
        where: { id: order.reservationId },
        data: { status: 'COMPLETED' },
      });
      await insertOrderPaidEmail(tx, order);
      return { order, payment, reservation, changed: true };
    }
    const reservation = await tx.reservation.update({
      where: { id: order.reservationId },
      data: { status: 'CANCELLED' },
    });
    const sale = await tx.sale.update({
      where: { id: order.saleId },
      data: { availableStock: { increment: reservation.quantity } },
      select: { availableStock: true },
    });
    return { order, payment, reservation, availableStock: sale.availableStock, changed: true };
  });

  if (result.changed) await afterResolveCommit(result);
  return result;
}

// Must only be called after the resolve transaction has committed.
export async function afterResolveCommit(result: PaymentResult): Promise<void> {
  emitPaymentEffects(result);
}
