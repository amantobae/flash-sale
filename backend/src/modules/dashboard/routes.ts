import type { Sale } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { parseOrThrow } from '../../validation';
import { createDashboardSale, getDashboard, updateDashboardSale } from './service';

const idParams = z.object({
  id: z.coerce.number().int().positive(),
});

const instant = z.coerce.date().refine((d) => !Number.isNaN(d.getTime()), { message: 'Invalid date' });

const saleBody = z
  .object({
    priceCents: z.number().int().min(1),
    totalStock: z.number().int().min(1),
    startsAt: instant,
    endsAt: instant,
    productId: z.number().int().positive().optional(),
  })
  .refine((value) => value.endsAt.getTime() > value.startsAt.getTime(), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

function saleDto(sale: Sale) {
  return {
    id: sale.id,
    productId: sale.productId,
    priceCents: sale.priceCents,
    totalStock: sale.totalStock,
    availableStock: sale.availableStock,
    status: sale.status,
    startsAt: sale.startsAt,
    endsAt: sale.endsAt,
  };
}

export function dashboardRoutes({ now }: { now: () => Date }) {
  const router = Router();

  router.get('/api/dashboard/sales/:id', async (req, res) => {
    const { id } = parseOrThrow(idParams, req.params);
    res.json(await getDashboard(id, now()));
  });

  router.post('/api/dashboard/sales', async (req, res) => {
    const body = parseOrThrow(saleBody, req.body);
    const sale = await createDashboardSale(body);
    res.status(201).json({ sale: saleDto(sale) });
  });

  router.put('/api/dashboard/sales/:id', async (req, res) => {
    const { id } = parseOrThrow(idParams, req.params);
    const body = parseOrThrow(saleBody, req.body);
    const sale = await updateDashboardSale(id, body, now());
    res.json({ sale: saleDto(sale) });
  });

  return router;
}
