import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connectClient, type Socket } from 'socket.io-client';
import { expect } from 'vitest';
import { createApp } from '../../src/app';
import { closeRealtime, initRealtime } from '../../src/realtime/socket';

const ACK_TIMEOUT_MS = 2000;

export type RealtimeServer = {
  server: http.Server;
  url: string;
  stop: () => Promise<void>;
};

export async function startRealtimeServer(now: () => Date): Promise<RealtimeServer> {
  const server = http.createServer(createApp({ now }));
  initRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      await closeRealtime();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type ReceivedEvent = [event: string, payload: unknown];

export type Client = {
  socket: Socket;
  events: ReceivedEvent[];
  // Resolves once every event the server emitted to this socket before the call has arrived.
  flush: () => Promise<void>;
  clear: () => void;
};

export async function connect(url: string): Promise<Client> {
  const socket = connectClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  const events: ReceivedEvent[] = [];
  socket.onAny((event: string, payload: unknown) => events.push([event, payload]));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return {
    socket,
    events,
    // An invalid join is acknowledged with { ok: false } and changes no rooms; packets on one
    // connection arrive in order, so the ack comes after every earlier event.
    flush: async () => {
      await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('sale:join', {});
    },
    clear: () => {
      events.length = 0;
    },
  };
}

export type JoinEvent = 'sale:join' | 'user:join' | 'dashboard:join';

export async function join(client: Client, event: JoinEvent, payload?: unknown): Promise<void> {
  const ack =
    payload === undefined
      ? await client.socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event)
      : await client.socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, payload);
  expect(ack, `${event} ${JSON.stringify(payload)}`).toEqual({ ok: true });
}

export async function flushAll(...clients: Client[]): Promise<void> {
  await Promise.all(clients.map((c) => c.flush()));
}

export function clearAll(...clients: Client[]): void {
  for (const c of clients) c.clear();
}
