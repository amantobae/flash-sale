import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError } from '../api/client';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { outboxRows, stockRows } from '../lib/dashboard';
import { formatCents } from '../lib/format';
import { toLocalInput, validateSaleForm } from '../lib/saleForm';
import { createThrottle } from '../lib/throttle';
import type { DashboardChangedEvent, DashboardSnapshot } from '../lib/types';
import { getSocket, joinRoom } from '../socket';

function defaultForm() {
  const starts = new Date(Date.now() + 60_000);
  const ends = new Date(starts.getTime() + 10 * 60_000);
  return {
    price: '49.99',
    stock: '10',
    startsAt: toLocalInput(starts.toISOString()),
    endsAt: toLocalInput(ends.toISOString()),
  };
}

export function Dashboard() {
  const socket = getSocket();
  const [saleId, setSaleId] = useState<number | null>(null);
  const [saleIdInput, setSaleIdInput] = useState('');
  const [data, setData] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(defaultForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const saleIdRef = useRef<number | null>(null);

  const load = useCallback(async (id: number) => {
    try {
      const next = await api.getDashboard(id);
      setData(next);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  const throttleRef = useRef<ReturnType<typeof createThrottle<[number]>> | null>(null);
  if (throttleRef.current === null) {
    throttleRef.current = createThrottle((id: number) => {
      void load(id);
    }, 1000);
  }

  useEffect(() => {
    const throttle = throttleRef.current;
    return () => throttle?.cancel();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const onConnect = async () => {
      await joinRoom(socket, 'dashboard:join');
      const id = saleIdRef.current;
      if (id) {
        if (!cancelled) void load(id);
        return;
      }
      try {
        const { sale } = await api.getCurrentSale();
        if (cancelled) return;
        saleIdRef.current = sale.id;
        setSaleId(sale.id);
        setSaleIdInput(String(sale.id));
        await load(sale.id);
      } catch (err) {
        if (!cancelled) setError(describeError(err));
      }
    };
    socket.on('connect', onConnect);
    if (socket.connected) void onConnect();
    else socket.connect();
    return () => {
      cancelled = true;
      socket.off('connect', onConnect);
    };
  }, [socket, load]);

  useSocketEvent<DashboardChangedEvent>(socket, 'dashboard:changed', (event) => {
    if (saleIdRef.current === event.saleId) throttleRef.current?.(event.saleId);
  });

  async function openSale(id: number) {
    saleIdRef.current = id;
    setSaleId(id);
    setSaleIdInput(String(id));
    await load(id);
  }

  async function createNext(e: React.FormEvent) {
    e.preventDefault();
    const parsed = validateSaleForm(form);
    if (!parsed.ok) {
      setFormError('Check price, stock (>= 1) and that the end is after the start.');
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const { sale } = await api.createSale(parsed.value);
      setForm(defaultForm());
      await openSale(sale.id);
    } catch (err) {
      setFormError(describeError(err));
    } finally {
      setCreating(false);
    }
  }

  const stats = data
    ? stockRows({
        status: data.sale.status,
        availableStock: data.availableStock,
        unsold: data.unsold,
        held: data.held,
        pending: data.pending,
        sold: data.sold,
      })
    : [];

  return (
    <section>
      <h2>Dashboard</h2>
      <p>
        Sale id{' '}
        <input
          value={saleIdInput}
          onChange={(e) => setSaleIdInput(e.target.value)}
          style={{ width: 80 }}
        />{' '}
        <button
          onClick={() => {
            const id = Number.parseInt(saleIdInput, 10);
            if (Number.isInteger(id) && id > 0) void openSale(id);
          }}
        >
          Load
        </button>
      </p>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {data && (
        <>
          <p>
            {data.sale.productName} · {data.sale.status} · {formatCents(data.sale.priceCents)} · stock{' '}
            {data.sale.totalStock}
          </p>
          <p>
            {new Date(data.sale.startsAt).toLocaleString()} — {new Date(data.sale.endsAt).toLocaleString()}
          </p>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '12px 0' }}>
            {stats.map((row) => (
              <div key={row.label} style={{ minWidth: 120, padding: 12, border: '1px solid #ddd' }}>
                <div style={{ fontSize: 12, color: '#666' }}>{row.label}</div>
                <div style={{ fontSize: 24 }}>{row.value}</div>
              </div>
            ))}
            <div style={{ minWidth: 120, padding: 12, border: '1px solid #ddd' }}>
              <div style={{ fontSize: 12, color: '#666' }}>Revenue</div>
              <div style={{ fontSize: 24 }}>{formatCents(data.revenueCents)}</div>
            </div>
          </div>
          <h3>Outbox</h3>
          <p>
            {outboxRows(data.outbox)
              .map((row) => `${row.label}: ${row.value}`)
              .join(' · ')}
          </p>
          <h3>Recent orders</h3>
          {data.recentOrders.length === 0 ? (
            <p>No orders yet.</p>
          ) : (
            <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th>Order</th>
                  <th>User</th>
                  <th>Status</th>
                  <th>Amount</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data.recentOrders.map((order) => (
                  <tr key={order.id} style={{ borderTop: '1px solid #ddd' }}>
                    <td>#{order.id}</td>
                    <td>{order.username}</td>
                    <td>{order.status}</td>
                    <td>{formatCents(order.amountCents)}</td>
                    <td>{new Date(order.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <h3>Create next sale</h3>
      <form onSubmit={createNext} style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
        <label>
          Price (USD){' '}
          <input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        </label>
        <label>
          Stock{' '}
          <input value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} />
        </label>
        <label>
          Starts{' '}
          <input
            type="datetime-local"
            value={form.startsAt}
            onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
          />
        </label>
        <label>
          Ends{' '}
          <input
            type="datetime-local"
            value={form.endsAt}
            onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
          />
        </label>
        <button type="submit" disabled={creating}>
          {creating ? 'Creating…' : 'Create sale'}
        </button>
        {formError && <div style={{ color: 'crimson' }}>{formError}</div>}
      </form>
      {saleId === null && !data && !error && <p>Loading dashboard…</p>}
    </section>
  );
}
