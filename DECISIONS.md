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
