export type Countdown = { totalMs: number; minutes: number; seconds: number; done: boolean };

export function clockOffset(serverTimeIso: string, clientNowMs: number): number {
  return Date.parse(serverTimeIso) - clientNowMs;
}

export function serverNow(offset: number, clientNowMs: number): number {
  return clientNowMs + offset;
}

export function countdown(targetIso: string, nowMs: number): Countdown {
  const totalMs = Math.max(0, Date.parse(targetIso) - nowMs);
  // Round up so the display only shows 00:00 when the target is actually reached.
  const wholeSeconds = Math.ceil(totalMs / 1000);
  return {
    totalMs,
    minutes: Math.floor(wholeSeconds / 60),
    seconds: wholeSeconds % 60,
    done: totalMs === 0,
  };
}
