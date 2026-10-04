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

### 2026-10-03 22:47 +0600 · Step 4: housekeeping · Ticker steps isolated in `runTick`
- **Decision:** `runTick(now)` runs `startSales`, `endSales`, `expireReservations` in a loop, each in its own `try/catch` that logs `Sale ticker step <name> failed` and continues. Test: `vi.spyOn(prisma.sale, 'findMany')` rejects once (so `startSales` throws), the spy otherwise delegates to the real bound method; `endSales` and `expireReservations` still apply, `console.error` is called once. ARCHITECTURE.md section 4 mentions the isolation.
- **Reason:** Fixes the step 3 known issue "a tick that throws skips the remaining steps". The spy needs an explicit `mockImplementation(realFindMany)`: after a `*Once` value is used up, Vitest's default passthrough on a Prisma delegate returned a non-iterable result.
- **Alternatives considered:** An injectable `steps` parameter on `runTick` (not needed, the spy works).

### 2026-10-03 22:47 +0600 · Step 4: checkout · Flow, response shape and error codes
- **Decision:** `POST /api/reservations/:id/checkout` (requireUser) validates path, `Idempotency-Key` (trimmed, 1–255 chars; missing/empty/blank → 400 `VALIDATION_ERROR`) and body `{ outcome }`. `checkout()` first reads the reservation without a lock only for `saleId` and owner (missing or foreign → 404 `RESERVATION_NOT_FOUND`), then in one `prisma.$transaction` after `SELECT ... FROM "Sale" WHERE id = $1 FOR UPDATE`: (1) Payment with this key → stored result, or 409 `IDEMPOTENCY_KEY_REUSED` if its order belongs to another user or reservation; (2) Order of the reservation in `PAID`/`PENDING` → returned with its latest payment, nothing created; (3) `RESERVATION_NOT_ACTIVE` → `RESERVATION_EXPIRED` (`expiresAt <= now`) → `SALE_NOT_ACTIVE` (`isSaleOpen`); (4) `order.upsert` by `reservationId`, `payment.create`, outcome applied (SUCCESS: PAID + COMPLETED + outbox; PENDING: PENDING + PAYMENT_PENDING; FAILED: FAILED, reservation stays ACTIVE). Response is always `200 { order, payment }`, including replays, so parallel same-key requests return identical bodies. `amountCents = sale.price_cents * quantity` read under the lock; any client amount is ignored. `Order.createdAt` and `Payment.createdAt` come from `now`.
- **Reason:** The lock serialises every checkout and resolve on the sale, so the "existing order" check and the reservation status check see committed state. 200 for replays keeps the client logic simple (a double click is not an error). A foreign reservation is 404, as in cancel, so other users' ids are not confirmed.
- **Alternatives considered:** 201 for the first call and 200 for replays (bodies would match but codes would differ); checking the key before ownership (would leak whether a reservation exists).

### 2026-10-03 22:47 +0600 · Step 4: checkout · P2002 fallback and post-commit hooks
- **Decision:** A Prisma `P2002` from the transaction is caught; the code then re-reads (outside the transaction) the payment by key (with the same reuse check) and the reservation's `PAID`/`PENDING` order and returns it, otherwise rethrows. `PaymentResult` carries `changed`; `afterCheckoutCommit` / `afterResolveCommit` (empty, for step 5 sockets) are called only when the transaction actually wrote something.
- **Reason:** Unique constraints (`Payment.idempotencyKey`, `Order.reservationId`, outbox keys) are the last line of defence; under the lock P2002 should not happen, but if it does the client gets the existing result, not 500. Replays should not emit socket events.
- **Alternatives considered:** Retrying the whole transaction on P2002.

### 2026-10-03 22:47 +0600 · Step 4: payments · Resolve and the mock provider
- **Decision:** `modules/payments/mockProvider.ts` exports a pure `charge(outcome) → { status }`. `POST /api/payments/:id/resolve` with `{ status: SUCCESS | FAILED }` (other values → 400) reads the payment without a lock for the `saleId` (unknown → 404 `PAYMENT_NOT_FOUND`), locks the Sale row, re-reads the payment and changes it only if it is `PENDING`; otherwise it returns `200` with the current `{ order, payment }`. SUCCESS: Payment SUCCESS, Order PAID, Reservation COMPLETED, `EmailOutbox(ORDER_PAID)` via `createMany({ skipDuplicates: true })`. FAILED: Payment and Order FAILED, Reservation CANCELLED, `availableStock += quantity` (if the sale is `ENDED`, the unit stays unsold). Resolve takes no `now`, like cancel, because it does not depend on time. The route has **no authentication**: it plays the provider's webhook. `GET /api/orders/me` returns the user's orders newest first (`createdAt desc, id desc`) with `paymentStatus` of the latest payment.
- **Reason:** The status re-check under the lock makes repeated and parallel resolves no-ops without 500. A pending payment started before the hold expired can finish at any time, also after the sale ended.
- **Alternatives considered:** A shared secret for the webhook (out of scope for a mock).

### 2026-10-03 22:47 +0600 · Step 4: mutation checks
- **Decision:** Four mutations were applied temporarily, each run 5 times, then reverted with `git checkout`; `git diff -- src` was empty afterwards and no broken version was committed.
  1. **`FOR UPDATE` removed from checkout**, test (c): **5 of 5** failed. Observed: several `SUCCESS` payments on one order (a double charge; the captured diff showed at least 6) or 9 × `200` + 1 × `409 RESERVATION_NOT_ACTIVE`.
  2. **"Existing PAID/PENDING order" check removed**: test (c) **5 of 5** failed (1 × `200`, 9 × `409 RESERVATION_NOT_ACTIVE`). Test (b) **passed 5 of 5**, because the same key is caught earlier by the Payment lookup. (b) was **strengthened**: after the parallel wave, a checkout with a fresh key must return the same body without a second payment. With the mutation it failed **5 of 5** (`409 RESERVATION_NOT_ACTIVE`).
  3. **"Only PENDING" condition removed from resolve**, tests (h): **5 of 5** failed. The repeated-resolve test got a different body (second FAILED returned the unit again, then SUCCESS flipped the order to PAID); the 10-parallel test got `500` (CHECK `Sale_available_stock_check` once stock exceeded `total_stock`). The "FAILED after the sale ended" case passed, as expected, since it resolves only once.
  4. **`skipDuplicates` removed from the ORDER_PAID insert**, test (j): **passed 5 of 5**. Through the API a second insert cannot happen: the "only PENDING" check and the PAID-order check stop it first, so `skipDuplicates` is a second line of defence. A **new (j) case** pre-inserts an `ORDER_PAID` row for the order and expects resolve SUCCESS to return `200` with one row; with the mutation it failed **5 of 5** (`500`, P2002).
- **Reason:** Proves each guard is covered by a test that fails without it.
- **Alternatives considered:** None.

### 2026-10-03 22:47 +0600 · Step 4: process
- **Decision:** Commits: `fix` (runTick isolation, test shown red first), `test` (red: 24 new tests failing with 404 `NOT_FOUND` and the missing `mockProvider` module, 42 old passing), `feat` (70/70 green), `test` (strengthened (b) and new (j) case, 71/71), then this `docs` commit. ARCHITECTURE.md sections 4, 7 and 8 were clarified (ticker step isolation, ownership read before the lock, check order, `IDEMPOTENCY_KEY_REUSED`, resolve returns 200 for non-PENDING payments, `availableStock += quantity`, response shapes); behaviour matches the document, no deviation. Tests use a mutable `clock` passed to `createApp({ now: () => clock })` instead of one server per time.
- **Reason:** Requested test-first order; the red commit deviates from "commit only when tests pass" for that one commit.
- **Alternatives considered:** One Supertest server per point in time (as in step 3).
- **Known issues / not done:** Sockets, email dispatching, dashboard and frontend are not implemented (out of scope); `afterCheckoutCommit` / `afterResolveCommit` are empty. `POST /api/payments/:id/resolve` is unauthenticated (mock webhook). A PENDING payment that is never resolved holds the unit indefinitely (by design, step 0). The `skipDuplicates` guard is only reachable by a test that pre-inserts an outbox row, not through the API. The P2002 fallback is not exercised by any test, because the Sale lock prevents the conflict.

### 2026-10-03 23:11 +0600 · Step 5a: housekeeping · Parallel cancel vs checkout test
- **Decision:** A new test in `checkout.test.ts` runs 10 rounds of `DELETE /api/reservations/:id` and `checkout SUCCESS` in parallel (`Promise.all`) on the same fresh `ACTIVE` reservation. Each round must end in exactly one of two ways: cancel `200` + checkout `409 RESERVATION_NOT_ACTIVE` (reservation `CANCELLED`, no order) or cancel `409 RESERVATION_NOT_ACTIVE` + checkout `200` (reservation `COMPLETED`, order `PAID`); no `500`, `assertStockInvariant` after every round. Totals are checked as well: SUCCESS payments and `ORDER_PAID` outbox rows equal the number of paid rounds, and `availableStock = 10 − paid`. Committed on its own; it passed without code changes.
- **Reason:** Both operations take the Sale row lock and re-read the reservation status under it, so whoever locks second sees the first one's result. The test pins this down for the cancel/checkout pair, which no earlier test covered.
- **Alternatives considered:** None.

### 2026-10-03 23:11 +0600 · Step 5a: realtime · Socket.IO 4.8.4 and the realtime module
- **Decision:** `socket.io` 4.8.4 (dependency) and `socket.io-client` 4.8.4 (dev dependency, tests only), exact versions. `src/realtime/socket.ts` holds one module-level `io` (`null` until `initRealtime(httpServer)`), exports `initRealtime`, `closeRealtime` (sets `io = null`, closes the io server and with it the http server) and four emit helpers that are no-ops while `io` is `null`. `server.ts` calls `initRealtime` right after `http.createServer(createApp())` and `closeRealtime` on shutdown; `app.ts` only gained the sales routes, so every Supertest-only test runs without sockets. Multi-room events use one `io.to([room, 'dashboard'])`, so a client in both rooms gets the event once (covered by a test). `sale:status` dates are sent as ISO strings.
- **Reason:** Matches ARCHITECTURE.md section 9. The null-object helpers let services call them unconditionally without touching the 72 existing tests. Socket.IO 4.8 supports Node 10.2+, so it fits the Node 20 pin from step 1.
- **Alternatives considered:** Injecting an emitter into each service (more wiring for the same result); plain `ws`.

### 2026-10-03 23:11 +0600 · Step 5a: realtime · Join validation and optional ack (ARCHITECTURE.md updated)
- **Decision:** `sale:join { saleId }` and `user:join { userId }` are validated with zod (`z.number().int().positive()`, no coercion); `dashboard:join` takes no payload. If the last argument is a function, it is treated as the ack. Invalid payload: no room change, ack `{ ok: false }` if one was given, nothing thrown. Valid payload: room joined, ack `{ ok: true }`. **Deviation (addition) to ARCHITECTURE.md section 9:** the ack is not in the original design; section 9 was updated in the implementation commit.
- **Reason:** The ack lets a client (and the tests) know the join has taken effect before acting. A missing ack keeps the "ignore invalid payloads" behaviour from the spec. `user:join` is not authenticated, the same as the `X-User-Id` stub.
- **Alternatives considered:** Disconnecting the socket on an invalid payload; `z.coerce` (would accept `"5"`).

### 2026-10-03 23:11 +0600 · Step 5a: realtime · Events only from post-commit hooks, extended result types
- **Decision:** All emits live in the existing post-commit hooks, which already ran only after `prisma.$transaction` resolved and only when something was written (ticker steps return `null` otherwise, checkout and resolve check `changed`). To build the payloads, `StartSaleResult` gained `serverTime`, `EndSaleResult` gained `status`, `startsAt`, `endsAt`, `serverTime` (from `select` on the final `sale.update`), and `PaymentResult` gained `reservation` (status after the transaction) and `availableStock?` (set only by resolve FAILED, which returns the unit). `findExisting` and the non-PENDING resolve path also load the reservation, so the result type is the same for replays; the HTTP DTOs are unchanged. Checkout and resolve emit `order:updated` (user room and dashboard), `reservation:updated` (owner), and `sale:stock` only when `availableStock` is set. **Deviation (clarification) to ARCHITECTURE.md section 9:** `reservation:updated` is also sent on cancel, checkout and resolve, and `sale:stock` on cancel and resolve FAILED; the section was updated.
- **Reason:** One place per operation for side effects keeps emits out of transactions; carrying the data in the result avoids an extra read after commit, whose value could already be stale.
- **Alternatives considered:** Re-reading the sale after commit to get the stock; emitting from routes.

### 2026-10-03 23:11 +0600 · Step 5a: realtime tests · Ack as an ordering barrier, commit-time failure trigger
- **Decision:** Tests connect with `socket.io-client` (`transports: ['websocket']`, `forceNew`, no reconnection) to a real `http.createServer(createApp({ now }))` + `initRealtime`, record every event with `onAny`, and call `flush()` before asserting: `flush()` sends an invalid `sale:join {}` with an ack and waits for `{ ok: false }`. Packets on one connection arrive in order, so once the ack is back, every event emitted earlier has arrived. Assertions are exact (`toEqual([...])`), which checks absence, duplicates and order without any `sleep`. For (h), the test installs a deferred constraint trigger (`CREATE CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`, `RAISE EXCEPTION`) on `"Reservation"` (reserve) or `"Payment"` (checkout) and drops it in `finally`. The exception fires at `COMMIT`, after the whole transaction callback has run; Prisma surfaces it as `PrismaClientUnknownRequestError` and the API returns `500`.
- **Reason:** Timing-based "wait 200 ms and expect nothing" tests are slow and can pass by accident. Failing at commit, not at a particular statement, means an emit anywhere inside the transaction is caught, which is what mutation check 1 relies on.
- **Alternatives considered:** Fixed delays; `vi.spyOn` on Prisma delegates (the transaction client is a different object); an immediate trigger (would only catch emits placed before the failing statement).

### 2026-10-03 23:11 +0600 · Step 5a: GET /api/sales/current · Selection rule and shape
- **Decision:** No authentication. The service returns the non-`ENDED` sale with the earliest `startsAt` (tie: lowest `id`); if every sale has ended, the one with the latest `endsAt` (tie: highest `id`); none → 404 `SALE_NOT_FOUND`. The response is `{ sale: { id, status, priceCents, availableStock, startsAt, endsAt, product: { id, name, description, imageUrl } }, serverTime }`, with `serverTime` taken from the clock injected into `createApp`. `totalStock` is not exposed (not asked for; the dashboard endpoint will report it). ARCHITECTURE.md section 8 documents the shape and the rule.
- **Reason:** The project assumes a single active sale; the ordering only makes the choice deterministic if the data ever has several non-ended sales. After the end, the storefront can still show the final state.
- **Alternatives considered:** Ordering by `id` alone.

### 2026-10-03 23:11 +0600 · Step 5a: seed · Idempotent demo seed without `prisma.seed`
- **Decision:** `backend/prisma/seed.ts` exports `seedDemo({ now, stock = 10, startsInMs = 60 s, durationMs = 10 min, priceCents = 4999 })`. If any non-`ENDED` sale exists, it is returned unchanged (`created: false`). Otherwise the demo product is reused by name (or created) and a new `SCHEDULED` sale is created. `main()` reads `SEED_STOCK`, `SEED_STARTS_IN_SECONDS`, `SEED_DURATION_SECONDS`, `SEED_PRICE_CENTS` (zod, with defaults) and is the only place that calls `new Date()`. The npm script is `npm run seed` (`tsx --env-file=.env prisma/seed.ts`); in the container it is `npx tsx prisma/seed.ts`. The `prisma.seed` key is deliberately **not** set in package.json, so `prisma migrate dev`/`reset` never seed automatically. `tsconfig.json` now includes `prisma/` so `tsc --noEmit` checks the seed. `tests/seed.test.ts` calls `seedDemo` explicitly; `globalSetup` does not seed. Smoke-checked against the test database: the first run kept an existing sale, and after the ticker ended it a second run created a new sale.
- **Reason:** "Keep any open sale" respects the single-active-sale assumption and makes the seed safe to re-run; re-running after a sale ends gives a fresh demo without manual cleanup.
- **Alternatives considered:** `upsert` on a fixed sale id; deleting and recreating demo data on each run.

### 2026-10-03 23:11 +0600 · Step 5a: mutation checks
- **Decision:** Three mutations were applied temporarily, each test run 5 times, then reverted with `git checkout`; `git diff` was empty afterwards and no broken version was committed.
  1. **`emitSaleStock` inside the reserve transaction** (right after the stock decrement), test (h) reserve: **5 of 5** failed with `expected [ [ 'sale:stock', … ] ] to deeply equal []`: the client received stock from a transaction that was rolled back at commit.
  2. **`if (result.changed)` removed before `afterResolveCommit`**, tests (g): the resolve test **failed 5 of 5** (the repeated resolves emitted `order:updated`, `reservation:updated` and more: 4 events instead of none). The checkout SUCCESS (g) test passed, as expected: it does not call resolve.
  3. **`reservation:updated` from cancel sent to `sale:{id}` instead of `user:{id}`** (a temporary helper in `socket.ts`), test (d): **5 of 5** failed: the other user in the sale room received `reservation:updated` in addition to `sale:stock`.
- **Reason:** Each test catches the bug it targets deterministically, thanks to the ack barrier; no test needed strengthening.
- **Alternatives considered:** None.

### 2026-10-03 23:11 +0600 · Step 5a: process
- **Decision:** Commits: `test` (cancel vs checkout race, green), `test` (red: `realtime.test.ts` and `seed.test.ts` failing to import the missing `src/realtime/socket` and `prisma/seed`, 5 × `404 NOT_FOUND` in `salesCurrent.test.ts`, 72 old tests passing; also adds the Socket.IO packages), `feat` (95/95 green; ARCHITECTURE.md sections 1, 8, 9 updated in the same commit, listed in its body; plus a test-only type fix for readonly room tuples found by `tsc`), then this `docs` commit. No strengthening commit was needed.
- **Reason:** Requested test-first order; the red commit deviates from "commit only when tests pass" for that one commit.
- **Alternatives considered:** Committing stub modules with the tests so the files fail on assertions instead of on import.
- **Known issues / not done:** Frontend, dashboard endpoints and email dispatching are not implemented (out of scope). The Vite proxy does not forward `/socket.io` yet, so the browser cannot connect until the frontend step adds it. Socket.IO runs without CORS config and without the Redis adapter (single instance). `user:join` and `dashboard:join` are unauthenticated: anyone can listen to any user's room (consistent with the `X-User-Id` stub). The cancel/checkout race test does not require that both outcomes occur across the 10 rounds, only that each round is consistent. The `reservation:updated ACTIVE` event after checkout FAILED is emitted but not asserted by a test. `npm audit` now also reports 2 moderate findings in `vitest`/`@vitest/mocker` 3.2.7 (dev only; the fix is Vitest 5, which needs Node 22), in addition to the 3 known high findings in `deepmerge-ts` via the Prisma CLI.

### 2026-10-04 14:54 +0600 · Step 5b: frontend · Vite proxy for `/api` and `/socket.io`
- **Decision:** `vite.config.ts` proxies `/health`, `/api` and `/socket.io` (`ws: true`) to `BACKEND_URL`, the same object for `vite` dev and `vite preview`. Compose already sets `BACKEND_URL=http://backend:3000`; outside Docker the default is `http://localhost:3000`. The browser always talks to its own origin.
- **Reason:** Same origin for REST and Socket.IO, so the backend still needs no CORS config. Verified through port 5173 with Docker: `GET /api/sales/current` returns the sale, `/socket.io/?EIO=4&transport=polling` returns the handshake, and a `socket.io-client` script with `transports: ['websocket']` connected over WebSocket and got `{ ok: true }` for `sale:join` and `user:join`.
- **Alternatives considered:** CORS on the backend and a direct connection to port 3000.

### 2026-10-04 14:54 +0600 · Step 5b: frontend · Versions and test setup
- **Decision:** `vitest` 3.2.7 (dev) and `socket.io-client` 4.8.4, exact, the same versions as the backend. Vitest runs in the default `node` environment and only tests pure modules in `frontend/src/lib` (`time`, `saleState`, `paymentAttempt`, `format`, `notices`). No jsdom or React Testing Library. Root `npm test` now runs `test:backend` and then `test:frontend`.
- **Reason:** Vitest 3.2 supports Vite 6 and Node 20 (Vitest 4/5 need Node 22). All rules that matter for correctness (sale window, clock offset, reducers, Idempotency-Key lifecycle, notice texts) live in pure functions with `nowMs` as a parameter, so they can be tested without a DOM.
- **Alternatives considered:** Component tests with jsdom (more setup, slower, and they would mostly test React).

### 2026-10-04 14:54 +0600 · Step 5b: frontend · No router, session in `sessionStorage`
- **Decision:** `App` switches between Storefront, Cart and Orders with local state, without a router. The logged-in user (`{ id, username, email, role }`) is stored in `sessionStorage` under `flashSale.user`. `api/client.ts` sends it as `X-User-Id`; a 401 clears the session, drops the socket and returns to the login screen. "Log out" does the same.
- **Reason:** Three screens do not need URLs. `sessionStorage` is per tab, so two tabs can be two users (a new tab opened by URL; "Duplicate tab" copies `sessionStorage`). On logout the socket is dropped, not reused: the server has no leave events, so a reused socket would stay in the previous user's room.
- **Alternatives considered:** `react-router`; `localStorage` (all tabs would share one user).

### 2026-10-04 14:54 +0600 · Step 5b: frontend · Socket lifecycle: join with ack, then refetch
- **Decision:** One module-level socket per tab (`socket.ts`, same origin, default transports). `useSale` handles every `connect` event (the first one and each reconnect) as: find the sale id (known, or from `GET /api/sales/current`), join `user:{id}` and `sale:{id}` with `emitWithAck` and a 5 s timeout, then refetch the sale, the cart and the orders. If the refetched sale has a different id, the client joins the new room and refetches. `sale:stock` / `sale:status` go through the pure reducers, `reservation:updated` clears or updates the cart at once and then refetches it, `order:updated` patches the order status and refetches the list. Handlers read the latest state from refs, so they never re-subscribe.
- **Reason:** Joining before the refetch means an event emitted between the two cannot be lost; the REST answer is the truth after any gap. Verified in the browser: after `docker compose stop/start backend` the header went `Reconnecting…` and then `Live`, and the tab fetched the three endpoints, noticed the new sale id, joined its room and then received `sale:stock` from it.
- **Alternatives considered:** Relying on events only; joining on every render.

### 2026-10-04 14:54 +0600 · Step 5b: frontend · Countdown on the server clock, one refetch at zero
- **Decision:** `offset = serverTime - Date.now()` is updated from every `GET /api/sales/current` and `GET /api/reservations/me`. `useCountdown(target, offset, onDone)` computes `countdown(target, serverNow(offset, Date.now()))` and schedules the next tick for the moment the displayed second changes (`totalMs % 1000`), so `00:00` and the button switch happen when the server clock reaches the target, not up to a second later. `countdown` rounds up, so `00:00` means "reached". `onDone` fires once per target and only if the countdown was seen running; the storefront uses it to refetch the sale once at `startsAt` and at `endsAt`, the cart uses it to refetch the cart at `expiresAt`. `saleUiState` matches the server: OPEN when `status != ENDED` and `startsAt <= now < endsAt`, even while the status is still SCHEDULED.
- **Reason:** The button opens at the start moment in every tab, independently of the ticker; the refetch catches a missed `sale:status`. Verified in the browser: `Add to cart` became enabled exactly when `Starts in` reached zero, and the `Sale started` notice arrived about a second later (the ticker period).
- **Alternatives considered:** A plain `setInterval(1000)` from mount (up to 1 s late); trusting only `sale:status`.

### 2026-10-04 14:54 +0600 · Step 5b: frontend · Idempotency-Key per payment attempt
- **Decision:** `beginAttempt(attempt, reservationId, newUuid)` returns the existing attempt for the same reservation or creates a new UUID; `finishAttempt(attempt, paymentStatus)` drops the key only when the payment is `FAILED` (a network error passes `null` and keeps it; SUCCESS and PENDING keep it too, so a repeat replays the stored result). The attempt lives in a ref in `useSale`, so it survives switching pages; a reload starts a new attempt. Pay and Cancel share an in-flight ref guard and are disabled while a request runs, so a double click sends one request. While a key is pending, the button reads `Pay (retry same attempt)` and the first 8 characters of the key are shown. `newUuid` falls back to `crypto.getRandomValues` when `crypto.randomUUID` is missing (non-secure origin). Checked in the browser by wrapping `fetch`: after FAILED the next attempt got a new key; a double click sent exactly one request; a simulated network error was retried with the same key, and after that attempt ended FAILED the next one got a new key.
- **Reason:** Matches ARCHITECTURE.md section 7: one key per attempt, reused for retries, a new one only after a declined payment.
- **Alternatives considered:** A new key per click (a lost response followed by a retry would rely only on the backend's per-reservation guard); persisting the key in `sessionStorage` (not needed: after a reload the cart state from the server decides).

### 2026-10-04 14:54 +0600 · Step 5b: frontend · Demo resolve needs the payment id (ARCHITECTURE.md updated)
- **Decision:** `GET /api/orders/me` returns no payment id and the backend was not to be changed, so the client stores `orderId -> paymentId` from a `PENDING` checkout response in `sessionStorage` (`flashSale.pendingPayments.{userId}`). The Orders page shows the box `Demo: simulate provider webhook` for every PENDING order; without a stored id it explains that only the tab that started the payment can resolve it. **Deviation (addition) to ARCHITECTURE.md:** section 1 now lists `frontend/src/lib`, `components/`, `pages/Login` and notes the dashboard comes later; section 9 describes the client socket lifecycle, the `sessionStorage` session and this payment-id rule.
- **Reason:** Keeps step 5b frontend-only. The demo control plays the provider's role, so it does not need to work from every tab.
- **Alternatives considered:** Adding `paymentId` to the orders DTO (a backend change, out of scope for this step).

### 2026-10-04 14:54 +0600 · Step 5b: frontend · Error and notice texts
- **Decision:** `describeError` maps API codes to readable texts (`SOLD_OUT` → `Sold out: the last unit has just been taken.`, `SALE_NOT_ACTIVE`, `ALREADY_RESERVED`, `RESERVATION_EXPIRED`, `NETWORK_ERROR`, …). After any 409 the storefront and cart refetch the sale and the cart. `Add to cart` is additionally disabled when the live stock is 0 (label `Sold out`). Notices come from pure functions in `lib/notices.ts`: `reservation:updated EXPIRED` → `Your cart expired`, or `Sale ended, your cart was cleared` when `saleUiState` is ENDED (the backend emits `sale:status` before `reservation:updated`); `order:updated` → `Order #N paid` / `Payment for order #N failed` / `... is pending`; `sale:status` → `Sale started` / `Sale ended` on a status change. The list keeps the last 5 notices; each can be dismissed and disappears after 15 s.
- **Reason:** The server is the source of truth: a 409 means the UI was stale. Verified in the browser: an in-page race (bob's `fetch` plus alice's double click on the last unit) gave bob 201 and alice the `Sold out` text; `Sale ended` and `Sale ended, your cart was cleared` both appeared when the sale ended with alice's cart active.
- **Alternatives considered:** Showing raw server messages.

### 2026-10-04 14:54 +0600 · Step 5b: frontend · Fix found in the browser check
- **Decision:** After a declined payment, the cart was cleared by the sale end, but the message "... you can try again" stayed under "Your cart is empty". Declined-payment and network-error messages now carry the reservation id and are only shown while that cart is displayed (`fix` commit). Re-checked in the browser: FAILED, then the cart was cancelled outside the UI, and the cart page showed only "Your cart is empty."
- **Reason:** A message about retrying must not outlive the cart it refers to.
- **Alternatives considered:** Clearing every message on any cart change (would also hide "Paid. Order #N is confirmed.").

### 2026-10-04 14:54 +0600 · Step 5b: process
- **Decision:** Commits: `chore` (proxy), `test` (red: all 5 lib test files failing to import the missing modules), `feat` (lib, 38/38 green), `feat` (api client, session, socket and hooks), `feat` (pages), `fix` (stale retry message), then this `docs` commit (README "Manual two-tab check", ARCHITECTURE.md sections 1 and 9, DECISIONS.md, AI_LOG.md). Backend code is unchanged; backend tests: 95/95.
- **Reason:** Requested commit order, with test-first for the pure logic; the red commit deviates from "commit only when tests pass" for that one commit.
- **Alternatives considered:** None.
- **Known issues / not done:** The dashboard page, email dispatching and any backend change are not part of this step. React components and hooks have no automated tests (only `src/lib` is unit-tested); the UI was checked by hand in Cursor's built-in browser (one and two tabs, with `fetch` wrapped through the DevTools protocol to read keys and to simulate a network error) and with curl and `socket.io-client` through the proxy. The 10-minute hold expiry (README step 5) and DevTools "Offline" mode were not run in the browser; the cart-cleared path was seen at sale end, expiry is covered by backend tests, and the network error was simulated by wrapping `fetch`. A sale created by the seed while tabs are open is not pushed to them (there is no event for new sales); they see it after a reload or a reconnect. The demo resolve buttons work only in the tab that started the PENDING payment. The `Payment for order #N is pending` notice also shows after your own Pay click. Order ids in the demo skipped a number (#1 FAILED, then #3 PAID); most likely the backend's `order.upsert` after a FAILED retry consumes a sequence value even when it updates. Not investigated, cosmetic. `npm audit` in `frontend/` reports 2 moderate findings in `vitest` / `@vitest/mocker` 3.2.7 (dev only, same as the backend; the fix needs Vitest 5 and Node 22).
