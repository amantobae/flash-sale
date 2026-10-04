import { describe, expect, it } from 'vitest';
import { formatCents, formatCountdown } from './format';

describe('formatCents', () => {
  it('formats cents as dollars', () => {
    expect(formatCents(4999)).toBe('$49.99');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(123456)).toBe('$1,234.56');
  });
});

describe('formatCountdown', () => {
  it('pads minutes and seconds to mm:ss', () => {
    expect(formatCountdown({ minutes: 0, seconds: 5 })).toBe('00:05');
    expect(formatCountdown({ minutes: 9, seconds: 59 })).toBe('09:59');
    expect(formatCountdown({ minutes: 120, seconds: 0 })).toBe('120:00');
  });
});
