import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { resetDb } from './helpers/db';
import { createSale } from './helpers/factories';
import { outcome } from './helpers/http';
import { close, listen } from './helpers/server';

const NOW = new Date('2026-01-01T12:00:00Z');
const MINUTE = 60_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

let clock = NOW;
let server: Server;

beforeAll(async () => {
  server = await listen(createApp({ now: () => clock }));
});

afterAll(async () => {
  await close(server);
  await prisma.$disconnect();
});

beforeEach(async () => {
  clock = NOW;
  await resetDb();
});

const current = () => request(server).get('/api/sales/current');

describe('GET /api/sales/current', () => {
  it('(j) returns the sale with its product, stock and serverTime from the injected clock', async () => {
    const sale = await createSale({
      totalStock: 7,
      priceCents: 2599,
      startsAt: at(MINUTE),
      endsAt: at(11 * MINUTE),
      status: 'SCHEDULED',
    });
    const product = await prisma.product.findUniqueOrThrow({ where: { id: sale.productId } });

    const res = await current();

    expect(outcome(res)).toBe('200 OK');
    expect(res.body).toEqual({
      sale: {
        id: sale.id,
        status: 'SCHEDULED',
        priceCents: 2599,
        availableStock: 7,
        startsAt: at(MINUTE).toISOString(),
        endsAt: at(11 * MINUTE).toISOString(),
        product: {
          id: product.id,
          name: product.name,
          description: product.description,
          imageUrl: product.imageUrl,
        },
      },
      serverTime: NOW.toISOString(),
    });

    clock = at(42_000);
    expect((await current()).body.serverTime).toBe(at(42_000).toISOString());
  });

  it('(j) returns 404 SALE_NOT_FOUND when there are no sales', async () => {
    expect(outcome(await current())).toBe('404 SALE_NOT_FOUND');
  });

  it('(j) picks the non-ENDED sale over a later ENDED one', async () => {
    const scheduled = await createSale({ totalStock: 5, startsAt: at(MINUTE), endsAt: at(11 * MINUTE), status: 'SCHEDULED' });
    await createSale({ totalStock: 5, startsAt: at(20 * MINUTE), endsAt: at(30 * MINUTE), status: 'ENDED' });

    const res = await current();

    expect(outcome(res)).toBe('200 OK');
    expect(res.body.sale).toMatchObject({ id: scheduled.id, status: 'SCHEDULED' });
  });

  it('(j) picks the ACTIVE sale when an ENDED one was created after it', async () => {
    const active = await createSale({ totalStock: 5, startsAt: at(-MINUTE), endsAt: at(9 * MINUTE), status: 'ACTIVE' });
    await createSale({ totalStock: 5, startsAt: at(-30 * MINUTE), endsAt: at(-20 * MINUTE), status: 'ENDED' });

    expect((await current()).body.sale).toMatchObject({ id: active.id, status: 'ACTIVE' });
  });

  it('(j) returns the latest ENDED sale when all sales have ended', async () => {
    await createSale({ totalStock: 5, startsAt: at(-60 * MINUTE), endsAt: at(-50 * MINUTE), status: 'ENDED' });
    const latest = await createSale({ totalStock: 2, startsAt: at(-20 * MINUTE), endsAt: at(-10 * MINUTE), status: 'ENDED' });
    await createSale({ totalStock: 5, startsAt: at(-40 * MINUTE), endsAt: at(-30 * MINUTE), status: 'ENDED' });

    const res = await current();

    expect(outcome(res)).toBe('200 OK');
    expect(res.body.sale).toMatchObject({ id: latest.id, status: 'ENDED', availableStock: 2 });
  });
});
