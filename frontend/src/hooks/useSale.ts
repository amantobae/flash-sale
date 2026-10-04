import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import { orderNotice, reservationNotice, saleStatusNotice } from '../lib/notices';
import type { PaymentAttempt } from '../lib/paymentAttempt';
import { applySaleStatus, applySaleStock, saleUiState } from '../lib/saleState';
import { clockOffset, serverNow } from '../lib/time';
import type {
  Order,
  OrderUpdatedEvent,
  Reservation,
  ReservationUpdatedEvent,
  Sale,
  SaleStatusEvent,
  SaleStockEvent,
  User,
} from '../lib/types';
import { getSocket, joinRoom } from '../socket';
import { useSocketEvent } from './useSocketEvent';

export type Notice = { id: number; text: string };

const MAX_NOTICES = 5;
const NOTICE_TTL_MS = 15_000;

export function useSale(user: User) {
  const socket = getSocket();
  const [sale, setSaleState] = useState<Sale | null>(null);
  const [saleMissing, setSaleMissing] = useState(false);
  const [offset, setOffset] = useState(0);
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [connected, setConnected] = useState(socket.connected);

  // Refs give socket handlers the latest values without re-subscribing.
  const saleRef = useRef<Sale | null>(null);
  const offsetRef = useRef(0);
  const reservationRef = useRef<Reservation | null>(null);
  const joinedSaleId = useRef<number | null>(null);
  const noticeSeq = useRef(0);
  // Survives switching between pages; a reload starts a new attempt.
  const paymentAttempt = useRef<PaymentAttempt>(null);

  const setSale = useCallback((next: Sale | null) => {
    saleRef.current = next;
    setSaleState(next);
  }, []);

  const updateOffset = useCallback((serverTime: string) => {
    const next = clockOffset(serverTime, Date.now());
    offsetRef.current = next;
    setOffset(next);
  }, []);

  const putReservation = useCallback((next: Reservation | null) => {
    reservationRef.current = next;
    setReservation(next);
  }, []);

  const notify = useCallback((text: string) => {
    const id = ++noticeSeq.current;
    setNotices((list) => [...list, { id, text }].slice(-MAX_NOTICES));
    setTimeout(() => setNotices((list) => list.filter((n) => n.id !== id)), NOTICE_TTL_MS);
  }, []);

  const dismissNotice = useCallback((id: number) => {
    setNotices((list) => list.filter((n) => n.id !== id));
  }, []);

  const refetchSale = useCallback(async (): Promise<Sale | null> => {
    try {
      const { sale: next, serverTime } = await api.getCurrentSale();
      updateOffset(serverTime);
      setSale(next);
      setSaleMissing(false);
      return next;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SALE_NOT_FOUND') {
        setSale(null);
        setSaleMissing(true);
        return null;
      }
      console.warn('GET /api/sales/current failed', err);
      return saleRef.current;
    }
  }, [setSale, updateOffset]);

  const refetchCart = useCallback(async () => {
    try {
      const { reservation: next, serverTime } = await api.getMyReservation();
      updateOffset(serverTime);
      putReservation(next);
    } catch (err) {
      console.warn('GET /api/reservations/me failed', err);
    }
  }, [putReservation, updateOffset]);

  const refetchOrders = useCallback(async () => {
    try {
      setOrders((await api.getMyOrders()).orders);
    } catch (err) {
      console.warn('GET /api/orders/me failed', err);
    }
  }, []);

  const joinSale = useCallback(
    async (saleId: number) => {
      if (joinedSaleId.current === saleId) return;
      if (await joinRoom(socket, 'sale:join', { saleId })) joinedSaleId.current = saleId;
      else notify('Live updates for the sale are unavailable, reload the page');
    },
    [socket, notify],
  );

  // On every connect (the first one and each reconnect): join the rooms, then reload state over REST,
  // so anything missed while disconnected is picked up.
  useEffect(() => {
    const onConnect = async () => {
      setConnected(true);
      joinedSaleId.current = null;
      const saleId = saleRef.current?.id ?? (await refetchSale())?.id;
      const joins = [joinRoom(socket, 'user:join', { userId: user.id })];
      if (saleId) joins.push(joinSale(saleId).then(() => true));
      const [userJoined] = await Promise.all(joins);
      if (!userJoined) notify('Live updates for your cart are unavailable, reload the page');
      await Promise.all([refetchSale(), refetchCart(), refetchOrders()]);
    };
    const onDisconnect = () => setConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    if (socket.connected) void onConnect();
    else socket.connect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [socket, user.id, refetchSale, refetchCart, refetchOrders, joinSale, notify]);

  // A different sale (e.g. a new one seeded after the previous ended) needs its own room.
  useEffect(() => {
    if (connected && sale && joinedSaleId.current !== null && joinedSaleId.current !== sale.id) {
      void joinSale(sale.id).then(() => refetchSale());
    }
  }, [connected, sale, joinSale, refetchSale]);

  useSocketEvent<SaleStockEvent>(socket, 'sale:stock', (event) => {
    setSale(applySaleStock(saleRef.current, event));
  });

  useSocketEvent<SaleStatusEvent>(socket, 'sale:status', (event) => {
    const current = saleRef.current;
    if (!current || current.id !== event.saleId) {
      void refetchSale();
      return;
    }
    const text = saleStatusNotice(current.status, event.status);
    setSale(applySaleStatus(current, event));
    if (text) notify(text);
  });

  useSocketEvent<ReservationUpdatedEvent>(socket, 'reservation:updated', (event) => {
    const current = saleRef.current;
    const saleEnded = current !== null && saleUiState(current, serverNow(offsetRef.current, Date.now())) === 'ENDED';
    const text = reservationNotice(event.status, saleEnded);
    if (text) notify(text);

    const cart = reservationRef.current;
    if (cart && cart.id === event.reservationId) {
      const finished = event.status === 'EXPIRED' || event.status === 'CANCELLED' || event.status === 'COMPLETED';
      putReservation(finished ? null : { ...cart, status: event.status });
    }
    void refetchCart();
  });

  useSocketEvent<OrderUpdatedEvent>(socket, 'order:updated', (event) => {
    notify(orderNotice(event.orderId, event.status));
    setOrders((list) => list.map((o) => (o.id === event.orderId ? { ...o, status: event.status } : o)));
    void refetchOrders();
  });

  return {
    user,
    sale,
    saleMissing,
    offset,
    reservation,
    orders,
    notices,
    connected,
    paymentAttempt,
    setReservation: putReservation,
    refetchSale,
    refetchCart,
    refetchOrders,
    notify,
    dismissNotice,
  };
}

export type SaleStore = ReturnType<typeof useSale>;
