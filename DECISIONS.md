# Decisions log

- **Project:** Flash Sale (React + Express + Prisma/PostgreSQL + Socket.IO), see [TASK.md](TASK.md) and [ARCHITECTURE.md](ARCHITECTURE.md).
- **Tools:** Claude for planning and prompt drafts, Cursor for code.
- **Cursor model:** Claude Opus 5.5.

Timestamps come from `date "+%Y-%m-%d %H:%M %z"` in the terminal. New entries are appended at the bottom.

## Entries

### 2026-10-03 21:33 +0600 · Step 0: architecture · Prisma over raw `pg`
- **Decision:** Use Prisma as the data layer; row locks are taken via `$queryRaw` with `SELECT ... FOR UPDATE`.
- **Reason:** Prisma gives migrations and generated types, while `$queryRaw` still allows the `FOR UPDATE` row lock needed for stock changes.
- **Alternatives considered:** Raw `pg` with hand-written SQL and migrations.

### 2026-10-03 21:33 +0600 · Step 0: architecture · Socket.IO for realtime
- **Decision:** Use Socket.IO with rooms `sale:{id}`, `user:{id}`, `dashboard`; events are emitted only after the transaction commits.
- **Reason:** Rooms let the server push stock and status to everyone watching a sale, per-user reservation and order updates, and dashboard updates without page reloads. Scaling later is possible via the Redis adapter.
- **Alternatives considered:** Plain WebSocket (`ws`), polling.

### 2026-10-03 21:33 +0600 · Step 0: architecture · Row lock on Sale instead of optimistic locking
- **Decision:** Every stock or sale status change runs in `prisma.$transaction` after `SELECT ... FROM "Sale" WHERE id = $1 FOR UPDATE`; a `CHECK (available_stock >= 0 AND available_stock <= total_stock)` is the last line of defence.
- **Reason:** All operations on one sale (reserve, cancel, expire, pay, start, end) queue on one row lock, so the check and the decrement happen atomically and the last unit cannot be sold twice.
- **Alternatives considered:** Optimistic locking (version column + retry).

### 2026-10-03 21:33 +0600 · Step 0: architecture · Keep `availableStock` after ENDED instead of `withdrawnStock`
- **Decision:** When a sale ends, `availableStock` is not reset to zero; after `ENDED` it means "unsold stock" and the dashboard shows it as Unsold.
- **Reason:** The invariant `availableStock + held + sold = totalStock` holds always, including after the sale ends; the number stays honest and the `ENDED` status alone forbids reserving those units.
- **Alternatives considered:** Zeroing `availableStock` and tracking a separate `withdrawnStock` field.

### 2026-10-03 21:33 +0600 · Step 0: architecture · `PAYMENT_PENDING` never expires
- **Decision:** Neither the 10-minute timer nor sale end touches `PAYMENT_PENDING`; the ticker selects only `status = ACTIVE`. The only exit is payment resolve (SUCCESS → `COMPLETED`, FAILED → `CANCELLED` with the unit returned).
- **Reason:** A payment started before the hold expired must be able to finish, and a hung payment must not return the unit to the storefront or let it be sold twice. Unresolved payments hold stock indefinitely; this is deliberate and they are visible on the dashboard.
- **Alternatives considered:** Timeout for hung PENDING payments (out of scope).

### 2026-10-03 21:33 +0600 · Step 0: architecture · EmailOutbox with two UNIQUE keys
- **Decision:** Emails are written to `EmailOutbox` in the same transaction as the state change, with `UNIQUE(orderId, type)` and `UNIQUE(reservationId, type)`, inserted with `ON CONFLICT DO NOTHING`; the dispatcher claims rows atomically `PENDING → SENDING`.
- **Reason:** Guarantees exactly one email per order and per cleared cart. The second key is needed because a cleared cart has no order (`orderId = NULL`) and Postgres treats all NULLs as distinct, so `UNIQUE(orderId, type)` would not deduplicate those rows. Sending outside the transaction means a rollback sends nothing and a mailer failure does not affect order state.
- **Alternatives considered:** Sending email directly from the HTTP request or transaction.

### 2026-10-03 21:33 +0600 · Step 0: architecture · 1-second ticker
- **Decision:** One `setInterval` with a 1 s period runs start sales, end sales, expire reservations, dispatch emails; a `running` flag skips a tick if the previous one has not finished.
- **Reason:** Simple single-instance job; steps are idempotent. The up-to-1 s lag is covered because reserve and checkout check `startsAt <= now < endsAt` and `expiresAt > now` themselves, independent of the ticker.
- **Alternatives considered:** Job queue / scheduler, per-reservation timers.

### 2026-10-03 21:33 +0600 · Step 0: architecture · `now` taken in Node and passed as a parameter
- **Decision:** Time is taken only on the server in Node and passed as a `now` parameter into service and ticker functions; the client receives `serverTime` to correct its timers.
- **Reason:** Tests call ticker steps and services directly with a controlled `now`, without fake timers; the server is the single source of truth for time, so an early click on the client cannot start a purchase.
- **Alternatives considered:** Database `now()`, fake timers in tests.

### 2026-10-03 21:33 +0600 · Step 0: process files
- **Decision:** Added `.cursor/rules/project.mdc`, `DECISIONS.md`, `.gitignore`, committed `TASK.md`.
- **Reason:** Fix the working process (test-first, small steps, decision log, commit format) before writing application code.
- **Alternatives considered:** None.
- **Known issues / not done:** No application code yet (intentional).

### 2026-10-03 21:53 +0600 · Step 1: skeleton · Library versions pinned to Node 20 compatible lines
- **Decision:** Exact versions: Prisma 6.19.3, Express 5.2.1, zod 4.6.5, TypeScript 5.9.3, tsx 4.23.15, Vitest 3.2.7, Supertest 7.3.1, Vite 6.4.3, @vitejs/plugin-react 4.7.0, React 19.3.0. Docker images: `node:20-bookworm-slim`, `postgres:16-alpine`.
- **Reason:** The host has Node 20.16. Prisma 7+/8 need Node >= 22.18 (and Prisma 7 changes client setup to driver adapters + `prisma.config.ts`), Vitest 5 and Vite 8 need Node >= 22.12, TypeScript 7 is the native rewrite. The chosen lines are current, stable and run on Node 20. Express 5 forwards rejected promises from async handlers to the error middleware, so no wrapper is needed.
- **Alternatives considered:** Upgrade Node to 22 and use the latest majors; Express 4 with an async wrapper.

### 2026-10-03 21:53 +0600 · Step 1: skeleton · Prisma client setup and module system
- **Decision:** One `PrismaClient` in `src/db.ts` (generator `prisma-client-js`, output in `node_modules`), `datasourceUrl` taken from `config.ts` which validates env with zod and fails fast. Backend compiles to CommonJS (`module: NodeNext` without `"type": "module"`), so relative imports need no `.js` suffix. `/health` runs `SELECT 1` and returns 503 `DB_UNAVAILABLE` on failure.
- **Reason:** A single client keeps one connection pool; validating env once gives a clear startup error instead of a failure on the first query.
- **Alternatives considered:** ESM backend with `.js` import suffixes; reading `process.env` directly.

### 2026-10-03 21:53 +0600 · Step 1: skeleton · Schema naming, ids, and `Order.createdAt` (deviation)
- **Decision:** Tables keep the model names (`"Sale"`, `"Reservation"`, ...), columns are snake_case via `@map` (`available_stock`), ids are `Int` autoincrement, timestamps use Prisma's default `TIMESTAMP(3)` (UTC). **Deviation from ARCHITECTURE.md:** `Order` has an extra `createdAt` column; ARCHITECTURE.md sections 2 and 3 were updated in the same commit.
- **Reason:** Matches the project rule `SELECT ... FROM "Sale" WHERE id = $1 FOR UPDATE` and the CHECK on `available_stock`. Int ids avoid uuid/text parameter casts in raw SQL. `Order.createdAt` is needed to sort orders in the buyer's account and to show recent orders on the dashboard.
- **Alternatives considered:** UUID ids; ordering orders by id.

### 2026-10-03 21:53 +0600 · Step 1: skeleton · CHECK constraint in a separate SQL migration
- **Decision:** `Sale_available_stock_check` (`available_stock >= 0 AND available_stock <= total_stock`) lives in its own migration `sale_stock_check`, created with `migrate dev --create-only` and filled by hand.
- **Reason:** Prisma schema cannot express CHECK constraints; Prisma ignores them when diffing, so later `migrate dev` runs do not drop it (verified: no drift after applying).
- **Alternatives considered:** Putting the constraint into the init migration.

### 2026-10-03 21:53 +0600 · Step 1: skeleton · How tests get and reset the database
- **Decision:** Tests use `TEST_DATABASE_URL` (default `postgresql://flash:flash@localhost:5433/flash_sale_test`) and refuse to run unless the database name ends with `_test`. Vitest `globalSetup` runs `prisma migrate deploy` against it once per run; tests that need a clean state call `resetDb()` in `beforeEach`, which does `TRUNCATE ... RESTART IDENTITY CASCADE` on all tables except `_prisma_migrations`. Test files run sequentially (`fileParallelism: false`); concurrency inside a test (`Promise.all`) is unaffected. `postgres-test` stores data on tmpfs, so a container restart gives an empty database.
- **Reason:** `migrate deploy` is non-destructive and is the same command the backend container runs. TRUNCATE is fast and keeps the schema. Files share one database, so parallel files would truncate each other's data.
- **Alternatives considered:** `prisma migrate reset --force` per run (destructive; Prisma 6.x also blocks it when invoked by AI agents); a separate schema or database per test file.

### 2026-10-03 21:53 +0600 · Step 1: skeleton · Frontend talks to backend through the Vite proxy
- **Decision:** The frontend calls relative `/health`; Vite proxies it to `BACKEND_URL` (default `http://localhost:3000`, `http://backend:3000` in compose) in both `vite` dev and `vite preview`. The frontend container builds the app and serves it with `vite preview`.
- **Reason:** Same-origin requests, so the backend needs no CORS middleware; the container also verifies that the production build works.
- **Alternatives considered:** CORS on the backend; nginx serving the static build.

### 2026-10-03 21:53 +0600 · Step 1: skeleton · Compose startup order and line endings
- **Decision:** Both Postgres services have `pg_isready` healthchecks; backend waits for `postgres` healthy, runs `prisma migrate deploy`, then `exec node dist/server.js`; backend has its own healthcheck (`fetch /health`), and frontend waits for backend healthy. The backend image keeps dev dependencies because the Prisma CLI is needed at runtime for `migrate deploy`. `.gitattributes` forces LF.
- **Reason:** Without the backend healthcheck the first proxied request hit a backend that was still applying migrations (seen in the first `docker compose up`). LF keeps migration files byte-identical between Windows checkouts and Linux containers.
- **Alternatives considered:** Multi-stage image with only production deps plus `prisma` as a runtime dependency.

### 2026-10-03 21:53 +0600 · Step 1: skeleton · Process deviation: tests after implementation
- **Decision:** In this step the tests were added in the last code commit, after the skeleton, schema and frontend.
- **Reason:** The requested commit order was compose, backend skeleton, schema+migration, frontend, tests. `/health` and the CHECK constraint were verified manually before the tests were added. From step 2 on, tests come first as the project rules require.
- **Alternatives considered:** None.
- **Known issues / not done:** `npm audit` in `backend/` reports 3 high-severity findings in `deepmerge-ts` pulled in by the Prisma CLI (dev dependency, only merges config); the suggested fix is a downgrade to Prisma 6.12 or a move to Prisma 8, neither done. The frontend page was checked over HTTP only (no browser screenshot). The backend image is single-stage and includes dev dependencies. No frontend tests. Reservations, payments, sockets, ticker, emails and seed data are intentionally not implemented.
