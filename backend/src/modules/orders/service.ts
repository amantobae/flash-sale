import { prisma } from '../../db';

export async function listUserOrders(userId: number) {
  return prisma.order.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      payments: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { status: true } },
    },
  });
}
