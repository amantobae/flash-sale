import type { Reservation } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireUser } from '../../auth';
import { parseOrThrow } from '../../validation';
import { cancelReservation, getCurrentReservation, reserve } from './service';

const idParams = z.object({
  id: z.coerce.number().int().positive(),
});

function toDto(reservation: Reservation) {
  return {
    id: reservation.id,
    saleId: reservation.saleId,
    userId: reservation.userId,
    quantity: reservation.quantity,
    status: reservation.status,
    expiresAt: reservation.expiresAt,
    createdAt: reservation.createdAt,
  };
}

export function reservationRoutes({ now }: { now: () => Date }) {
  const router = Router();

  router.post('/api/sales/:id/reservations', requireUser, async (req, res) => {
    const { id: saleId } = parseOrThrow(idParams, req.params);
    const { reservation } = await reserve(saleId, currentUser(res).id, now());
    res.status(201).json({ reservation: toDto(reservation) });
  });

  router.get('/api/reservations/me', requireUser, async (_req, res) => {
    const serverTime = now();
    const reservation = await getCurrentReservation(currentUser(res).id);
    res.json({ reservation: reservation ? toDto(reservation) : null, serverTime });
  });

  router.delete('/api/reservations/:id', requireUser, async (req, res) => {
    const { id } = parseOrThrow(idParams, req.params);
    const { reservation } = await cancelReservation(id, currentUser(res).id);
    res.json({ reservation: toDto(reservation) });
  });

  return router;
}
