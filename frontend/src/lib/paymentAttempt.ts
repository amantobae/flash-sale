import type { PaymentStatus } from './types';

export type PaymentAttempt = { reservationId: number; key: string } | null;

export function beginAttempt(
  attempt: PaymentAttempt,
  reservationId: number,
  makeUuid: () => string,
): NonNullable<PaymentAttempt> {
  if (attempt && attempt.reservationId === reservationId) return attempt;
  return { reservationId, key: makeUuid() };
}

// `paymentStatus` is null when the request gave no payment (network or HTTP error):
// the server may or may not have stored it, so a retry must send the same key.
export function finishAttempt(attempt: PaymentAttempt, paymentStatus: PaymentStatus | null): PaymentAttempt {
  return paymentStatus === 'FAILED' ? null : attempt;
}
