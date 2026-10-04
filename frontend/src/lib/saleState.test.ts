import { describe, expect, it } from 'vitest';
import { applySaleStatus, applySaleStock, saleUiState } from './saleState';
import { clockOffset, serverNow } from './time';
import type { Sale } from './types';

const startsAt = '2026-10-04T12:00:00.000Z';
const endsAt = '2026-10-04T12:10:00.000Z';
const START = Date.parse(startsAt);
const END = Date.parse(endsAt);

function makeSale(overrides: Partial<Sale> = {}): Sale {
  return {
    id: 1,
    status: 'SCHEDULED',
    priceCents: 4999,
    availableStock: 10,
    startsAt,
    endsAt,
    product: { id: 1, name: 'Demo', description: 'Demo product', imageUrl: '' },
    ...overrides,
  };
}

describe('saleUiState', () => {
  it('is SCHEDULED before startsAt', () => {
    expect(saleUiState(makeSale(), START - 1)).toBe('SCHEDULED');
  });

  it('is OPEN exactly at startsAt even while the status is still SCHEDULED', () => {
    expect(saleUiState(makeSale({ status: 'SCHEDULED' }), START)).toBe('OPEN');
  });

  it('is OPEN inside the window when ACTIVE', () => {
    expect(saleUiState(makeSale({ status: 'ACTIVE' }), END - 1)).toBe('OPEN');
  });

  it('is ENDED exactly at endsAt even while the status is still ACTIVE', () => {
    expect(saleUiState(makeSale({ status: 'ACTIVE' }), END)).toBe('ENDED');
  });

  it('is ENDED after endsAt with status SCHEDULED (end passed before the start tick)', () => {
    expect(saleUiState(makeSale({ status: 'SCHEDULED' }), END + 1000)).toBe('ENDED');
  });

  it('is ENDED when the status is ENDED, even inside the time window', () => {
    expect(saleUiState(makeSale({ status: 'ENDED' }), START + 1000)).toBe('ENDED');
    expect(saleUiState(makeSale({ status: 'ENDED' }), START - 1000)).toBe('ENDED');
  });

  describe('with a clock offset', () => {
    it('client clock 30 s ahead: OPEN exactly when the server reaches startsAt', () => {
      // Server said 11:59:00 when the client read 11:59:30.
      const offset = clockOffset('2026-10-04T11:59:00.000Z', START - 30_000);
      expect(offset).toBe(-30_000);
      const clientAtStart = START + 30_000;
      expect(saleUiState(makeSale(), serverNow(offset, clientAtStart - 1))).toBe('SCHEDULED');
      expect(saleUiState(makeSale(), serverNow(offset, clientAtStart))).toBe('OPEN');
      // The local clock already shows startsAt, but the server has not reached it yet.
      expect(saleUiState(makeSale(), serverNow(offset, START))).toBe('SCHEDULED');
    });

    it('client clock 30 s behind: OPEN before the local clock shows startsAt, ENDED at server endsAt', () => {
      const offset = clockOffset('2026-10-04T11:59:30.000Z', START - 60_000);
      expect(offset).toBe(30_000);
      expect(saleUiState(makeSale(), serverNow(offset, START - 30_001))).toBe('SCHEDULED');
      expect(saleUiState(makeSale(), serverNow(offset, START - 30_000))).toBe('OPEN');
      expect(saleUiState(makeSale({ status: 'ACTIVE' }), serverNow(offset, END - 30_001))).toBe('OPEN');
      expect(saleUiState(makeSale({ status: 'ACTIVE' }), serverNow(offset, END - 30_000))).toBe('ENDED');
    });
  });
});

describe('applySaleStock', () => {
  it('updates availableStock for the same sale without mutating the input', () => {
    const sale = makeSale({ availableStock: 5 });
    const next = applySaleStock(sale, { saleId: 1, availableStock: 4 });
    expect(next).toEqual({ ...sale, availableStock: 4 });
    expect(sale.availableStock).toBe(5);
    expect(next).not.toBe(sale);
  });

  it('ignores an event for another sale', () => {
    const sale = makeSale();
    expect(applySaleStock(sale, { saleId: 2, availableStock: 0 })).toBe(sale);
  });

  it('keeps null when no sale is loaded', () => {
    expect(applySaleStock(null, { saleId: 1, availableStock: 0 })).toBeNull();
  });
});

describe('applySaleStatus', () => {
  const event = {
    saleId: 1,
    status: 'ACTIVE' as const,
    startsAt: '2026-10-04T12:01:00.000Z',
    endsAt: '2026-10-04T12:20:00.000Z',
    serverTime: '2026-10-04T12:01:00.000Z',
  };

  it('updates status, startsAt and endsAt for the same sale without mutating the input', () => {
    const sale = makeSale();
    const next = applySaleStatus(sale, event);
    expect(next).toEqual({ ...sale, status: 'ACTIVE', startsAt: event.startsAt, endsAt: event.endsAt });
    expect(sale.status).toBe('SCHEDULED');
    expect(sale.startsAt).toBe(startsAt);
  });

  it('ignores an event for another sale', () => {
    const sale = makeSale();
    expect(applySaleStatus(sale, { ...event, saleId: 2 })).toBe(sale);
  });

  it('keeps null when no sale is loaded', () => {
    expect(applySaleStatus(null, event)).toBeNull();
  });
});
