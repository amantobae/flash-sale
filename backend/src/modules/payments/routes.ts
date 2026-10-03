import type { Order, Payment } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireUser } from '../../auth';
import { parseOrThrow } from '../../validation';
import { checkout, type PaymentResult, resolvePayment } from './service';

const idParams = z.object({
  id: z.coerce.number().int().positive(),
});

const checkoutHeaders = z.object({
  'idempotency-key': z.string().trim().min(1).max(255),
});

const checkoutBody = z.object({
  outcome: z.enum(['SUCCESS', 'FAILED', 'PENDING']),
});

const resolveBody = z.object({
  status: z.enum(['SUCCESS', 'FAILED']),
});

export function orderDto(order: Order) {
  return {
    id: order.id,
    userId: order.userId,
    saleId: order.saleId,
    reservationId: order.reservationId,
    amountCents: order.amountCents,
    status: order.status,
    createdAt: order.createdAt,
  };
}

function paymentDto(payment: Payment) {
  return {
    id: payment.id,
    orderId: payment.orderId,
    status: payment.status,
    idempotencyKey: payment.idempotencyKey,
    createdAt: payment.createdAt,
  };
}

function toDto({ order, payment }: PaymentResult) {
  return { order: orderDto(order), payment: paymentDto(payment) };
}

export function paymentRoutes({ now }: { now: () => Date }) {
  const router = Router();

  router.post('/api/reservations/:id/checkout', requireUser, async (req, res) => {
    const { id } = parseOrThrow(idParams, req.params);
    const { 'idempotency-key': key } = parseOrThrow(checkoutHeaders, {
      'idempotency-key': req.header('Idempotency-Key'),
    });
    const { outcome } = parseOrThrow(checkoutBody, req.body);
    const result = await checkout(id, currentUser(res).id, key, outcome, now());
    res.json(toDto(result));
  });

  router.post('/api/payments/:id/resolve', async (req, res) => {
    const { id } = parseOrThrow(idParams, req.params);
    const { status } = parseOrThrow(resolveBody, req.body);
    const result = await resolvePayment(id, status);
    res.json(toDto(result));
  });

  return router;
}
