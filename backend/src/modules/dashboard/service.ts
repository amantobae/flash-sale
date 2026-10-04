import { prisma } from '../../db';
import { AppError } from '../../errors';
import { emitDashboardChanged, emitSaleStatus, emitSaleStock } from '../../realtime/socket';

export type SaleInput = {
  priceCents: number;
  totalStock: number;
  startsAt: Date;
  endsAt: Date;
  productId?: number;
};

type StockCounts = { held: number; pending: number; sold: number };
type RevenueRow = { revenue: number };
type OutboxRow = { pending: number; sent: number; failed: number };

async function resolveProductId(productId?: number): Promise<number> {
  if (productId !== undefined) {
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', `Product ${productId} not found`);
    return product.id;
  }
  const latest = await prisma.sale.findFirst({ orderBy: { id: 'desc' }, select: { productId: true } });
  if (!latest) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'No product found');
  return latest.productId;
}

export async function getDashboard(saleId: number, now: Date) {
  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    include: { product: { select: { name: true } } },
  });
  if (!sale) throw new AppError(404, 'SALE_NOT_FOUND', `Sale ${saleId} not found`);

  const [counts] = await prisma.$queryRaw<StockCounts[]>`
    SELECT
      COALESCE(SUM(quantity) FILTER (WHERE status = 'ACTIVE'), 0)::int AS held,
      COALESCE(SUM(quantity) FILTER (WHERE status = 'PAYMENT_PENDING'), 0)::int AS pending,
      COALESCE(SUM(quantity) FILTER (WHERE status = 'COMPLETED'), 0)::int AS sold
    FROM "Reservation"
    WHERE sale_id = ${saleId}
  `;
  const [rev] = await prisma.$queryRaw<RevenueRow[]>`
    SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status = 'PAID'), 0)::int AS revenue
    FROM "Order"
    WHERE sale_id = ${saleId}
  `;
  const [outbox] = await prisma.$queryRaw<OutboxRow[]>`
    SELECT
      COUNT(*) FILTER (WHERE e.status IN ('PENDING', 'SENDING'))::int AS pending,
      COUNT(*) FILTER (WHERE e.status = 'SENT')::int AS sent,
      COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failed
    FROM "EmailOutbox" e
    LEFT JOIN "Order" o ON o.id = e.order_id
    LEFT JOIN "Reservation" r ON r.id = e.reservation_id
    WHERE COALESCE(o.sale_id, r.sale_id) = ${saleId}
  `;
  const recent = await prisma.order.findMany({
    where: { saleId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
    select: {
      id: true,
      status: true,
      amountCents: true,
      createdAt: true,
      user: { select: { username: true } },
    },
  });

  return {
    sale: {
      id: sale.id,
      status: sale.status,
      priceCents: sale.priceCents,
      totalStock: sale.totalStock,
      availableStock: sale.availableStock,
      startsAt: sale.startsAt,
      endsAt: sale.endsAt,
      productName: sale.product.name,
    },
    availableStock: sale.availableStock,
    unsold: sale.status === 'ENDED' ? sale.availableStock : null,
    held: counts.held,
    pending: counts.pending,
    sold: counts.sold,
    revenueCents: rev.revenue,
    recentOrders: recent.map((order) => ({
      id: order.id,
      username: order.user.username,
      status: order.status,
      amountCents: order.amountCents,
      createdAt: order.createdAt,
    })),
    outbox,
    serverTime: now,
  };
}

export async function createDashboardSale(input: SaleInput) {
  const productId = await resolveProductId(input.productId);
  const sale = await prisma.sale.create({
    data: {
      productId,
      priceCents: input.priceCents,
      totalStock: input.totalStock,
      availableStock: input.totalStock,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: 'SCHEDULED',
    },
  });
  emitDashboardChanged({ saleId: sale.id });
  return sale;
}

type LockedSale = { id: number; status: string; starts_at: Date };

export async function updateDashboardSale(saleId: number, input: SaleInput, now: Date) {
  const result = await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<LockedSale[]>`
      SELECT id, status, starts_at
      FROM "Sale"
      WHERE id = ${saleId}
      FOR UPDATE
    `;
    if (!locked) throw new AppError(404, 'SALE_NOT_FOUND', `Sale ${saleId} not found`);
    if (locked.status !== 'SCHEDULED' || locked.starts_at.getTime() <= now.getTime()) {
      throw new AppError(409, 'SALE_NOT_EDITABLE', 'Only a future SCHEDULED sale can be edited');
    }

    const previous = await tx.sale.findUniqueOrThrow({
      where: { id: saleId },
      select: { startsAt: true, endsAt: true, availableStock: true, totalStock: true },
    });
    const sale = await tx.sale.update({
      where: { id: saleId },
      data: {
        priceCents: input.priceCents,
        totalStock: input.totalStock,
        availableStock: input.totalStock,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      },
    });
    return {
      sale,
      timesChanged:
        previous.startsAt.getTime() !== sale.startsAt.getTime() || previous.endsAt.getTime() !== sale.endsAt.getTime(),
      stockChanged: previous.availableStock !== sale.availableStock || previous.totalStock !== sale.totalStock,
    };
  });

  if (result.timesChanged) {
    emitSaleStatus({
      saleId: result.sale.id,
      status: result.sale.status,
      startsAt: result.sale.startsAt,
      endsAt: result.sale.endsAt,
      serverTime: now,
    });
  }
  if (result.stockChanged) {
    emitSaleStock({ saleId: result.sale.id, availableStock: result.sale.availableStock });
  }
  emitDashboardChanged({ saleId: result.sale.id });
  return result.sale;
}
