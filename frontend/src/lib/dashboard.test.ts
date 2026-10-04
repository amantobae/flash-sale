import { describe, expect, it } from 'vitest';
import { outboxRows, stockRows } from './dashboard';

describe('stockRows', () => {
  it('labels remaining units Available while the sale is not ended', () => {
    expect(stockRows({ status: 'ACTIVE', availableStock: 6, unsold: null, held: 2, pending: 1, sold: 1 })).toEqual([
      { label: 'Available', value: 6 },
      { label: 'Held', value: 2 },
      { label: 'Pending payment', value: 1 },
      { label: 'Sold', value: 1 },
    ]);
  });

  it('labels remaining units Unsold after the sale ended', () => {
    expect(stockRows({ status: 'ENDED', availableStock: 8, unsold: 8, held: 0, pending: 1, sold: 1 })).toEqual([
      { label: 'Unsold', value: 8 },
      { label: 'Held', value: 0 },
      { label: 'Pending payment', value: 1 },
      { label: 'Sold', value: 1 },
    ]);
  });
});

describe('outboxRows', () => {
  it('lists pending, sent and failed counters', () => {
    expect(outboxRows({ pending: 2, sent: 5, failed: 1 })).toEqual([
      { label: 'Pending', value: 2 },
      { label: 'Sent', value: 5 },
      { label: 'Failed', value: 1 },
    ]);
  });
});
