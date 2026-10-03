import { describe, expect, it } from 'vitest';
import { charge } from '../src/modules/payments/mockProvider';

describe('mock payment provider', () => {
  it.each(['SUCCESS', 'FAILED', 'PENDING'] as const)('maps the requested outcome %s to the payment status', (outcome) => {
    expect(charge(outcome)).toEqual({ status: outcome });
  });

  it('is pure: the same input always gives the same result', () => {
    expect(charge('PENDING')).toEqual(charge('PENDING'));
    expect(charge('SUCCESS')).not.toBe(charge('SUCCESS'));
  });
});
