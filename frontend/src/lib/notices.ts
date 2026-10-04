import type { OrderStatus, ReservationStatus, SaleStatus } from './types';

export function reservationNotice(status: ReservationStatus, saleEnded: boolean): string | null {
  if (status !== 'EXPIRED') return null;
  return saleEnded ? 'Sale ended, your cart was cleared' : 'Your cart expired';
}

export function orderNotice(orderId: number, status: OrderStatus): string {
  if (status === 'PAID') return `Order #${orderId} paid`;
  if (status === 'FAILED') return `Payment for order #${orderId} failed`;
  return `Payment for order #${orderId} is pending`;
}

export function saleStatusNotice(previous: SaleStatus | null, next: SaleStatus): string | null {
  if (previous === null || previous === next) return null;
  if (next === 'ACTIVE') return 'Sale started';
  if (next === 'ENDED') return 'Sale ended';
  return null;
}
