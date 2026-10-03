import type { Sale } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../src/db';

const SECOND = 1000;

export const DEMO_PRODUCT = {
  name: 'Limited Edition Sneakers',
  description: 'Demo flash sale item: a limited batch at a special price.',
  imageUrl: 'https://picsum.photos/seed/flash-sale/600/400',
};

export type SeedOptions = {
  now: Date;
  stock?: number;
  startsInMs?: number;
  durationMs?: number;
  priceCents?: number;
};

// Keeps an existing non-ENDED sale, so running the seed twice does not create a second one.
export async function seedDemo({
  now,
  stock = 10,
  startsInMs = 60 * SECOND,
  durationMs = 10 * 60 * SECOND,
  priceCents = 4999,
}: SeedOptions): Promise<{ sale: Sale; created: boolean }> {
  const existing = await prisma.sale.findFirst({ where: { status: { not: 'ENDED' } }, orderBy: { id: 'asc' } });
  if (existing) return { sale: existing, created: false };

  const product =
    (await prisma.product.findFirst({ where: { name: DEMO_PRODUCT.name }, orderBy: { id: 'asc' } })) ??
    (await prisma.product.create({ data: DEMO_PRODUCT }));
  const startsAt = new Date(now.getTime() + startsInMs);
  const sale = await prisma.sale.create({
    data: {
      productId: product.id,
      priceCents,
      totalStock: stock,
      availableStock: stock,
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationMs),
      status: 'SCHEDULED',
    },
  });
  return { sale, created: true };
}

const seedEnv = z.object({
  SEED_STOCK: z.coerce.number().int().positive().default(10),
  SEED_STARTS_IN_SECONDS: z.coerce.number().int().nonnegative().default(60),
  SEED_DURATION_SECONDS: z.coerce.number().int().positive().default(600),
  SEED_PRICE_CENTS: z.coerce.number().int().positive().default(4999),
});

async function main() {
  const env = seedEnv.parse(process.env);
  const { sale, created } = await seedDemo({
    now: new Date(),
    stock: env.SEED_STOCK,
    startsInMs: env.SEED_STARTS_IN_SECONDS * SECOND,
    durationMs: env.SEED_DURATION_SECONDS * SECOND,
    priceCents: env.SEED_PRICE_CENTS,
  });
  const verb = created ? 'Created' : 'Kept existing';
  console.log(
    `${verb} sale ${sale.id} (${sale.status}): stock ${sale.availableStock}/${sale.totalStock}, ` +
      `${sale.priceCents} cents, ${sale.startsAt.toISOString()} - ${sale.endsAt.toISOString()}`,
  );
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
