import { describe, expect, it } from 'vitest';
import { createThrottle } from './throttle';

type Scheduled = { id: number; at: number; fn: () => void };

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const scheduled: Scheduled[] = [];
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = nextId++;
      scheduled.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimeout(id: number) {
      const i = scheduled.findIndex((s) => s.id === id);
      if (i >= 0) scheduled.splice(i, 1);
    },
    advance(ms: number) {
      now += ms;
      const due = scheduled.filter((s) => s.at <= now).sort((a, b) => a.at - b.at);
      for (const item of due) {
        const i = scheduled.indexOf(item);
        if (i >= 0) scheduled.splice(i, 1);
        item.fn();
      }
    },
  };
}

describe('createThrottle', () => {
  it('runs the first call immediately and coalesces calls inside the window to one trailing call', () => {
    const calls: number[] = [];
    const timers = fakeTimers();
    const run = createThrottle((n: number) => calls.push(n), 1000, timers);

    run(1);
    run(2);
    run(3);
    expect(calls).toEqual([1]);

    timers.advance(999);
    expect(calls).toEqual([1]);

    timers.advance(1);
    expect(calls).toEqual([1, 3]);
  });

  it('allows another leading call after the interval has passed', () => {
    const calls: string[] = [];
    const timers = fakeTimers();
    const run = createThrottle((s: string) => calls.push(s), 1000, timers);

    run('a');
    timers.advance(1000);
    run('b');
    expect(calls).toEqual(['a', 'b']);
  });
});
