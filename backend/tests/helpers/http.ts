import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';

export function reserveRequest(target: Server, saleId: number, userId: number) {
  return request(target).post(`/api/sales/${saleId}/reservations`).set('X-User-Id', String(userId));
}

export function cancelRequest(target: Server, reservationId: number, userId: number) {
  return request(target).delete(`/api/reservations/${reservationId}`).set('X-User-Id', String(userId));
}

export function currentCartRequest(target: Server, userId: number) {
  return request(target).get('/api/reservations/me').set('X-User-Id', String(userId));
}

export type CheckoutOutcome = 'SUCCESS' | 'FAILED' | 'PENDING';

// key: undefined generates a fresh key, null sends no Idempotency-Key header.
export function checkoutRequest(
  target: Server,
  reservationId: number,
  userId: number,
  outcome: CheckoutOutcome,
  key: string | null = randomUUID(),
) {
  const req = request(target)
    .post(`/api/reservations/${reservationId}/checkout`)
    .set('X-User-Id', String(userId));
  if (key !== null) req.set('Idempotency-Key', key);
  return req.send({ outcome });
}

export function resolveRequest(target: Server, paymentId: number, status: 'SUCCESS' | 'FAILED') {
  return request(target).post(`/api/payments/${paymentId}/resolve`).send({ status });
}

export function myOrdersRequest(target: Server, userId: number) {
  return request(target).get('/api/orders/me').set('X-User-Id', String(userId));
}

export function dashboardRequest(target: Server, saleId: number) {
  return request(target).get(`/api/dashboard/sales/${saleId}`);
}

export function createSaleRequest(target: Server, body: object) {
  return request(target).post('/api/dashboard/sales').send(body);
}

export function updateSaleRequest(target: Server, saleId: number, body: object) {
  return request(target).put(`/api/dashboard/sales/${saleId}`).send(body);
}

export function countBy<T>(items: T[], key: (item: T) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

export const outcome = (res: request.Response) => `${res.status} ${res.body?.error?.code ?? 'OK'}`;
