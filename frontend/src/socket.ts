import { io, type Socket } from 'socket.io-client';

const ACK_TIMEOUT_MS = 5000;

let socket: Socket | null = null;

// One socket per tab. Same origin: the Vite proxy forwards /socket.io to the backend.
export function getSocket(): Socket {
  socket ??= io({ autoConnect: false });
  return socket;
}

// The server has no "leave" events, so a logout drops the socket and the next user gets a fresh one.
export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}

export async function joinRoom(target: Socket, event: 'sale:join' | 'user:join', payload: object): Promise<boolean> {
  try {
    const ack = (await target.timeout(ACK_TIMEOUT_MS).emitWithAck(event, payload)) as { ok?: boolean } | undefined;
    if (ack?.ok) return true;
    console.warn(`${event} rejected`, payload);
  } catch (err) {
    console.warn(`${event} got no ack`, err);
  }
  return false;
}
