import { useRef, useState } from 'react';
import { ApiError, api, describeError, newUuid, rememberPayment } from '../api/client';
import { useCountdown } from '../hooks/useCountdown';
import type { SaleStore } from '../hooks/useSale';
import { formatCents, formatCountdown } from '../lib/format';
import { beginAttempt, finishAttempt } from '../lib/paymentAttempt';
import type { PaymentStatus } from '../lib/types';

// A message with `reservationId` only makes sense while that cart is shown ("you can try again").
type Message = { tone: 'ok' | 'error'; text: string; reservationId?: number };

function MessageLine({ message, reservationId }: { message: Message | null; reservationId: number | null }) {
  if (!message || (message.reservationId !== undefined && message.reservationId !== reservationId)) return null;
  return <p style={{ color: message.tone === 'ok' ? 'green' : 'crimson' }}>{message.text}</p>;
}

export function Cart({ store }: { store: SaleStore }) {
  const { user, sale, offset, reservation, paymentAttempt, refetchSale, refetchCart, refetchOrders, setReservation } =
    store;
  const [outcome, setOutcome] = useState<PaymentStatus>('SUCCESS');
  const [busy, setBusy] = useState<'pay' | 'cancel' | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const inFlight = useRef(false);
  const timer = useCountdown(reservation?.status === 'ACTIVE' ? reservation.expiresAt : null, offset, () => {
    void refetchCart();
  });

  if (!reservation) {
    return (
      <section>
        <h2>Cart</h2>
        <p>Your cart is empty.</p>
        <MessageLine message={message} reservationId={null} />
      </section>
    );
  }

  const current = reservation;
  const attempt = paymentAttempt.current;
  const retrying = attempt !== null && attempt.reservationId === current.id;

  async function run(kind: 'pay' | 'cancel', action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      const networkError = err instanceof ApiError && err.status === 0;
      setMessage({ tone: 'error', text: describeError(err), reservationId: networkError ? current.id : undefined });
      if (err instanceof ApiError && err.status === 409) await Promise.all([refetchCart(), refetchSale()]);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const pay = () =>
    run('pay', async () => {
      const started = beginAttempt(paymentAttempt.current, current.id, newUuid);
      paymentAttempt.current = started;
      try {
        const { order, payment } = await api.checkout(current.id, started.key, outcome);
        paymentAttempt.current = finishAttempt(started, payment.status);
        if (payment.status === 'PENDING') rememberPayment(user.id, order.id, payment.id);
        if (payment.status === 'SUCCESS') setMessage({ tone: 'ok', text: `Paid. Order #${order.id} is confirmed.` });
        if (payment.status === 'PENDING')
          setMessage({ tone: 'ok', text: `Payment for order #${order.id} is pending. See Orders.` });
        if (payment.status === 'FAILED')
          setMessage({
            tone: 'error',
            text: 'Payment declined. The item is still yours until the timer ends; you can try again.',
            reservationId: current.id,
          });
        await Promise.all([refetchCart(), refetchOrders()]);
      } catch (err) {
        paymentAttempt.current = finishAttempt(started, null);
        throw err;
      }
    });

  const cancel = () =>
    run('cancel', async () => {
      await api.cancelReservation(current.id);
      setReservation(null);
      setMessage({ tone: 'ok', text: 'Cart cancelled, the item went back to the storefront.' });
    });

  return (
    <section>
      <h2>Cart</h2>
      <p>
        {sale?.product.name ?? 'Item'} × {current.quantity}
        {sale && <> · {formatCents(sale.priceCents * current.quantity)}</>}
      </p>

      {current.status === 'PAYMENT_PENDING' && (
        <p>Payment pending. The item stays reserved for you until the payment provider answers (see Orders).</p>
      )}

      {current.status === 'ACTIVE' && (
        <>
          <p data-testid="cart-timer">Held for you: {timer ? formatCountdown(timer) : '…'}</p>
          <fieldset style={{ maxWidth: 420 }}>
            <legend>Demo: mock payment outcome</legend>
            <select value={outcome} onChange={(e) => setOutcome(e.target.value as PaymentStatus)} disabled={busy !== null}>
              <option value="SUCCESS">SUCCESS (approve)</option>
              <option value="FAILED">FAILED (decline)</option>
              <option value="PENDING">PENDING (provider hangs)</option>
            </select>
          </fieldset>
          <p style={{ display: 'flex', gap: 8 }}>
            <button onClick={pay} disabled={busy !== null || timer?.done === true}>
              {busy === 'pay' ? 'Paying…' : retrying ? 'Pay (retry same attempt)' : 'Pay'}
            </button>
            <button onClick={cancel} disabled={busy !== null}>
              {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
            </button>
          </p>
          {retrying && (
            <p style={{ fontSize: 12, color: '#666' }}>
              Idempotency-Key {attempt.key.slice(0, 8)}… is reused until this attempt ends with a declined payment.
            </p>
          )}
        </>
      )}

      <MessageLine message={message} reservationId={current.id} />
    </section>
  );
}
