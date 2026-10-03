import type { SaleStatus } from '@prisma/client';
import { prisma } from '../../src/db';

let counter = 0;

export async function createUser(username = `user${++counter}`) {
  return prisma.user.create({
    data: { username, email: `${username}@example.test` },
  });
}

export async function createUsers(count: number) {
  const users = [];
  for (let i = 0; i < count; i++) users.push(await createUser());
  return users;
}

export async function createProduct() {
  return prisma.product.create({
    data: { name: 'Test product', description: 'Test', imageUrl: 'https://example.test/p.png' },
  });
}

export async function createSale(opts: {
  totalStock: number;
  availableStock?: number;
  startsAt: Date;
  endsAt: Date;
  status?: SaleStatus;
  priceCents?: number;
}) {
  const product = await createProduct();
  return prisma.sale.create({
    data: {
      productId: product.id,
      priceCents: opts.priceCents ?? 1000,
      totalStock: opts.totalStock,
      availableStock: opts.availableStock ?? opts.totalStock,
      startsAt: opts.startsAt,
      endsAt: opts.endsAt,
      status: opts.status ?? 'ACTIVE',
    },
  });
}
