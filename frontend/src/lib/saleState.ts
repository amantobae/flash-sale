import type { Sale, SaleStatusEvent, SaleStockEvent } from './types';

export type SaleUiState = 'SCHEDULED' | 'OPEN' | 'ENDED';

// Mirrors the server's sale condition: status != ENDED AND startsAt <= now < endsAt.
export function saleUiState(sale: Pick<Sale, 'status' | 'startsAt' | 'endsAt'>, serverNowMs: number): SaleUiState {
  if (sale.status === 'ENDED' || serverNowMs >= Date.parse(sale.endsAt)) return 'ENDED';
  if (serverNowMs >= Date.parse(sale.startsAt)) return 'OPEN';
  return 'SCHEDULED';
}

export function applySaleStock(sale: Sale | null, event: SaleStockEvent): Sale | null {
  if (!sale || sale.id !== event.saleId) return sale;
  return { ...sale, availableStock: event.availableStock };
}

export function applySaleStatus(sale: Sale | null, event: SaleStatusEvent): Sale | null {
  if (!sale || sale.id !== event.saleId) return sale;
  return { ...sale, status: event.status, startsAt: event.startsAt, endsAt: event.endsAt };
}
