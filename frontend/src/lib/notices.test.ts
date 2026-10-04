import { describe, expect, it } from 'vitest';
import { orderNotice, reservationNotice, saleStatusNotice } from './notices';

describe('reservationNotice', () => {
  it('says the cart expired', () => {
    expect(reservationNotice('EXPIRED', false)).toBe('Your cart expired');
  });

  it('says the sale ended when the cart was cleared by the sale end', () => {
    expect(reservationNotice('EXPIRED', true)).toBe('Sale ended, your cart was cleared');
  });

  it('is silent for statuses covered by other notices or by the user action', () => {
    for (const status of ['ACTIVE', 'PAYMENT_PENDING', 'COMPLETED', 'CANCELLED'] as const) {
      expect(reservationNotice(status, false)).toBeNull();
    }
  });
});

describe('orderNotice', () => {
  it('reports paid and failed orders', () => {
    expect(orderNotice(3, 'PAID')).toBe('Order #3 paid');
    expect(orderNotice(3, 'FAILED')).toBe('Payment for order #3 failed');
  });

  it('reports a pending payment', () => {
    expect(orderNotice(3, 'PENDING')).toBe('Payment for order #3 is pending');
  });
});

describe('saleStatusNotice', () => {
  it('reports the start and the end once, on a status change', () => {
    expect(saleStatusNotice('SCHEDULED', 'ACTIVE')).toBe('Sale started');
    expect(saleStatusNotice('ACTIVE', 'ENDED')).toBe('Sale ended');
    expect(saleStatusNotice('SCHEDULED', 'ENDED')).toBe('Sale ended');
  });

  it('is silent when the status did not change or nothing was known before', () => {
    expect(saleStatusNotice('ACTIVE', 'ACTIVE')).toBeNull();
    expect(saleStatusNotice('SCHEDULED', 'SCHEDULED')).toBeNull();
    expect(saleStatusNotice(null, 'ACTIVE')).toBeNull();
  });
});
