import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { endSales, expireReservations } from '../src/jobs/saleTicker';
import { resetDb } from './helpers/db';
import { createProduct, createSale, createUsers } from './helpers/factories';
import {
  cancelRequest,
  checkoutRequest,
  createSaleRequest,
  dashboardRequest,
  outcome,
  reserveRequest,
  updateSaleRequest,
} from './helpers/http';
import { assertStockInvariant } from './helpers/invariant';
import { type Client, connect, join, type RealtimeServer, startRealtimeServer } from './helpers/realtime';
import { close, listen } from './helpers/server';

const NOW = new Date('2026-01-01T12:00:00Z');
const MINUTE = 60_000;
const HOLD_MS = 10 * MINUTE;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const openWindow = { startsAt: at(-30 * MINUTE), endsAt: at(30 * MINUTE) };

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

async function reserveFor(saleId: number, userId: number): Promise<number> {
  const res = await reserveRequest(server, saleId, userId);
  expect(outcome(res)).toBe('201 OK');
  return res.body.reservation.id;
}

function saleBody(overrides: Record<string, unknown> = {}) {
  return {
    priceCents: 4999,
    totalStock: 10,
    startsAt: at(MINUTE).toISOString(),
    endsAt: at(11 * MINUTE).toISOString(),
    ...overrides,
  };
}

describe('GET /api/dashboard/sales/:id', () => {
  it('(g) held / pending / sold / revenue match a mix of reserve, cancel, expire and checkout; invariant holds; unsold after end', async () => {
    const sale = await createSale({ totalStock: 10, priceCents: 1000, ...openWindow });
    const [canceler, expirer, buyer, pendingOwner, failedOwner, holder] = await createUsers(6);

    const cancelled = await reserveFor(sale.id, canceler.id);
    expect(outcome(await cancelRequest(server, cancelled, canceler.id))).toBe('200 OK');

    await reserveFor(sale.id, expirer.id);
    await expireReservations(at(HOLD_MS));

    expect(outcome(await checkoutRequest(server, await reserveFor(sale.id, buyer.id), buyer.id, 'SUCCESS'))).toBe(
      '200 OK',
    );
    expect(
      outcome(await checkoutRequest(server, await reserveFor(sale.id, pendingOwner.id), pendingOwner.id, 'PENDING')),
    ).toBe('200 OK');
    expect(
      outcome(await checkoutRequest(server, await reserveFor(sale.id, failedOwner.id), failedOwner.id, 'FAILED')),
    ).toBe('200 OK');
    await reserveFor(sale.id, holder.id);

    const res = await dashboardRequest(server, sale.id);
    expect(outcome(res)).toBe('200 OK');
    expect(res.body).toMatchObject({
      availableStock: 6,
      unsold: null,
      held: 2,
      pending: 1,
      sold: 1,
      revenueCents: 1000,
      outbox: { pending: 1, sent: 0, failed: 0 },
    });
    expect(res.body.availableStock + res.body.held + res.body.pending + res.body.sold).toBe(10);
    expect(res.body.sale).toMatchObject({
      id: sale.id,
      status: 'ACTIVE',
      priceCents: 1000,
      totalStock: 10,
      availableStock: 6,
    });
    expect(res.body.serverTime).toBe(NOW.toISOString());
    await assertStockInvariant(sale.id);

    await endSales(openWindow.endsAt);
    const ended = await dashboardRequest(server, sale.id);
    expect(ended.body).toMatchObject({
      availableStock: 8,
      unsold: 8,
      held: 0,
      pending: 1,
      sold: 1,
      revenueCents: 1000,
    });
    expect(ended.body.unsold).toBe(ended.body.availableStock);
    expect(ended.body.availableStock + ended.body.held + ended.body.pending + ended.body.sold).toBe(10);
    await assertStockInvariant(sale.id);
  });

  it('(h) revenue counts only PAID orders; recentOrders is the last 20, newest first, with username and status', async () => {
    const sale = await createSale({ totalStock: 25, priceCents: 1000, ...openWindow });
    const users = await createUsers(22);

    expect(outcome(await checkoutRequest(server, await reserveFor(sale.id, users[0].id), users[0].id, 'PENDING'))).toBe(
      '200 OK',
    );
    expect(outcome(await checkoutRequest(server, await reserveFor(sale.id, users[1].id), users[1].id, 'FAILED'))).toBe(
      '200 OK',
    );

    const paidIds: number[] = [];
    for (let i = 2; i < 22; i++) {
      clock = at(i * 1000);
      const paid = await checkoutRequest(server, await reserveFor(sale.id, users[i].id), users[i].id, 'SUCCESS');
      expect(outcome(paid)).toBe('200 OK');
      paidIds.push(paid.body.order.id);
    }

    clock = NOW;
    const res = await dashboardRequest(server, sale.id);
    expect(outcome(res)).toBe('200 OK');
    expect(res.body.revenueCents).toBe(20 * 1000);
    expect(res.body.recentOrders).toHaveLength(20);
    expect(res.body.recentOrders.map((o: { id: number }) => o.id)).toEqual([...paidIds].reverse().slice(0, 20));
    expect(res.body.recentOrders[0]).toMatchObject({
      id: paidIds[19],
      username: users[21].username,
      status: 'PAID',
      amountCents: 1000,
    });
    expect(res.body.recentOrders.some((o: { status: string }) => o.status !== 'PAID')).toBe(false);
    await assertStockInvariant(sale.id);
  });

  it('returns 404 SALE_NOT_FOUND for an unknown sale', async () => {
    expect(outcome(await dashboardRequest(server, 999))).toBe('404 SALE_NOT_FOUND');
  });
});

describe('POST /api/dashboard/sales and PUT /api/dashboard/sales/:id', () => {
  it('POST creates a SCHEDULED sale with availableStock = totalStock', async () => {
    const product = await createProduct();
    const res = await createSaleRequest(server, saleBody({ productId: product.id }));

    expect(outcome(res)).toBe('201 OK');
    expect(res.body.sale).toMatchObject({
      productId: product.id,
      priceCents: 4999,
      totalStock: 10,
      availableStock: 10,
      status: 'SCHEDULED',
      startsAt: at(MINUTE).toISOString(),
      endsAt: at(11 * MINUTE).toISOString(),
    });
  });

  it('POST reuses the latest sale product when productId is omitted', async () => {
    const existing = await createSale({ totalStock: 3, ...openWindow });
    const res = await createSaleRequest(server, saleBody());

    expect(outcome(res)).toBe('201 OK');
    expect(res.body.sale.productId).toBe(existing.productId);
  });

  it('POST without any product returns 404 PRODUCT_NOT_FOUND', async () => {
    expect(outcome(await createSaleRequest(server, saleBody()))).toBe('404 PRODUCT_NOT_FOUND');
  });

  it('(i) PUT on a non-SCHEDULED sale is 409; invalid dates and stock are 400', async () => {
    const active = await createSale({ totalStock: 3, ...openWindow, status: 'ACTIVE' });
    const ended = await createSale({
      totalStock: 3,
      startsAt: at(-20 * MINUTE),
      endsAt: at(-10 * MINUTE),
      status: 'ENDED',
    });
    const scheduled = await createSale({
      totalStock: 5,
      startsAt: at(MINUTE),
      endsAt: at(11 * MINUTE),
      status: 'SCHEDULED',
    });

    expect(outcome(await updateSaleRequest(server, active.id, saleBody()))).toBe('409 SALE_NOT_EDITABLE');
    expect(outcome(await updateSaleRequest(server, ended.id, saleBody()))).toBe('409 SALE_NOT_EDITABLE');
    expect(
      outcome(
        await updateSaleRequest(
          server,
          scheduled.id,
          saleBody({ startsAt: at(11 * MINUTE).toISOString(), endsAt: at(MINUTE).toISOString() }),
        ),
      ),
    ).toBe('400 VALIDATION_ERROR');
    expect(outcome(await updateSaleRequest(server, scheduled.id, saleBody({ totalStock: 0 })))).toBe(
      '400 VALIDATION_ERROR',
    );
    expect(outcome(await createSaleRequest(server, saleBody({ endsAt: at(MINUTE).toISOString() })))).toBe(
      '400 VALIDATION_ERROR',
    );
  });
});

describe('dashboard realtime on configure', () => {
  let rt: RealtimeServer;
  let clients: Client[] = [];

  beforeAll(async () => {
    rt = await startRealtimeServer(() => clock);
  });

  afterAll(async () => {
    await rt.stop();
  });

  afterEach(() => {
    for (const c of clients) c.socket.disconnect();
    clients = [];
  });

  it('(i) a successful time change emits sale:status to the sale room and the dashboard', async () => {
    const sale = await createSale({
      totalStock: 5,
      startsAt: at(MINUTE),
      endsAt: at(11 * MINUTE),
      status: 'SCHEDULED',
    });
    const room = await connect(rt.url);
    const dashboard = await connect(rt.url);
    clients.push(room, dashboard);
    await join(room, 'sale:join', { saleId: sale.id });
    await join(dashboard, 'dashboard:join');

    const startsAt = at(2 * MINUTE);
    const endsAt = at(12 * MINUTE);
    const res = await updateSaleRequest(
      rt.server,
      sale.id,
      saleBody({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }),
    );
    expect(outcome(res)).toBe('200 OK');

    await Promise.all([room.flush(), dashboard.flush()]);
    const status = [
      'sale:status',
      {
        saleId: sale.id,
        status: 'SCHEDULED',
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        serverTime: NOW.toISOString(),
      },
    ];
    expect(room.events).toEqual([status]);
    expect(dashboard.events).toContainEqual(status);
    expect(dashboard.events).toContainEqual(['dashboard:changed', { saleId: sale.id }]);
  });
});
