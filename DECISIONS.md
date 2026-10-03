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

### 2026-10-03 22:07 +0600 · Step 2: reservations · Clock injected into `createApp`
- **Decision:** `createApp({ now = () => new Date() })` takes a clock; routes call `now()` once per request and pass the value into `reserve(saleId, userId, now)`. Services never read the clock themselves.
- **Reason:** Keeps the "time is a parameter" rule while letting HTTP tests pin the server time, so "exactly at `startsAt` while status is still SCHEDULED" and "exactly at `endsAt`" are tested through real Supertest requests.
- **Alternatives considered:** Fake timers; calling the service directly for the time-window tests.

### 2026-10-03 22:07 +0600 · Step 2: reservations · Prisma pool size for concurrency tests
- **Decision:** `testDatabaseUrl()` appends `connection_limit=30&pool_timeout=20` unless the URL already sets them.
- **Reason:** Each of the 20 parallel reserve requests holds an interactive transaction, and therefore a pooled connection, while it waits on the Sale row lock. Prisma's default pool (`cpus * 2 + 1`) plus the 2 s `maxWait` could produce `P2024` timeouts instead of the expected 409s. 30 stays well under Postgres' default `max_connections = 100`.
- **Alternatives considered:** Raising `maxWait`/`timeout` on `$transaction`; fewer parallel requests.

### 2026-10-03 22:07 +0600 · Step 2: reservations · Check order and error codes
- **Decision:** Inside the transaction, after `SELECT ... FROM "Sale" WHERE id = $1 FOR UPDATE`: sale missing → 404 `SALE_NOT_FOUND`; sale condition (`status != ENDED AND startsAt <= now < endsAt`) → 409 `SALE_NOT_ACTIVE`; existing `ACTIVE`/`PAYMENT_PENDING` reservation → 409 `ALREADY_RESERVED`; `availableStock < 1` → 409 `SOLD_OUT`. Then `availableStock: { decrement: 1 }` and a Reservation with `expiresAt = now + 10 min`. Invalid `X-User-Id` or unknown user → 401 `UNAUTHORIZED`; invalid body or path param → 400 `VALIDATION_ERROR`.
- **Reason:** `ALREADY_RESERVED` is checked before `SOLD_OUT` so a user who holds the last unit and clicks again gets the more accurate error. The decrement is a relative SQL update, so even without the lock the CHECK constraint stops overselling (it fails with 500 instead of 409, as the mutation check below shows).
- **Alternatives considered:** Checking stock before the existing reservation; a partial unique index on active reservations per user and sale.

### 2026-10-03 22:07 +0600 · Step 2: reservations · Post-commit hook and login stub
- **Decision:** `reserve()` calls `afterReserveCommit(result)` only after `prisma.$transaction` resolves; it is empty for now and is where step 5 will emit `sale:stock`. `POST /api/users/login` uses `prisma.user.upsert` on the unique `username` (email `{username}@example.test`); `requireUser` loads the user from `X-User-Id` into `res.locals.user`.
- **Reason:** One named place for side effects keeps socket emits out of the transaction. `upsert` keeps login a single query and idempotent.
- **Alternatives considered:** Emitting inside the transaction callback; find-then-create in two queries for login.

### 2026-10-03 22:07 +0600 · Step 2: reservations · Mutation check without `FOR UPDATE`
- **Decision:** After the tests were green, `FOR UPDATE` was removed temporarily and test (a) (stock 1, 20 parallel users) was run 5 times. It failed in **5 of 5** runs: each run had 1 × 201 but 17–19 × 500 `INTERNAL_ERROR` instead of 19 × 409 `SOLD_OUT` (observed: 19, 17, 19, 18, 19 × 500). The 500s are Postgres `23514`, `Sale_available_stock_check` violations: without the lock every transaction read `available_stock = 1` and tried to decrement. The lock was restored, `git diff` was empty, and the broken version was never committed.
- **Reason:** Proves the test actually detects a missing row lock; the CHECK constraint still prevented an oversell, confirming it works as the last line of defence.
- **Alternatives considered:** None.

### 2026-10-03 22:07 +0600 · Step 2: reservations · Process: red test commit
- **Decision:** The tests were committed on their own before the implementation (all 16 new tests failing with 404 `NOT_FOUND`), followed by the implementation commit and this docs commit.
- **Reason:** Explicitly requested commit order (tests, implementation, docs); it deviates from the "commit only when tests pass" rule for that one commit, but documents test-first in history.
- **Alternatives considered:** Squashing tests and implementation into one commit.
- **Known issues / not done:** No cart cancel, expiry, checkout, payments, sockets, ticker or emails (out of scope for step 2). `GET /api/reservations/me` is not implemented yet. ARCHITECTURE.md is unchanged: no deviations in this step.

### 2026-10-03 22:17 +0600 · Step 3: housekeeping · ARCHITECTURE.md reserve check order
- **Decision:** ARCHITECTURE.md section 4 (reserve, item 2) now lists the checks in the order the code runs them: sale not found → sale condition → `ALREADY_RESERVED` → `SOLD_OUT`, with the reason. Documentation fix only, the code is unchanged.
- **Reason:** The old text listed stock before the existing-reservation check, which did not match `reserve()` from step 2.
- **Alternatives considered:** None.

### 2026-10-03 22:26 +0600 · Step 3: cart lifecycle · `Reservation.createdAt` comes from `now`
- **Decision:** `reserve()` writes `createdAt: now` explicitly instead of relying on the database default `now()`. The schema is unchanged (the default stays for other writers such as test factories).
- **Reason:** `expiresAt` was already `now + 10 min` from the injected clock while `createdAt` was the real database time, so `createdAt + 10 min` did not equal `expiresAt` in tests. Taking both from the same `now` follows the "time is a parameter" rule and makes test (d) exact.
- **Alternatives considered:** Computing the boundary in the test from `expiresAt` instead of `createdAt`.

### 2026-10-03 22:26 +0600 · Step 3: cart lifecycle · Cancel and current cart
- **Decision:** `GET /api/reservations/me` returns `{ reservation, serverTime }`, where `reservation` is the user's newest `ACTIVE`/`PAYMENT_PENDING` reservation or `null`. `DELETE /api/reservations/:id` first reads the reservation without a lock only to find its `saleId` and owner (missing or foreign → 404 `RESERVATION_NOT_FOUND`), then in `prisma.$transaction` locks the Sale row with `FOR UPDATE`, re-reads the reservation, returns 409 `RESERVATION_NOT_ACTIVE` unless it is `ACTIVE`, and sets `CANCELLED` + `availableStock: { increment: quantity }`. `afterCancelCommit(result)` is called after commit (empty, for step 5). `cancelReservation` takes no `now` because cancelling does not depend on time. ARCHITECTURE.md section 8 now documents the response shape and the error codes of both routes (clarification, not a behaviour change).
- **Reason:** The lock is the only guard: the status update is a plain `update` by id, so a second parallel cancel is stopped by re-reading the status under the lock, not by a conditional update. A foreign reservation gets 404 rather than 403 so ids of other users' carts are not confirmed. `serverTime` lets the client correct its 10-minute timer.
- **Alternatives considered:** `updateMany ... WHERE status = 'ACTIVE'` without the Sale lock (would break the "stock changes only under the Sale lock" rule); 403 for foreign reservations.

### 2026-10-03 22:26 +0600 · Step 3: cart lifecycle · SaleTicker structure
- **Decision:** `src/jobs/saleTicker.ts` exports `startSales(now)`, `endSales(now)`, `expireReservations(now)`, `runTick(now)` (in that order) and `startTicker({ intervalMs = 1000, clock })`. Each step selects candidates without a lock, then per sale opens a transaction, locks the Sale row with `FOR UPDATE` and **re-checks the condition under the lock** (status and time), so a parallel or repeated call is a no-op. `endSales` expires `ACTIVE` carts, inserts one `EmailOutbox(SALE_ENDED_CART_CLEARED, reservationId)` per cleared cart with `createMany({ skipDuplicates: true })` and payload `{ saleId }`, and sets `status = ENDED` together with the returned units (`availableStock` is never zeroed). `expireReservations` groups due reservations by `saleId` and processes each sale under its own lock. Post-commit hooks: `afterStartSaleCommit`, `afterEndSaleCommit`, `afterExpireReservationsCommit` (empty, for step 5). `startTicker` uses a `running` flag, catches and logs tick errors, returns a stop function; `server.ts` starts it after `listen` and stops it on shutdown, `app.ts` is untouched so tests never run the interval.
- **Reason:** Candidate queries outside the lock keep the tick cheap when nothing is due; the re-check under the lock makes every step idempotent and safe against overlapping ticks or a parallel reserve. `new Date()` is only read in `startTicker`'s default `clock` (process wiring, not business logic). Smoke-checked: `tsx src/server.ts` against the test database moved a `SCHEDULED` sale with a past `startsAt` to `ACTIVE` within 5 s, no errors logged.
- **Alternatives considered:** One transaction for all sales per step (one bad sale would roll back the others); `SKIP LOCKED` (only needed with several instances, out of scope).

### 2026-10-03 22:26 +0600 · Step 3: cart lifecycle · Mutation checks
- **Decision:** Three mutations were applied temporarily, each test run 5 times, then reverted (`git diff -- backend/src` empty afterwards); no broken version was committed.
  1. **`FOR UPDATE` removed from `reserve`**, step 2 test "same user, 2 parallel requests": failed only **1 of 5** runs (run 3: two `201`, no `ALREADY_RESERVED`). The test was **strengthened** to 10 parallel requests from the same user (expect 1 × `201`, 9 × `409 ALREADY_RESERVED`): **5 of 5** failed without the lock (6, 4, 2, 5, 8 reservations created for one user) and 5 of 5 passed with the lock restored.
  2. **`FOR UPDATE` removed from `cancelReservation`**, test (b) with 2 parallel DELETEs: **passed 5 of 5**, so it does not detect the mutation; the race window between reading the status and the update is too short for two requests. Test (b) was kept as specified and a **strengthened variant** with 10 parallel DELETEs of the same reservation was added (expect 1 × `200`, 9 × `409`): **5 of 5** failed without the lock. In the captured runs 1–3 responses were `500` with Postgres `23514` (`Sale_available_stock_check`): two transactions both saw `ACTIVE` and tried to return the unit twice, which the CHECK rejected because the stock would exceed `total_stock`.
  3. **`status = 'ACTIVE'` filter removed from `expireReservations`** (candidate query and the query under the lock), test (g): **5 of 5** failed with `expected 'EXPIRED' to be 'PAYMENT_PENDING'`.
- **Reason:** Proves each test catches the bug it is meant to catch. Mutations 1 and 2 also show that two parallel requests are a weak race test; 10 parallel requests are used where it matters.
- **Alternatives considered:** Keeping the 2-request tests only (they pass with the bug most of the time).

### 2026-10-03 22:26 +0600 · Step 3: cart lifecycle · Process: red test commit
- **Decision:** Commit order: `docs` (ARCHITECTURE.md check order), `test` (red: 11 failing in `cart.test.ts` with 404 `NOT_FOUND`, `saleTicker.test.ts` failing to import the missing `src/jobs/saleTicker`), `feat` (implementation, 40/40 green), `test` (strengthened races after the mutation checks, 41/41 green), then this `docs` commit. Shared Supertest helpers (`reserveRequest`, `cancelRequest`, `currentCartRequest`, `countBy`, `outcome`) moved to `tests/helpers/http.ts`; `createReservation` factory keeps the stock invariant by decrementing `availableStock` for holding statuses.
- **Reason:** Explicitly requested test-first order; the red commit deviates from "commit only when tests pass" for that one commit.
- **Alternatives considered:** Committing stub modules with the tests so the ticker file fails on assertions instead of on import.
- **Known issues / not done:** Checkout, payments, sockets, email dispatch, dashboard and frontend are not implemented (out of scope for step 3); all post-commit hooks are empty. With 2 parallel DELETEs the missing cancel lock is not detected (see mutation check 2), only the 10-request variant catches it. A tick that throws on one sale skips the remaining steps of that tick until the next second. Unresolved `PAYMENT_PENDING` reservations still hold stock indefinitely (by design, step 0).
