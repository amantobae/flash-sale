export function dollarsToCents(raw: string): number | null {
  const trimmed = raw.trim().replace(/,/g, '');
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const cents = Math.round(Number(trimmed) * 100);
  if (!Number.isFinite(cents) || cents < 0) return null;
  return cents;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(local: string): string | null {
  if (!local.trim()) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export type SaleFormInput = { price: string; stock: string; startsAt: string; endsAt: string };
export type SaleFormValue = { priceCents: number; totalStock: number; startsAt: string; endsAt: string };
export type SaleFormResult = { ok: true; value: SaleFormValue } | { ok: false; errors: string[] };

export function validateSaleForm(input: SaleFormInput): SaleFormResult {
  const priceCents = dollarsToCents(input.price);
  const stock = Number.parseInt(input.stock, 10);
  const startsAt = fromLocalInput(input.startsAt);
  const endsAt = fromLocalInput(input.endsAt);
  const errors: string[] = [];
  if (priceCents === null || priceCents < 1) errors.push('price');
  if (!Number.isInteger(stock) || stock < 1) errors.push('stock');
  if (!startsAt || !endsAt) errors.push('dates');
  else if (Date.parse(endsAt) <= Date.parse(startsAt)) errors.push('window');
  if (errors.length > 0 || priceCents === null || !startsAt || !endsAt) return { ok: false, errors };
  return { ok: true, value: { priceCents, totalStock: stock, startsAt, endsAt } };
}
