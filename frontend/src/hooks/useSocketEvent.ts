import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';

export function useSocketEvent<T>(socket: Socket, event: string, handler: (payload: T) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (payload: T) => handlerRef.current(payload);
    socket.on(event, listener);
    return () => {
      socket.off(event, listener);
    };
  }, [socket, event]);
}
