import type http from 'node:http';
import type { OrderStatus, ReservationStatus, SaleStatus } from '@prisma/client';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';

const DASHBOARD_ROOM = 'dashboard';
const saleRoom = (saleId: number) => `sale:${saleId}`;
const userRoom = (userId: number) => `user:${userId}`;

const id = z.number().int().positive();
const saleJoin = z.object({ saleId: id });
const userJoin = z.object({ userId: id });

type Ack = (response: { ok: boolean }) => void;

let io: Server | null = null;

// Socket.IO passes the ack callback as the last argument when the client asked for one.
function splitAck(args: unknown[]): { payload: unknown; ack?: Ack } {
  const last = args[args.length - 1];
  if (typeof last === 'function') return { payload: args.length > 1 ? args[0] : undefined, ack: last as Ack };
  return { payload: args[0] };
}

function onJoin(socket: Socket, event: string, roomFor: (payload: unknown) => string | null) {
  socket.on(event, (...args: unknown[]) => {
    const { payload, ack } = splitAck(args);
    const room = roomFor(payload);
    if (room) socket.join(room);
    ack?.({ ok: room !== null });
  });
}

export function initRealtime(httpServer: http.Server): Server {
  io = new Server(httpServer);
  io.on('connection', (socket) => {
    onJoin(socket, 'sale:join', (payload) => {
      const parsed = saleJoin.safeParse(payload);
      return parsed.success ? saleRoom(parsed.data.saleId) : null;
    });
    onJoin(socket, 'user:join', (payload) => {
      const parsed = userJoin.safeParse(payload);
      return parsed.success ? userRoom(parsed.data.userId) : null;
    });
    onJoin(socket, 'dashboard:join', () => DASHBOARD_ROOM);
  });
  return io;
}

// Also closes the http server passed to initRealtime.
export async function closeRealtime(): Promise<void> {
  const current = io;
  io = null;
  await current?.close();
}

export function emitSaleStock(payload: { saleId: number; availableStock: number }): void {
  io?.to([saleRoom(payload.saleId), DASHBOARD_ROOM]).emit('sale:stock', payload);
}

export function emitSaleStatus(payload: {
  saleId: number;
  status: SaleStatus;
  startsAt: Date;
  endsAt: Date;
  serverTime: Date;
}): void {
  io?.to([saleRoom(payload.saleId), DASHBOARD_ROOM]).emit('sale:status', {
    saleId: payload.saleId,
    status: payload.status,
    startsAt: payload.startsAt.toISOString(),
    endsAt: payload.endsAt.toISOString(),
    serverTime: payload.serverTime.toISOString(),
  });
}

export function emitReservationUpdated(
  userId: number,
  payload: { reservationId: number; status: ReservationStatus },
): void {
  io?.to(userRoom(userId)).emit('reservation:updated', payload);
}

export function emitOrderUpdated(userId: number, payload: { orderId: number; status: OrderStatus }): void {
  io?.to([userRoom(userId), DASHBOARD_ROOM]).emit('order:updated', payload);
}
