const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

export function formatCountdown({ minutes, seconds }: { minutes: number; seconds: number }): string {
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
