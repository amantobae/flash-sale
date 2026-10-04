import { useEffect, useState } from 'react';
import { api, describeError } from '../api/client';
import type { SaleStore } from '../hooks/useSale';
import { formatCents } from '../lib/format';
import type { Order } from '../lib/types';

export function Orders({ store }: { store: SaleStore }) {
  const { orders, refetchOrders } = store;

  useEffect(() => {
    void refetchOrders();
  }, [refetchOrders]);

  if (orders.length === 0) return <p>No orders yet.</p>;

  return (
    <section>
      <h2>Orders</h2>
      <table className="data">
        <thead>
          <tr>
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
            <tr key={order.id}>
              <td>#{order.id}</td>
              <td>{formatCents(order.amountCents)}</td>
              <td>
                <span data-testid={`order-status-${order.id}`} className={`badge badge-${order.status}`}>
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
  const { paymentId } = order;

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
    <fieldset className="panel panel-dashed">
      <legend>Demo: simulate provider webhook</legend>
      <span className="actions">
        <button onClick={() => resolve('SUCCESS')} disabled={busy || paymentId === null}>
          Resolve SUCCESS
        </button>
        <button onClick={() => resolve('FAILED')} disabled={busy || paymentId === null}>
          Resolve FAILED
        </button>
      </span>
      {error && <div className="error">{error}</div>}
    </fieldset>
  );
}
