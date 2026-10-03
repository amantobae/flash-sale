import express from 'express';
import { prisma } from './db';
import { AppError, errorHandler, notFoundHandler } from './errors';
import { reservationRoutes } from './modules/reservations/routes';
import { userRoutes } from './modules/users/routes';

export type AppOptions = {
  now?: () => Date;
};

export function createApp({ now = () => new Date() }: AppOptions = {}) {
  const app = express();
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new AppError(503, 'DB_UNAVAILABLE', 'Database is not reachable');
    }
    res.json({ status: 'ok', db: 'ok' });
  });

  app.use(userRoutes());
  app.use(reservationRoutes({ now }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
