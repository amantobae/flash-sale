import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireUser } from '../../auth';
import { parseOrThrow } from '../../validation';
import { reserve } from './service';

const saleParams = z.object({
  id: z.coerce.number().int().positive(),
});

export function reservationRoutes({ now }: { now: () => Date }) {
  const router = Router();

  router.post('/api/sales/:id/reservations', requireUser, async (req, res) => {
    const { id: saleId } = parseOrThrow(saleParams, req.params);
    const { reservation } = await reserve(saleId, currentUser(res).id, now());
    res.status(201).json({
      reservation: {
        id: reservation.id,
        saleId: reservation.saleId,
        userId: reservation.userId,
        quantity: reservation.quantity,
        status: reservation.status,
        expiresAt: reservation.expiresAt,
        createdAt: reservation.createdAt,
      },
    });
  });

  return router;
}
