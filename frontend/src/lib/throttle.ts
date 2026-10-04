export type ThrottleTimers<TTimer = unknown> = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => TTimer;
  clearTimeout: (id: TTimer) => void;
};

const defaultTimers: ThrottleTimers<ReturnType<typeof setTimeout>> = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export function createThrottle<Args extends unknown[], TTimer = ReturnType<typeof setTimeout>>(
  fn: (...args: Args) => void,
  intervalMs: number,
  timers: ThrottleTimers<TTimer> = defaultTimers as unknown as ThrottleTimers<TTimer>,
): ((...args: Args) => void) & { cancel(): void } {
  let lastAt = Number.NEGATIVE_INFINITY;
  let timer: TTimer | null = null;
  let pending: Args | null = null;

  const invoke = (args: Args) => {
    lastAt = timers.now();
    fn(...args);
  };

  const run = (...args: Args) => {
    const wait = intervalMs - (timers.now() - lastAt);
    if (wait <= 0) {
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      pending = null;
      invoke(args);
      return;
    }
    pending = args;
    if (timer !== null) return;
    timer = timers.setTimeout(() => {
      timer = null;
      if (pending) {
        const next = pending;
        pending = null;
        invoke(next);
      }
    }, wait);
  };

  run.cancel = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    pending = null;
  };

  return run;
}
