import type { SaleStatus } from './types';

export type StockStats = {
  status: SaleStatus;
  availableStock: number;
  unsold: number | null;
  held: number;
  pending: number;
  sold: number;
};

export function stockRows(stats: StockStats): { label: string; value: number }[] {
  const remaining = stats.status === 'ENDED' ? (stats.unsold ?? stats.availableStock) : stats.availableStock;
  return [
    { label: stats.status === 'ENDED' ? 'Unsold' : 'Available', value: remaining },
    { label: 'Held', value: stats.held },
    { label: 'Pending payment', value: stats.pending },
    { label: 'Sold', value: stats.sold },
  ];
}

export function outboxRows(outbox: { pending: number; sent: number; failed: number }): { label: string; value: number }[] {
  return [
    { label: 'Pending', value: outbox.pending },
    { label: 'Sent', value: outbox.sent },
    { label: 'Failed', value: outbox.failed },
  ];
}
