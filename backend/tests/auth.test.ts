import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { resetDb } from './helpers/db';
import { createSale, createUser } from './helpers/factories';

const NOW = new Date('2026-01-01T12:00:00Z');
const app = createApp({ now: () => NOW });

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/users/login', () => {
  it('creates a user with a generated email', async () => {
    const res = await request(app).post('/api/users/login').send({ username: 'alice' });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'alice', email: 'alice@example.test' });
    expect(typeof res.body.user.id).toBe('number');
    expect(await prisma.user.count()).toBe(1);
  });

  it('returns the same user on repeated login', async () => {
    const first = await request(app).post('/api/users/login').send({ username: 'bob' });
    const second = await request(app).post('/api/users/login').send({ username: 'bob' });

    expect(second.status).toBe(200);
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(await prisma.user.count()).toBe(1);
  });

  it('rejects an empty username with 400', async () => {
    const res = await request(app).post('/api/users/login').send({ username: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('X-User-Id auth middleware', () => {
  async function reserveAs(header: string | undefined) {
    const sale = await createSale({
      totalStock: 1,
      startsAt: new Date(NOW.getTime() - 60_000),
      endsAt: new Date(NOW.getTime() + 60_000),
    });
    const req = request(app).post(`/api/sales/${sale.id}/reservations`);
    return header === undefined ? req : req.set('X-User-Id', header);
  }

  it('returns 401 without the header', async () => {
    const res = await reserveAs(undefined);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for a non-numeric id', async () => {
    const res = await reserveAs('abc');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for a user that does not exist', async () => {
    const res = await reserveAs('999');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('lets an existing user through', async () => {
    const user = await createUser();
    const res = await reserveAs(String(user.id));
    expect(res.status).toBe(201);
  });
});
