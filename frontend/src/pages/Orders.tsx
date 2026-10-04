import { useEffect, useState } from 'react';
import { api, describeError, paymentIdFor } from '../api/client';
import type { SaleStore } from '../hooks/useSale';
import { formatCents } from '../lib/format';
import type { Order, OrderStatus } from '../lib/types';

const BADGE: Record<OrderStatus, string> = { PENDING: '#b58900', PAID: '#2e7d32', FAILED: '#c62828' };

export function Orders({ store }: { store: SaleStore }) {
  const { orders, refetchOrders } = store;

  useEffect(() => {
    void refetchOrders();
  }, [refetchOrders]);

  if (orders.length === 0) return <p>No orders yet.</p>;

  return (
    <section>
      <h2>Orders</h2>
      <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left' }}>
            <th>Order</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Last payment</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id} style={{ borderTop: '1px solid #ddd' }}>
              <td>#{order.id}</td>
              <td>{formatCents(order.amountCents)}</td>
              <td>
                <span
                  data-testid={`order-status-${order.id}`}
                  style={{ background: BADGE[order.status], color: 'white', padding: '2px 6px', borderRadius: 4 }}
                >
                  {order.status}
                </span>
              </td>
              <td>{order.paymentStatus ?? '-'}</td>
              <td>{new Date(order.createdAt).toLocaleString()}</td>
              <td>{order.status === 'PENDING' && <ResolveDemo order={order} store={store} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ResolveDemo({ order, store }: { order: Order; store: SaleStore }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paymentId = paymentIdFor(store.user.id, order.id);

  async function resolve(status: 'SUCCESS' | 'FAILED') {
    if (paymentId === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.resolvePayment(paymentId, status);
      await Promise.all([store.refetchOrders(), store.refetchCart()]);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset style={{ border: '1px dashed #999' }}>
      <legend>Demo: simulate provider webhook</legend>
      {paymentId === null ? (
        <small>Payment id is only known in the tab that started this payment.</small>
      ) : (
        <span style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => resolve('SUCCESS')} disabled={busy}>
            Resolve SUCCESS
          </button>
          <button onClick={() => resolve('FAILED')} disabled={busy}>
            Resolve FAILED
          </button>
        </span>
      )}
      {error && <div style={{ color: 'crimson' }}>{error}</div>}
    </fieldset>
  );
}
