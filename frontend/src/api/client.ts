import type { Order, Payment, PaymentStatus, Reservation, Sale, User } from '../lib/types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// sessionStorage, not localStorage: every tab is its own session, so two tabs can be two users.
const USER_KEY = 'flashSale.user';

export function loadSession(): User | null {
  const raw = sessionStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function saveSession(user: User): void {
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  sessionStorage.removeItem(USER_KEY);
}

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

// crypto.randomUUID only exists in secure contexts (https or localhost).
export function newUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type RequestOptions = { method?: string; body?: unknown; idempotencyKey?: string };

async function request<T>(path: string, { method = 'GET', body, idempotencyKey }: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const user = loadSession();
  if (user) headers['X-User-Id'] = String(user.id);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Network error');
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new ApiError(
      res.status,
      data?.error?.code ?? 'HTTP_ERROR',
      data?.error?.message ?? `Request failed with status ${res.status}`,
    );
    if (res.status === 401 && user) {
      clearSession();
      onUnauthorized?.();
    }
    throw error;
  }
  return data as T;
}

export const api = {
  login: (username: string) => request<{ user: User }>('/api/users/login', { method: 'POST', body: { username } }),
  getCurrentSale: () => request<{ sale: Sale; serverTime: string }>('/api/sales/current'),
  reserve: (saleId: number) =>
    request<{ reservation: Reservation }>(`/api/sales/${saleId}/reservations`, { method: 'POST' }),
  getMyReservation: () => request<{ reservation: Reservation | null; serverTime: string }>('/api/reservations/me'),
  cancelReservation: (id: number) => request<{ reservation: Reservation }>(`/api/reservations/${id}`, { method: 'DELETE' }),
  checkout: (reservationId: number, idempotencyKey: string, outcome: PaymentStatus) =>
    request<{ order: Order; payment: Payment }>(`/api/reservations/${reservationId}/checkout`, {
      method: 'POST',
      body: { outcome },
      idempotencyKey,
    }),
  getMyOrders: () => request<{ orders: Order[] }>('/api/orders/me'),
  resolvePayment: (paymentId: number, status: 'SUCCESS' | 'FAILED') =>
    request<{ order: Order; payment: Payment }>(`/api/payments/${paymentId}/resolve`, {
      method: 'POST',
      body: { status },
    }),
};

const MESSAGES: Record<string, string> = {
  SOLD_OUT: 'Sold out: the last unit has just been taken.',
  SALE_NOT_ACTIVE: 'The sale is not open right now.',
  ALREADY_RESERVED: 'You already have this item in your cart.',
  SALE_NOT_FOUND: 'There is no sale right now.',
  RESERVATION_NOT_FOUND: 'This cart no longer exists.',
  RESERVATION_NOT_ACTIVE: 'This cart can no longer be changed.',
  RESERVATION_EXPIRED: 'Your cart has expired.',
  IDEMPOTENCY_KEY_REUSED: 'This payment attempt belongs to another cart.',
  PAYMENT_NOT_FOUND: 'Payment not found.',
  UNAUTHORIZED: 'Your session has ended, please log in again.',
  NETWORK_ERROR: 'Network error. Check the connection and try again.',
};

export function describeError(err: unknown): string {
  if (err instanceof ApiError) return MESSAGES[err.code] ?? err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}
