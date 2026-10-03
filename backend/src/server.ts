import http from 'node:http';
import { createApp } from './app';
import { config } from './config';
import { prisma } from './db';
import { startTicker } from './jobs/saleTicker';

const server = http.createServer(createApp());
let stopTicker: (() => void) | undefined;

server.listen(config.PORT, () => {
  console.log(`Backend listening on port ${config.PORT}`);
  stopTicker = startTicker();
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  stopTicker?.();
  server.close(() => {
    prisma.$disconnect().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
