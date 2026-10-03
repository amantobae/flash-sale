import http from 'node:http';
import { createApp } from './app';
import { config } from './config';
import { prisma } from './db';

const server = http.createServer(createApp());

server.listen(config.PORT, () => {
  console.log(`Backend listening on port ${config.PORT}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    prisma.$disconnect().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
