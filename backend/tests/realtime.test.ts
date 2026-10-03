import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { endSales, expireReservations, startSales } from '../src/jobs/saleTicker';
import { resetDb } from './helpers/db';
import { createSale, createUser, createUsers } from './helpers/factories';
import { cancelRequest, checkoutRequest, outcome, reserveRequest, resolveRequest } from './helpers/http';
import { assertStockInvariant } from './helpers/invariant';
import {
  clearAll,
  type Client,
  connect,
  flushAll,
  join,
  type RealtimeServer,
  startRealtimeServer,
} from './helpers/realtime';

const NOW = new Date('2026-01-01T12:00:00Z');
const MINUTE = 60_000;
const HOLD_MS = 10 * MINUTE;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const openWindow = { startsAt: at(-30 * MINUTE), endsAt: at(30 * MINUTE) };

let clock = NOW;
let rt: RealtimeServer;
let clients: Client[] = [];

beforeAll(async () => {
  rt = await startRealtimeServer(() => clock);
});

afterAll(async () => {
  await rt.stop();
  await prisma.$disconnect();
});

beforeEach(async () => {
  clock = NOW;
  await resetDb();
});

afterEach(() => {
  for (const c of clients) c.socket.disconnect();
  clients = [];
});

async function client(...rooms: Array<[event: 'sale:join' | 'user:join' | 'dashboard:join', payload?: unknown]>) {
  const c = await connect(rt.url);
  clients.push(c);
  for (const [event, payload] of rooms) await join(c, event, payload);
  return c;
}

const saleRoom = (saleId: number) => ['sale:join', { saleId }] as const;
const userRoom = (userId: number) => ['user:join', { userId }] as const;
const dashboardRoom = ['dashboard:join'] as const;

async function reserveFor(saleId: number, userId: number): Promise<number> {
  const res = await reserveRequest(rt.server, saleId, userId);
  expect(outcome(res)).toBe('201 OK');
  return res.body.reservation.id;
}

const stock = (saleId: number, availableStock: number) => ['sale:stock', { saleId, availableStock }];
const reservationUpdated = (reservationId: number, status: string) => [
  'reservation:updated',
  { reservationId, status },
];
const orderUpdated = (orderId: number, status: string) => ['order:updated', { orderId, status }];

// Installs a trigger that raises at COMMIT, after the whole transaction callback has run.
async function failCommitsOn(table: 'Reservation' | 'Payment') {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_fail_on_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced failure at commit';
    END
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE CONSTRAINT TRIGGER test_fail_on_commit AFTER INSERT ON "${table}"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_on_commit()
  `);
  return async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_on_commit ON "${table}"`);
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_on_commit()');
  };
}

describe('realtime: sale:stock on reserve', () => {
  it('(a) two clients in sale:{id} and the dashboard receive sale:stock with the new availableStock', async () => {
    const sale = await createSale({ totalStock: 5, ...openWindow });
    const user = await createUser();
    const first = await client(saleRoom(sale.id));
    const second = await client(saleRoom(sale.id));
    const dashboard = await client(dashboardRoom);

    await reserveFor(sale.id, user.id);
    await flushAll(first, second, dashboard);

    expect(first.events).toEqual([stock(sale.id, 4)]);
    expect(second.events).toEqual([stock(sale.id, 4)]);
    expect(dashboard.events).toEqual([stock(sale.id, 4)]);
    await assertStockInvariant(sale.id);
  });

  it('a client in both sale:{id} and dashboard receives sale:stock once', async () => {
    const sale = await createSale({ totalStock: 5, ...openWindow });
    const user = await createUser();
    const both = await client(saleRoom(sale.id), dashboardRoom);

    await reserveFor(sale.id, user.id);
    await both.flush();

    expect(both.events).toEqual([stock(sale.id, 4)]);
  });

  it('(b) a client not in the room receives nothing', async () => {
    const saleA = await createSale({ totalStock: 5, ...openWindow });
    const saleB = await createSale({ totalStock: 5, ...openWindow });
    const user = await createUser();
    const inA = await client(saleRoom(saleA.id));
    const inB = await client(saleRoom(saleB.id));
    const noRoom = await client();

    await reserveFor(saleA.id, user.id);
    await flushAll(inA, inB, noRoom);

    expect(inA.events).toEqual([stock(saleA.id, 4)]);
    expect(inB.events).toEqual([]);
    expect(noRoom.events).toEqual([]);
    await assertStockInvariant(saleA.id);
  });

  it('(c) 409 ALREADY_RESERVED, SOLD_OUT and SALE_NOT_ACTIVE emit nothing', async () => {
    const sale = await createSale({ totalStock: 1, ...openWindow });
    const closed = await createSale({ totalStock: 1, startsAt: at(MINUTE), endsAt: at(10 * MINUTE), status: 'SCHEDULED' });
    const [a, b] = await createUsers(2);
    const watcher = await client(saleRoom(sale.id), saleRoom(closed.id), dashboardRoom);

    await reserveFor(sale.id, a.id);
    await watcher.flush();
    expect(watcher.events).toEqual([stock(sale.id, 0)]);
    watcher.clear();

    expect(outcome(await reserveRequest(rt.server, sale.id, a.id))).toBe('409 ALREADY_RESERVED');
    expect(outcome(await reserveRequest(rt.server, sale.id, b.id))).toBe('409 SOLD_OUT');
    expect(outcome(await reserveRequest(rt.server, closed.id, b.id))).toBe('409 SALE_NOT_ACTIVE');
    await watcher.flush();

    expect(watcher.events).toEqual([]);
    await assertStockInvariant(sale.id);
    await assertStockInvariant(closed.id);
  });
});

describe('realtime: cart lifecycle', () => {
  it('(d) cancel: sale:stock to the room, reservation:updated only to the owner', async () => {
    const sale = await createSale({ totalStock: 5, ...openWindow });
    const [owner, other] = await createUsers(2);
    const ownerClient = await client(saleRoom(sale.id), userRoom(owner.id));
    const otherClient = await client(saleRoom(sale.id), userRoom(other.id));
    const reservationId = await reserveFor(sale.id, owner.id);
    await flushAll(ownerClient, otherClient);
    clearAll(ownerClient, otherClient);

    expect(outcome(await cancelRequest(rt.server, reservationId, owner.id))).toBe('200 OK');
    await flushAll(ownerClient, otherClient);

    expect(ownerClient.events).toEqual([stock(sale.id, 5), reservationUpdated(reservationId, 'CANCELLED')]);
    expect(otherClient.events).toEqual([stock(sale.id, 5)]);
    await assertStockInvariant(sale.id);
  });

  it('a cancel that returns 409 emits nothing', async () => {
    const sale = await createSale({ totalStock: 5, ...openWindow });
    const owner = await createUser();
    const reservationId = await reserveFor(sale.id, owner.id);
    expect(outcome(await cancelRequest(rt.server, reservationId, owner.id))).toBe('200 OK');
    const ownerClient = await client(saleRoom(sale.id), userRoom(owner.id));

    expect(outcome(await cancelRequest(rt.server, reservationId, owner.id))).toBe('409 RESERVATION_NOT_ACTIVE');
    await ownerClient.flush();

    expect(ownerClient.events).toEqual([]);
  });

  it('(e) expireReservations(now + 10 min) emits sale:stock and reservation:updated EXPIRED to the owner', async () => {
    const sale = await createSale({ totalStock: 5, ...openWindow });
    const [owner, other] = await createUsers(2);
    const reservationId = await reserveFor(sale.id, owner.id);
    const room = await client(saleRoom(sale.id));
    const ownerClient = await client(userRoom(owner.id));
    const otherClient = await client(userRoom(other.id));

    await expireReservations(at(HOLD_MS));
    await flushAll(room, ownerClient, otherClient);

    expect(room.events).toEqual([stock(sale.id, 5)]);
    expect(ownerClient.events).toEqual([reservationUpdated(reservationId, 'EXPIRED')]);
    expect(otherClient.events).toEqual([]);
    await assertStockInvariant(sale.id);

    clearAll(room, ownerClient);
    await expireReservations(at(HOLD_MS + MINUTE));
    await flushAll(room, ownerClient);
    expect(room.events).toEqual([]);
    expect(ownerClient.events).toEqual([]);
  });
});

describe('realtime: sale start and end', () => {
  it('(f) startSales emits sale:status ACTIVE with serverTime; endSales emits ENDED, unsold stock and clears carts', async () => {
    const startsAt = at(MINUTE);
    const endsAt = at(11 * MINUTE);
    const sale = await createSale({ totalStock: 5, startsAt, endsAt, status: 'SCHEDULED' });
    const [a, b, pendingOwner] = await createUsers(3);
    const room = await client(saleRoom(sale.id));
    const dashboard = await client(dashboardRoom);

    await startSales(startsAt);
    await flushAll(room, dashboard);
    const activeStatus = [
      'sale:status',
      {
        saleId: sale.id,
        status: 'ACTIVE',
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        serverTime: startsAt.toISOString(),
      },
    ];
    expect(room.events).toEqual([activeStatus]);
    expect(dashboard.events).toEqual([activeStatus]);

    clearAll(room, dashboard);
    await startSales(at(2 * MINUTE));
    await flushAll(room, dashboard);
    expect(room.events).toEqual([]);

    clock = at(2 * MINUTE);
    const resA = await reserveFor(sale.id, a.id);
    const resB = await reserveFor(sale.id, b.id);
    const resPending = await reserveFor(sale.id, pendingOwner.id);
    const pending = await checkoutRequest(rt.server, resPending, pendingOwner.id, 'PENDING');
    expect(outcome(pending)).toBe('200 OK');

    const aClient = await client(userRoom(a.id));
    const bClient = await client(userRoom(b.id));
    const pendingClient = await client(userRoom(pendingOwner.id));
    await flushAll(room, dashboard);
    clearAll(room, dashboard);

    const endedAt = at(11 * MINUTE);
    await endSales(endedAt);
    await flushAll(room, dashboard, aClient, bClient, pendingClient);

    const endedStatus = [
      'sale:status',
      {
        saleId: sale.id,
        status: 'ENDED',
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        serverTime: endedAt.toISOString(),
      },
    ];
    expect(room.events).toEqual([endedStatus, stock(sale.id, 4)]);
    expect(dashboard.events).toEqual([endedStatus, stock(sale.id, 4)]);
    expect(aClient.events).toEqual([reservationUpdated(resA, 'EXPIRED')]);
    expect(bClient.events).toEqual([reservationUpdated(resB, 'EXPIRED')]);
    expect(pendingClient.events).toEqual([]);
    await assertStockInvariant(sale.id);

    clearAll(room, dashboard, aClient);
    await endSales(at(12 * MINUTE));
    await flushAll(room, dashboard, aClient);
    expect(room.events).toEqual([]);
    expect(dashboard.events).toEqual([]);
    expect(aClient.events).toEqual([]);
  });
});

describe('realtime: payments', () => {
  it('(g) checkout SUCCESS emits order:updated to the user room and the dashboard; a replay emits nothing', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const [owner, other] = await createUsers(2);
    const reservationId = await reserveFor(sale.id, owner.id);
    const ownerClient = await client(userRoom(owner.id));
    const otherClient = await client(userRoom(other.id));
    const dashboard = await client(dashboardRoom);
    const room = await client(saleRoom(sale.id));
    const key = randomUUID();

    const paid = await checkoutRequest(rt.server, reservationId, owner.id, 'SUCCESS', key);
    expect(outcome(paid)).toBe('200 OK');
    const orderId = paid.body.order.id;
    await flushAll(ownerClient, otherClient, dashboard, room);

    expect(ownerClient.events).toEqual([orderUpdated(orderId, 'PAID'), reservationUpdated(reservationId, 'COMPLETED')]);
    expect(dashboard.events).toEqual([orderUpdated(orderId, 'PAID')]);
    expect(otherClient.events).toEqual([]);
    expect(room.events).toEqual([]);

    clearAll(ownerClient, dashboard);
    expect(outcome(await checkoutRequest(rt.server, reservationId, owner.id, 'SUCCESS', key))).toBe('200 OK');
    expect(outcome(await checkoutRequest(rt.server, reservationId, owner.id, 'SUCCESS'))).toBe('200 OK');
    await flushAll(ownerClient, dashboard, room);
    expect(ownerClient.events).toEqual([]);
    expect(dashboard.events).toEqual([]);
    expect(room.events).toEqual([]);
    await assertStockInvariant(sale.id);
  });

  it('(g) checkout PENDING, then resolve FAILED emits sale:stock; a repeated resolve emits nothing', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const owner = await createUser();
    const reservationId = await reserveFor(sale.id, owner.id);
    const ownerClient = await client(userRoom(owner.id));
    const dashboard = await client(dashboardRoom);
    const room = await client(saleRoom(sale.id));

    const pending = await checkoutRequest(rt.server, reservationId, owner.id, 'PENDING');
    expect(outcome(pending)).toBe('200 OK');
    const orderId = pending.body.order.id;
    await flushAll(ownerClient, dashboard, room);
    expect(ownerClient.events).toEqual([
      orderUpdated(orderId, 'PENDING'),
      reservationUpdated(reservationId, 'PAYMENT_PENDING'),
    ]);
    expect(dashboard.events).toEqual([orderUpdated(orderId, 'PENDING')]);
    expect(room.events).toEqual([]);
    clearAll(ownerClient, dashboard);

    expect(outcome(await resolveRequest(rt.server, pending.body.payment.id, 'FAILED'))).toBe('200 OK');
    await flushAll(ownerClient, dashboard, room);
    expect(ownerClient.events).toEqual([
      orderUpdated(orderId, 'FAILED'),
      reservationUpdated(reservationId, 'CANCELLED'),
    ]);
    expect(dashboard.events).toEqual([orderUpdated(orderId, 'FAILED'), stock(sale.id, 3)]);
    expect(room.events).toEqual([stock(sale.id, 3)]);
    await assertStockInvariant(sale.id);

    clearAll(ownerClient, dashboard, room);
    expect(outcome(await resolveRequest(rt.server, pending.body.payment.id, 'FAILED'))).toBe('200 OK');
    expect(outcome(await resolveRequest(rt.server, pending.body.payment.id, 'SUCCESS'))).toBe('200 OK');
    await flushAll(ownerClient, dashboard, room);
    expect(ownerClient.events).toEqual([]);
    expect(dashboard.events).toEqual([]);
    expect(room.events).toEqual([]);
    await assertStockInvariant(sale.id);
  });

  it('resolve SUCCESS emits order:updated PAID and reservation:updated COMPLETED, no sale:stock', async () => {
    const sale = await createSale({ totalStock: 3, ...openWindow });
    const owner = await createUser();
    const reservationId = await reserveFor(sale.id, owner.id);
    const pending = await checkoutRequest(rt.server, reservationId, owner.id, 'PENDING');
    const ownerClient = await client(userRoom(owner.id));
    const room = await client(saleRoom(sale.id));

    expect(outcome(await resolveRequest(rt.server, pending.body.payment.id, 'SUCCESS'))).toBe('200 OK');
    await flushAll(ownerClient, room);

    expect(ownerClient.events).toEqual([
      orderUpdated(pending.body.order.id, 'PAID'),
      reservationUpdated(reservationId, 'COMPLETED'),
    ]);
    expect(room.events).toEqual([]);
    await assertStockInvariant(sale.id);
  });
});

describe('realtime: rollback', () => {
  it('(h) reserve whose transaction fails at commit emits nothing and changes nothing', async () => {
    const sale = await createSale({ totalStock: 5, ...openWindow });
    const user = await createUser();
    const room = await client(saleRoom(sale.id), userRoom(user.id), dashboardRoom);

    const restore = await failCommitsOn('Reservation');
    try {
      const res = await reserveRequest(rt.server, sale.id, user.id);
      expect(outcome(res)).toBe('500 INTERNAL_ERROR');
    } finally {
      await restore();
    }
    await room.flush();

    expect(room.events).toEqual([]);
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } })).availableStock).toBe(5);
    expect(await prisma.reservation.count()).toBe(0);
    await assertStockInvariant(sale.id);
  });

  it('(h) checkout whose transaction fails at commit emits nothing and changes nothing', async () => {
    const sale = await createSale({ totalStock: 5, ...openWindow });
    const user = await createUser();
    const reservationId = await reserveFor(sale.id, user.id);
    const room = await client(saleRoom(sale.id), userRoom(user.id), dashboardRoom);

    const restore = await failCommitsOn('Payment');
    try {
      const res = await checkoutRequest(rt.server, reservationId, user.id, 'SUCCESS');
      expect(outcome(res)).toBe('500 INTERNAL_ERROR');
    } finally {
      await restore();
    }
    await room.flush();

    expect(room.events).toEqual([]);
    expect(await prisma.order.count()).toBe(0);
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } })).status).toBe('ACTIVE');
    await assertStockInvariant(sale.id);
  });
});

describe('realtime: join validation', () => {
  it('(i) invalid join payloads are ignored and do not crash the server', async () => {
    const sale = await createSale({ totalStock: 5, ...openWindow });
    const user = await createUser();
    const c = await client();

    const invalid: Array<['sale:join' | 'user:join', unknown]> = [
      ['sale:join', null],
      ['sale:join', 'garbage'],
      ['sale:join', { saleId: 'x' }],
      ['sale:join', { saleId: -1 }],
      ['sale:join', { saleId: 1.5 }],
      ['sale:join', [sale.id]],
      ['user:join', {}],
      ['user:join', { userId: String(user.id) }],
    ];
    for (const [event, payload] of invalid) {
      c.socket.emit(event, payload);
      expect(await c.socket.timeout(2000).emitWithAck(event, payload)).toEqual({ ok: false });
    }
    c.socket.emit('sale:join');
    c.socket.emit('user:join');
    c.socket.emit('sale:join', { saleId: 'x' }, 'not a function');
    c.socket.emit('unknown:event', { saleId: sale.id });
    await c.flush();

    expect(c.socket.connected).toBe(true);
    expect((await request(rt.server).get('/health')).status).toBe(200);

    await reserveFor(sale.id, user.id);
    await c.flush();
    expect(c.events).toEqual([]);

    const valid = await client(saleRoom(sale.id));
    const other = await createUser();
    await reserveFor(sale.id, other.id);
    await valid.flush();
    expect(valid.events).toEqual([stock(sale.id, 3)]);
  });
});
