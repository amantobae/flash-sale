import { describe, expect, it } from 'vitest';
import { clockOffset, countdown, serverNow } from './time';

const T0 = Date.parse('2026-10-04T12:00:00.000Z');

describe('clockOffset / serverNow', () => {
  it('is positive when the client clock is behind the server', () => {
    const offset = clockOffset('2026-10-04T12:00:05.000Z', T0);
    expect(offset).toBe(5000);
    expect(serverNow(offset, T0)).toBe(T0 + 5000);
  });

  it('is negative when the client clock is ahead of the server', () => {
    const offset = clockOffset('2026-10-04T11:59:57.000Z', T0);
    expect(offset).toBe(-3000);
    expect(serverNow(offset, T0 + 1000)).toBe(T0 - 2000);
  });

  it('is zero when the clocks agree, and serverNow round-trips the server time', () => {
    expect(clockOffset(new Date(T0).toISOString(), T0)).toBe(0);
    const offset = clockOffset('2026-10-04T12:10:00.000Z', T0);
    expect(new Date(serverNow(offset, T0)).toISOString()).toBe('2026-10-04T12:10:00.000Z');
  });
});

describe('countdown', () => {
  const target = '2026-10-04T12:00:00.000Z';

  it('counts down whole minutes and seconds before the target', () => {
    expect(countdown(target, T0 - 125_000)).toEqual({ totalMs: 125_000, minutes: 2, seconds: 5, done: false });
  });

  it('rounds a partial second up, so 59.9 s shows 1:00 and 0.1 s shows 0:01', () => {
    expect(countdown(target, T0 - 59_900)).toEqual({ totalMs: 59_900, minutes: 1, seconds: 0, done: false });
    expect(countdown(target, T0 - 100)).toEqual({ totalMs: 100, minutes: 0, seconds: 1, done: false });
  });

  it('is done exactly at the target', () => {
    expect(countdown(target, T0)).toEqual({ totalMs: 0, minutes: 0, seconds: 0, done: true });
  });

  it('never goes negative after the target', () => {
    expect(countdown(target, T0 + 90_000)).toEqual({ totalMs: 0, minutes: 0, seconds: 0, done: true });
  });

  it('shows more than 60 minutes as minutes', () => {
    expect(countdown(target, T0 - 2 * 3600_000)).toMatchObject({ minutes: 120, seconds: 0 });
  });
});
