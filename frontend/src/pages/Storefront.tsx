import { useRef, useState } from 'react';
import { ApiError, api, describeError } from '../api/client';
import { useCountdown } from '../hooks/useCountdown';
import type { SaleStore } from '../hooks/useSale';
import { formatCents, formatCountdown } from '../lib/format';
import { saleUiState } from '../lib/saleState';
import { serverNow } from '../lib/time';

export function Storefront({ store }: { store: SaleStore }) {
  const { sale, saleMissing, offset, reservation, refetchSale, refetchCart, setReservation } = store;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  // Computed on every render; useCountdown re-renders the page each second.
  const ui = sale ? saleUiState(sale, serverNow(offset, Date.now())) : null;
  const target = sale && ui === 'SCHEDULED' ? sale.startsAt : sale && ui === 'OPEN' ? sale.endsAt : null;
  const timer = useCountdown(target, offset, () => void refetchSale());

  if (saleMissing) return <p>There is no sale right now.</p>;
  if (!sale) return <p>Loading sale…</p>;

  const soldOut = sale.availableStock < 1;
  const canAdd = ui === 'OPEN' && reservation === null && !busy && !soldOut;

  async function addToCart() {
    if (!sale || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const { reservation: created } = await api.reserve(sale.id);
      setReservation(created);
    } catch (err) {
      setError(describeError(err));
      if (err instanceof ApiError && err.status === 409) await Promise.all([refetchSale(), refetchCart()]);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>{sale.product.name}</h2>
      {sale.product.imageUrl && <img src={sale.product.imageUrl} alt="" className="product-image" />}
      <p>{sale.product.description}</p>
      <p>
        Price: <strong data-testid="price">{formatCents(sale.priceCents)}</strong>
      </p>
      <p>
        In stock: <strong data-testid="stock">{sale.availableStock}</strong>
      </p>
      <p className="timer" data-testid="timer">
        {ui === 'SCHEDULED' && timer && <>Starts in {formatCountdown(timer)}</>}
        {ui === 'OPEN' && timer && <>Ends in {formatCountdown(timer)}</>}
        {ui === 'ENDED' && <>Sale ended</>}
      </p>
      <button onClick={addToCart} disabled={!canAdd}>
        {busy ? 'Adding…' : soldOut && ui !== 'ENDED' ? 'Sold out' : 'Add to cart'}
      </button>
      {reservation && <span className="hint">The item is in your cart.</span>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
