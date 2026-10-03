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

export function countBy<T>(items: T[], key: (item: T) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

export const outcome = (res: request.Response) => `${res.status} ${res.body?.error?.code ?? 'OK'}`;
