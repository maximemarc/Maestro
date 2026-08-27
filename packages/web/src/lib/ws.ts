/**
 * Client WebSocket avec reconnexion exponentielle. Chaque message est un
 * ServerEvent JSON, appliqué au store.
 */
import type { ServerEvent } from '@maestro/shared';
import { getToken } from './api';
import { useStore } from './store';

let socket: WebSocket | null = null;
let retryDelay = 1000;
let stopped = false;

export function connectWs(): void {
  stopped = false;
  openSocket();
}

export function disconnectWs(): void {
  stopped = true;
  socket?.close();
  socket = null;
}

function openSocket(): void {
  const token = getToken();
  if (!token || stopped) return;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(
    `${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}`,
  );

  socket.onopen = () => {
    retryDelay = 1000;
    useStore.getState().setConnected(true);
  };

  socket.onmessage = (msg) => {
    try {
      const event = JSON.parse(String(msg.data)) as ServerEvent;
      useStore.getState().applyEvent(event);
    } catch {
      // Message illisible : ignoré.
    }
  };

  socket.onclose = () => {
    useStore.getState().setConnected(false);
    socket = null;
    if (!stopped) {
      setTimeout(openSocket, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    }
  };

  socket.onerror = () => {
    socket?.close();
  };
}
