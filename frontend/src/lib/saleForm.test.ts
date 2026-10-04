import { describe, expect, it } from 'vitest';
import { dollarsToCents, fromLocalInput, toLocalInput, validateSaleForm } from './saleForm';

describe('dollarsToCents', () => {
  it('parses dollar amounts to integer cents', () => {
    expect(dollarsToCents('49.99')).toBe(4999);
    expect(dollarsToCents('10')).toBe(1000);
    expect(dollarsToCents('0.05')).toBe(5);
    expect(dollarsToCents('1,234.56')).toBe(123456);
  });

  it('returns null for empty or invalid input', () => {
    expect(dollarsToCents('')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
    expect(dollarsToCents('-1')).toBeNull();
  });
});

describe('datetime-local helpers', () => {
  it('round-trips an ISO timestamp through datetime-local', () => {
    const iso = '2026-01-01T12:30:00.000Z';
    const local = toLocalInput(iso);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInput(local)).toBe(iso);
  });

  it('fromLocalInput returns null for an empty value', () => {
    expect(fromLocalInput('')).toBeNull();
  });
});

describe('validateSaleForm', () => {
  const valid = {
    price: '49.99',
    stock: '10',
    startsAt: '2026-01-01T12:00',
    endsAt: '2026-01-01T12:10',
  };

  it('accepts a valid form and returns cents plus ISO dates', () => {
    const result = validateSaleForm(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      priceCents: 4999,
      totalStock: 10,
      startsAt: fromLocalInput(valid.startsAt),
      endsAt: fromLocalInput(valid.endsAt),
    });
  });

  it('rejects stock below 1, a missing price, and endsAt <= startsAt', () => {
    expect(validateSaleForm({ ...valid, stock: '0' }).ok).toBe(false);
    expect(validateSaleForm({ ...valid, price: '' }).ok).toBe(false);
    expect(validateSaleForm({ ...valid, endsAt: valid.startsAt }).ok).toBe(false);
    expect(validateSaleForm({ ...valid, endsAt: '2026-01-01T11:00' }).ok).toBe(false);
  });
});
