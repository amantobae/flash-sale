import { useEffect, useRef, useState } from 'react';
import { countdown, serverNow, type Countdown } from '../lib/time';

// Ticks once per second on the server clock (clientNow + offset). The next tick is scheduled for the
// moment the displayed second changes, so 00:00 is shown when the server reaches the target.
// `onDone` fires once per target, and only if the countdown was seen running.
export function useCountdown(targetIso: string | null, offset: number, onDone?: () => void): Countdown | null {
  const compute = () => (targetIso ? countdown(targetIso, serverNow(offset, Date.now())) : null);
  const [value, setValue] = useState<Countdown | null>(compute);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!targetIso) {
      setValue(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasRunning = false;
    const tick = () => {
      const next = countdown(targetIso, serverNow(offset, Date.now()));
      setValue(next);
      if (next.done) {
        if (wasRunning) onDoneRef.current?.();
        return;
      }
      wasRunning = true;
      timer = setTimeout(tick, next.totalMs % 1000 || 1000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [targetIso, offset]);

  return value;
}
