import { Router } from 'express';
import { currentUser, requireUser } from '../../auth';
import { orderDto } from '../payments/routes';
import { listUserOrders } from './service';

export function orderRoutes() {
  const router = Router();

  router.get('/api/orders/me', requireUser, async (_req, res) => {
    const orders = await listUserOrders(currentUser(res).id);
    res.json({
      orders: orders.map(({ payments, ...order }) => ({
        ...orderDto(order),
        paymentStatus: payments[0]?.status ?? null,
        paymentId: payments[0]?.id ?? null,
      })),
    });
  });

  return router;
}
