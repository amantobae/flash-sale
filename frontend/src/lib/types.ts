export type SaleStatus = 'SCHEDULED' | 'ACTIVE' | 'ENDED';
export type ReservationStatus = 'ACTIVE' | 'PAYMENT_PENDING' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';
export type OrderStatus = 'PENDING' | 'PAID' | 'FAILED';
export type PaymentStatus = 'SUCCESS' | 'FAILED' | 'PENDING';

export type Product = { id: number; name: string; description: string; imageUrl: string };

export type Sale = {
  id: number;
  status: SaleStatus;
  priceCents: number;
  availableStock: number;
  startsAt: string;
  endsAt: string;
  product: Product;
};

export type Reservation = {
  id: number;
  saleId: number;
  userId: number;
  quantity: number;
  status: ReservationStatus;
  expiresAt: string;
  createdAt: string;
};

export type Order = {
  id: number;
  userId: number;
  saleId: number;
  reservationId: number;
  amountCents: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus | null;
  paymentId: number | null;
  createdAt: string;
};

export type Payment = {
  id: number;
  orderId: number;
  status: PaymentStatus;
  idempotencyKey: string;
  createdAt: string;
};

export type User = { id: number; username: string; email: string; role: string };

export type SaleStockEvent = { saleId: number; availableStock: number };
export type SaleStatusEvent = { saleId: number; status: SaleStatus; startsAt: string; endsAt: string; serverTime: string };
export type ReservationUpdatedEvent = { reservationId: number; status: ReservationStatus };
export type OrderUpdatedEvent = { orderId: number; status: OrderStatus };
