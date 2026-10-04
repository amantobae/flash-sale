import { describe, expect, it } from 'vitest';
import { beginAttempt, finishAttempt } from './paymentAttempt';

function uuids() {
  let n = 0;
  return () => `key-${++n}`;
}

describe('payment attempt (Idempotency-Key)', () => {
  it('creates a key when there is no attempt', () => {
    expect(beginAttempt(null, 7, uuids())).toEqual({ reservationId: 7, key: 'key-1' });
  });

  it('reuses the key on a second begin without finish (double click)', () => {
    const make = uuids();
    const first = beginAttempt(null, 7, make);
    const second = beginAttempt(first, 7, make);
    expect(second.key).toBe('key-1');
    expect(second).toBe(first);
  });

  it('keeps the key after a network error, so the retry sends the same key', () => {
    const make = uuids();
    const attempt = beginAttempt(null, 7, make);
    const afterError = finishAttempt(attempt, null);
    expect(afterError).toBe(attempt);
    expect(beginAttempt(afterError, 7, make).key).toBe('key-1');
  });

  it('drops the key after the payment FAILED, so the next attempt gets a new key', () => {
    const make = uuids();
    const attempt = beginAttempt(null, 7, make);
    const afterFailed = finishAttempt(attempt, 'FAILED');
    expect(afterFailed).toBeNull();
    expect(beginAttempt(afterFailed, 7, make).key).toBe('key-2');
  });

  it('keeps the key after SUCCESS and PENDING (a repeat replays the same result)', () => {
    const make = uuids();
    const attempt = beginAttempt(null, 7, make);
    expect(finishAttempt(attempt, 'SUCCESS')).toBe(attempt);
    expect(finishAttempt(attempt, 'PENDING')).toBe(attempt);
  });

  it('creates a new key for another reservation', () => {
    const make = uuids();
    const attempt = beginAttempt(null, 7, make);
    expect(beginAttempt(attempt, 8, make)).toEqual({ reservationId: 8, key: 'key-2' });
  });

  it('finishing with no attempt stays empty', () => {
    expect(finishAttempt(null, 'FAILED')).toBeNull();
    expect(finishAttempt(null, null)).toBeNull();
  });
});
