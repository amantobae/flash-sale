import { Router } from 'express';
import { getCurrentSale, type SaleWithProduct } from './service';

function toDto(sale: SaleWithProduct) {
  return {
    id: sale.id,
    status: sale.status,
    priceCents: sale.priceCents,
    availableStock: sale.availableStock,
    startsAt: sale.startsAt,
    endsAt: sale.endsAt,
    product: {
      id: sale.product.id,
      name: sale.product.name,
      description: sale.product.description,
      imageUrl: sale.product.imageUrl,
    },
  };
}

export function saleRoutes({ now }: { now: () => Date }) {
  const router = Router();

  router.get('/api/sales/current', async (_req, res) => {
    const serverTime = now();
    const sale = await getCurrentSale();
    res.json({ sale: toDto(sale), serverTime });
  });

  return router;
}
