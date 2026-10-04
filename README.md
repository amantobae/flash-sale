# Flash Sale

A short sale with fewer units than buyers. Stock cannot be oversold, a cart holds a unit for 10 minutes, a payment can succeed, fail, or hang, and each order produces one email. Design: [ARCHITECTURE.md](ARCHITECTURE.md). The assignment text is [TASK.md](TASK.md). Choices and mutation checks: [DECISIONS.md](DECISIONS.md).

## Tech stack and why

- **PostgreSQL 16** is the source of truth. Every stock or sale-status change runs inside `prisma.$transaction` after `SELECT ... FROM "Sale" WHERE id = $1 FOR UPDATE`, so reserve, cancel, expire, pay, start, and end queue on one row. A `CHECK` on `available_stock` is the last line of defence. Money is integer cents.
- **Prisma 6** gives migrations and types. Row locks use `$queryRaw` because Prisma cannot express `FOR UPDATE`.
- **Express 5** on Node 20. Rejected promises from async handlers reach the error middleware without a wrapper.
- **Socket.IO** rooms (`sale:{id}`, `user:{id}`, `dashboard`) push stock and status after the transaction commits. One backend process; a Redis adapter is not wired up.
- **A 1-second ticker** starts sales, ends them, expires `ACTIVE` holds, and dispatches the email outbox. Reserve and checkout also check the time window themselves, so a tick that is up to 1 second late cannot sell early or late.
- **Email outbox.** The row is inserted in the same transaction as the state change, with unique keys so a retry cannot insert a second email. A later tick claims `PENDING` rows with `UPDATE ... WHERE status = 'PENDING'` and only then marks them `SENT`.
- **React 19 + Vite 6.** The browser talks to its own origin. Vite proxies `/api`, `/health`, and `/socket.io` to the backend.

Versions are pinned to lines that run on Node 20. See the step 1 entry in [DECISIONS.md](DECISIONS.md).

## Prerequisites

- Docker with Docker Compose v2.
- Node.js 20.6+ on the host, only to run `npm test`, `npm run demo`, and `npm run restart-check`. The app itself runs in the `node:20-bookworm-slim` image.

## Quick start

```bash
npm run install:all
docker compose up --build
```

`install:all` runs `npm ci` at the repo root (the demo scripts), then in `backend/` and `frontend/`.

| What | URL or port |
| --- | --- |
| Storefront, cart, orders, dashboard | http://localhost:5173 |
| Backend | http://localhost:3000 |
| Health | http://localhost:3000/health → `{"status":"ok","db":"ok"}` |
| Postgres | localhost:5432 |
| Postgres used only by tests | localhost:5433 |

The backend container runs `prisma migrate deploy` before it listens. The frontend container waits until the backend healthcheck passes. Copy `.env.example` to `.env` only if you need to change ports or credentials.

The Vite server proxies `/api`, `/health`, and `/socket.io` (WebSocket included) to `BACKEND_URL` (`http://backend:3000` in Compose, `http://localhost:3000` otherwise).

Seed one product and one sale (stock 10, starts in 60 seconds, lasts 10 minutes). It does nothing if a sale that has not ended already exists:

```bash
docker compose exec backend npx tsx prisma/seed.ts
```

Overrides: `SEED_STOCK`, `SEED_STARTS_IN_SECONDS`, `SEED_DURATION_SECONDS`, `SEED_PRICE_CENTS`. Tests never run the seed. `npm run demo` does not use the seeded sale; it only needs the product row the seed creates. Without that product, `POST /api/dashboard/sales` returns `404 PRODUCT_NOT_FOUND`.

Local development without the backend and frontend containers:

```bash
docker compose up -d --wait postgres
cp backend/.env.example backend/.env
cd backend && npx prisma migrate deploy && cd ..
npm run dev --prefix backend      # http://localhost:3000
npm run dev --prefix frontend     # http://localhost:5173
```

## How to prove it works

### Automated tests

```bash
npm test
```

This starts `postgres-test` if needed, runs the backend Vitest suite (Supertest against real Postgres, concurrency via `Promise.all`), then the frontend unit tests. Frontend tests cover only the pure modules in `frontend/src/lib`. They do not render React.

### Demo script

With the Compose stack up:

```bash
npm run demo
```

`BASE_URL` defaults to `http://localhost:3000`. Each scenario creates its own sale from the server's `serverTime`, so a second run does not depend on the seed or on the first run. The script prints `PASS` or `FAIL` with counts and ids, then a summary, and exits 1 if anything failed.

It does **not** wait 10 minutes. Scenario 0 only names the test that proves hold expiry: `backend/tests/saleTicker.test.ts`, "(d) expires exactly at createdAt + 10 min, not 1 ms earlier, and is idempotent".

| # | What the script checks | What it does not check |
| --- | --- | --- |
| 1 | Reserve before `startsAt` is `409 SALE_NOT_ACTIVE`; the next reserve once `serverTime >= startsAt` is `201` | Two browser tabs enabling the button together |
| 2 | 20 parallel buyers, stock 5: 5 reservations, 15 `SOLD_OUT` | |
| 3 | 10 parallel reserves from one user: 1 reservation, 9 `ALREADY_RESERVED` | |
| 4 | 10 parallel checkouts with one `Idempotency-Key`: 1 order, 1 payment | A second key on the same reservation (that is checkout test (c)) |
| 5 | `PENDING` holds the only unit (`SOLD_OUT` for the other buyer). Resolve `SUCCESS` makes the order `PAID` and `sold` 1. Ten parallel resolve `FAILED` return the unit once (`available` 0 → 1, still 1 on a repeat) | That a `PENDING` hold survives the 10-minute timer (saleTicker test (g) and checkout test (f)) |
| 6 | `available + held + pending + sold = total`, and `revenueCents` equals the `PAID` orders on that sale (a `FAILED` order is present and not counted) | |
| 7 | Two `socket.io` clients in `sale:{id}` both receive `sale:stock` after a reserve | A browser tab |
| 8 | Dashboard `outbox.sent` for that sale becomes 1 and stays 1 | Email type and recipient (emails tests (a) and (d)) |
| 9 | A ~10s sale: the `ACTIVE` cart is gone, the `PENDING` cart remains, `outbox.sent` is 1, `unsold` equals `availableStock` | Who the email was addressed to (emails test (e)) |

`GET /api/reservations/me` does not return a `COMPLETED` reservation, so scenario 5 treats `sold = 1` and an empty cart as the HTTP evidence. The reservation status `COMPLETED` is asserted in `backend/tests/realtime.test.ts` ("resolve SUCCESS emits order:updated PAID and reservation:updated COMPLETED, no sale:stock").

### Manual two-tab check

The customer UI keeps the user in `sessionStorage`, so each tab is its own session. Open the second tab by typing the URL; "Duplicate tab" copies `sessionStorage` and logs in as the same user. The seed refuses to create a sale while one has not ended, so start from an empty database:

```bash
docker compose down -v
docker compose up --build -d --wait
docker compose exec -e SEED_STOCK=1 -e SEED_STARTS_IN_SECONDS=90 -e SEED_DURATION_SECONDS=1500 backend npx tsx prisma/seed.ts
```

That is 1 unit, start in 90 seconds, a 25-minute sale (long enough for one 10-minute hold).

1. **Two users.** Tab A: http://localhost:5173, log in as `alice`. Tab B: a new tab with the same URL, log in as `bob`. Both headers show `Live · <username>`.
2. **Start moment.** Both tabs show `Starts in mm:ss`, `In stock: 1`, and a disabled `Add to cart`. At `00:00` the button becomes enabled in both tabs without a reload, the timer switches to `Ends in`, and within about a second the notice `Sale started` appears.
3. **Same last unit.** Click `Add to cart` in both tabs as close together as you can. One tab gets the cart; the other shows `Sold out`. Both show `In stock: 0` without a reload.
4. **Cancel returns the unit.** In the winning tab, open `Cart` and press `Cancel`. The other tab shows `In stock: 1`.
5. **Expiry.** This step was **not** run in the browser. Leave a cart for 10 minutes if you want to see it. The server behaviour is the saleTicker test named above, and `backend/tests/realtime.test.ts` "(e) expireReservations(now + 10 min) emits sale:stock and reservation:updated EXPIRED to the owner".
6. **Declined payment and a retry after a network error.** Reserve in tab A, open `Cart`, select `FAILED (decline)`. In DevTools → Network, switch to `Offline` and press `Pay`: the page shows a network error and the button reads `Pay (retry same attempt)`. Switch back to `No throttling` and press it: the `checkout` request uses the same `Idempotency-Key` (the page shows its first 8 characters). The payment is declined and the item stays in the cart. The next `Pay` uses a new key.
7. **PENDING, then resolve.** Select `PENDING (provider hangs)` and press `Pay`. The cart shows a pending payment and no Cancel or Pay. Tab B still shows `In stock: 0`. Open `Orders`: the order is `PENDING` with `Demo: simulate provider webhook`. `Resolve FAILED` turns the badge to `FAILED`, clears the cart, and both tabs show `In stock: 1`. The buttons use `paymentId` from `GET /api/orders/me`, so another tab of the same user can resolve it too.
8. **Double click on Pay.** Reserve again, select `SUCCESS (approve)`, and double-click `Pay`. The Network tab shows one `checkout` request. `Orders` lists that order once as `PAID`.
9. **Reload and restart.** F5 keeps the user and reloads stock, countdown, and cart from the server. Then `docker compose stop backend`: the header shows `Reconnecting…`. `docker compose start backend`: within a few seconds it shows `Live` again. `npm run restart-check` is the scripted form of the data-survives-restart half of this (it does not drive the browser).
10. **Sale end.** After the sale has ended, seed a short one: `docker compose exec -e SEED_STOCK=2 -e SEED_STARTS_IN_SECONDS=30 -e SEED_DURATION_SECONDS=90 backend npx tsx prisma/seed.ts`, then reload both tabs (a newly seeded sale is not pushed to open tabs). Reserve in tab A and leave the item in the cart. When the sale ends, tab A shows `Sale ended` and `Sale ended, your cart was cleared`.

Steps that were actually watched in the browser are recorded in [DECISIONS.md](DECISIONS.md), not assumed from this list. Step 5b: two tabs, the button enabling when the countdown hit zero, a last-unit race, sale-end notices with a cleared cart, a declined payment that reused the idempotency key after a simulated network error, a double click sending one request, and the header going `Reconnecting…` then `Live` after the backend was stopped and started. Step 6: one dashboard tab whose counters changed without a reload when another user reserved through the API, plus Resolve SUCCESS using `paymentId`. Not checked in the browser: the 10-minute hold (step 5), the DevTools Offline switch (the network error was a wrapped `fetch`), a second dashboard tab, `PUT` of a scheduled sale, and the mailer console.

### Restart check

With Compose up, from the repo root:

```bash
npm run restart-check
```

The script creates a sale, reserves one unit, runs `docker compose restart backend`, waits up to 60 seconds for `GET /health` to return `{"status":"ok","db":"ok"}`, and checks that the reservation id, `ACTIVE` status, `expiresAt`, stock counters, and outbox counts are unchanged. It then creates a sale that starts in about 3 seconds and waits until the ticker sets `ACTIVE`.

### Mutation checks

After the tests were green, the guard each test is meant to catch was removed, the test was run 5 times, and the change was reverted. No broken version was committed. Details are in [DECISIONS.md](DECISIONS.md).

| Step | Mutation | Test | Result |
| --- | --- | --- | --- |
| 2 | `FOR UPDATE` removed from reserve | `reservations.test.ts` — stock 1, 20 parallel users | 5/5 fail (500 from the stock `CHECK`, not 409 `SOLD_OUT`) |
| 3 | `FOR UPDATE` removed from reserve | same user; strengthened from 2 to 10 parallel requests | 5/5 fail. The 2-request version failed only 1/5 |
| 3 | `FOR UPDATE` removed from cancel | 10 parallel `DELETE`s | 5/5 fail. The 2-request version passed 5/5 |
| 3 | `status = 'ACTIVE'` filter removed from `expireReservations` | `saleTicker.test.ts` (g) | 5/5 fail |
| 4 | `FOR UPDATE` removed from checkout | `checkout.test.ts` (c) | 5/5 fail |
| 4 | "existing `PAID`/`PENDING` order" check removed | (c), and (b) strengthened with a second key after the parallel wave | 5/5 fail. Same-key (b) alone passed 5/5, because the payment lookup catches that key first |
| 4 | "only `PENDING`" condition removed from resolve | `resolve.test.ts` (h) | 5/5 fail |
| 4 | `skipDuplicates` removed from the `ORDER_PAID` insert | (j) through the API | 5/5 pass. A new (j) that pre-inserts the outbox row failed 5/5 (`P2002`) |
| 5a | `emitSaleStock` inside the reserve transaction | `realtime.test.ts` (h) | 5/5 fail (the client saw a stock event from a rolled-back transaction) |
| 5a | `if (result.changed)` removed before `afterResolveCommit` | realtime resolve (g) | 5/5 fail |
| 5a | cancel's `reservation:updated` sent to the sale room | realtime (d) | 5/5 fail |
| 6 | atomic claim replaced with select-then-send | `emails.test.ts` (b) | 5/5 fail (15 emails instead of 3) |
| 6 | a throwing mailer still marked the row `SENT` | emails (c) | 5/5 fail |
| 6 | revenue summed every order, not only `PAID` | `dashboard.test.ts` (g) and (h) | 5/5 fail |

## Architecture summary

One sale is the unit of concurrency. Routes validate with zod and call services. Services change stock only while holding the sale row. After commit they emit Socket.IO events. A ticker in the same process handles start, end, hold expiry, and email dispatch. The client corrects its countdown with `serverTime` and refetches on reconnect and when its own timer hits zero.

`availableStock + held + sold = totalStock` always, including after the sale ends. `held` is `ACTIVE` plus `PAYMENT_PENDING`. After `ENDED`, `availableStock` is the unsold remainder: the number stays, and the status is what stops a new reserve. The dashboard shows that number as Unsold.

`PAYMENT_PENDING` does not expire. Only a resolve moves it (`SUCCESS` → paid and `COMPLETED`, `FAILED` → `CANCELLED` and the unit comes back). An unresolved payment holds the unit with no timeout.

The full design, including the state diagrams and the race list, is [ARCHITECTURE.md](ARCHITECTURE.md).

## Requirements coverage

Status is about the product, not about whether `npm run demo` alone covers the row. "Partial" means something the assignment asks for is missing or only partly built.

### What it includes

| Requirement | Where | Proof | Status |
| --- | --- | --- | --- |
| Sale: product, price, quantity, start and end | `Sale` and `Product` in `backend/prisma/schema.prisma`; `POST /api/dashboard/sales`; `backend/prisma/seed.ts` | `backend/tests/seed.test.ts`; `backend/tests/dashboard.test.ts` "POST creates a SCHEDULED sale..."; demo scenarios create a sale per case | done |
| Storefront with stock and a timer | `frontend/src/pages/Storefront.tsx`, `frontend/src/hooks/useCountdown.ts`, `GET /api/sales/current` | `frontend/src/lib/time.test.ts`, `frontend/src/lib/saleState.test.ts`; manual two-tab check step 2 | done |
| Cart held for 10 minutes | `reserve` sets `expiresAt = now + 10 min` (`backend/src/modules/reservations/service.ts`); `expireReservations` in `backend/src/jobs/saleTicker.ts` | `backend/tests/saleTicker.test.ts` (d). The demo does not wait. The browser wait was not run | done |
| Payment stub that can confirm, decline, or hang | `backend/src/modules/payments/mockProvider.ts`; checkout body `outcome`; `POST /api/payments/:id/resolve` | `backend/tests/checkout.test.ts`, `backend/tests/resolve.test.ts`; demo scenarios 4, 5, and 6 | done |
| Buyer account: orders and status | `GET /api/orders/me`; `frontend/src/pages/Orders.tsx` | `backend/tests/orders.test.ts` (l); demo scenarios 4 and 6 read `orders/me` | done |
| Store screen: stock, sold, in carts, revenue | `GET /api/dashboard/sales/:id`; `frontend/src/pages/Dashboard.tsx`. In carts is `held` (`ACTIVE`) plus `pending` (`PAYMENT_PENDING`) | `backend/tests/dashboard.test.ts` (g) and (h); demo scenario 6. Browser: one dashboard tab during step 6, not a second tab | done |

### Expected behaviour

| Requirement | Where | Proof | Status |
| --- | --- | --- | --- |
| No purchase before the start. At the start, purchase opens for everyone together | Reserve checks `startsAt <= now < endsAt`, not only the status (`backend/src/modules/reservations/service.ts`). The ticker emits `sale:status`. The storefront enables the button from the server clock and refetches at zero | `backend/tests/reservations.test.ts` "returns 409 SALE_NOT_ACTIVE before startsAt" and "allows reserving exactly at startsAt while status is still SCHEDULED"; `backend/tests/realtime.test.ts` (f); demo scenario 1 (one HTTP client; the passing reserve happened while status was still `SCHEDULED`). Two tabs opening together: manual check step 2, not the demo | done |
| Stock changes for everyone watching, without a reload | `sale:stock` after commit (`backend/src/realtime/socket.ts`) | `backend/tests/realtime.test.ts` (a); demo scenario 7 (two socket clients, not browsers). Browser: manual check step 3 | done |
| The last unit is not sold to two buyers at once | Sale row lock, then stock check, then decrement | `backend/tests/reservations.test.ts` "stock 1, 20 users in parallel: exactly 1 success and 19 SOLD_OUT". Demo scenario 2 is the stock-5 case (5 successes, 15 `SOLD_OUT`) | done |
| Unpaid cart returns after 10 minutes, and others see it | `expireReservations` returns the unit and emits `sale:stock` | `backend/tests/saleTicker.test.ts` (d) and (e); `backend/tests/realtime.test.ts` (e). Not waited out in the demo or in the browser | done |
| A payment started before the hold ends still completes if the stub answers later | Resolve does not look at `expiresAt`. `expireReservations` and sale end ignore `PAYMENT_PENDING` | `backend/tests/resolve.test.ts` (g); `backend/tests/saleTicker.test.ts` (g); `backend/tests/checkout.test.ts` (f). Demo scenario 5 resolves immediately, so it does not prove the "after the hold" part | done |
| A hung payment keeps the unit. It is not sold twice. When the stub answers, the order is settled | Checkout `PENDING` sets `PAYMENT_PENDING`. Resolve `SUCCESS` completes; resolve `FAILED` returns the unit once | `backend/tests/checkout.test.ts` (k); `backend/tests/resolve.test.ts` (h); demo scenario 5 | done |
| A double pay does not create two orders or charge twice | Unique `Payment.idempotencyKey` and unique `Order.reservationId`, checked under the sale lock | `backend/tests/checkout.test.ts` (b) same key and (c) different keys; demo scenario 4 (same key only) | done |
| The buyer gets one email about the order | `EmailOutbox` `ORDER_PAID` inserted in the payment transaction; dispatcher claims each row once | `backend/tests/emails.test.ts` (a) and both (d) cases. Demo scenario 8 only shows `outbox.sent = 1` for that sale. The counter has no type or recipient. The mailer writes a log line and an in-memory array; it does not send SMTP | done |
| When the sale ends, unsold stock is withdrawn, unpaid carts are cleared, and those buyers are notified | `endSales` expires `ACTIVE` carts, inserts `SALE_ENDED_CART_CLEARED`, sets `ENDED`. `availableStock` is **not** zeroed; it remains the unsold count and new reserves get `409 SALE_NOT_ACTIVE`. `PAYMENT_PENDING` carts are not cleared and get no email | `backend/tests/saleTicker.test.ts` (h); `backend/tests/emails.test.ts` (e). Demo scenario 9: cleared cart, `PENDING` cart still there, `outbox.sent = 1`, `unsold = availableStock`. It does not show the recipient | done |

## Known limitations

- There is no real authentication. Login is `POST /api/users/login` with a username. Later requests send `X-User-Id`.
- `POST /api/payments/:id/resolve` and the dashboard routes are not authenticated.
- Anyone who can open a socket can join any `sale:{id}`, `user:{id}`, or `dashboard` room.
- An outbox row left in `SENDING` (process dies after the provider accepts it and before `SENT`) is not recovered.
- A `PENDING` payment that is never resolved holds its unit indefinitely. That is deliberate; there is no timeout.
- The Prisma `P2002` fallback in checkout is not covered by a test. The sale lock makes that conflict unreachable through the API.
- `npm audit` in `backend/`: 3 high findings in `deepmerge-ts`, pulled in by the Prisma CLI (dev dependency), and 2 moderate findings in `vitest` / `@vitest/mocker` 3.2.7. `frontend/`: the same 2 moderate Vitest findings. The suggested fixes are Prisma 6.12 or Vitest 5; Vitest 5 needs Node 22. They were not applied. The root demo dependencies reported no findings.
- Order ids are not a gapless sequence. During step 5b a `FAILED` checkout followed by `PAID` skipped a number. Most likely `order.upsert` after a failed attempt consumes a sequence value. Not investigated. Cosmetic.
- A sale created while customer tabs are already open is not pushed to them. They see it after a reload or a reconnect.
- The 10-minute hold was not left to expire in the browser. Scenario 0 of the demo only cites the automated test.
- The dashboard screen can create the next sale. It has no form for `PUT /api/dashboard/sales/:id` (the route itself is tested).
- React components and hooks have no automated tests.

## What I would do next

- Replace the `X-User-Id` stub with a real session, and require it on the dashboard. Keep resolve as a signed webhook rather than an open route.
- Add a timeout for `PAYMENT_PENDING`, and a recovery pass for outbox rows stuck in `SENDING`, using the outbox id as the provider idempotency key.
- For more than one backend process: Redis adapter for Socket.IO, and `SKIP LOCKED` in the ticker and the dispatcher.
- Swap the mock mailer and the mock payment provider for real ones without changing the outbox or the idempotency key.
- Push "a new sale exists" to open storefront tabs, and add the missing edit form for a future `SCHEDULED` sale.
- Cover the `P2002` fallback with a test that forces the conflict, and add a few component tests around the cart's idempotency key.

## How it was built

Claude was used for planning and for prompt drafts. Cursor wrote the code.

Models, only as recorded:

- Steps 0 through 5b: Claude Opus 5.5 ([DECISIONS.md](DECISIONS.md) header and [AI_LOG.md](AI_LOG.md)).
- Step 6: Grok 4.6. [DECISIONS.md](DECISIONS.md) (2026-10-04 16:20 +0600) says Cursor switched to that model because the Opus usage limit ran out, the switch was not chosen, and the result was kept after review. [AI_LOG.md](AI_LOG.md) names Grok 4.6 on the step 6 line. There is no record of a discarded Grok 4.6 attempt.
- Step 7 (this demo, restart check, and README): Grok 4.7, in the step 7 line of [AI_LOG.md](AI_LOG.md).

Workflow: a failing test commit first, then the implementation, then mutation checks (revert the broken code, do not commit it), then small commits. Timestamps in the logs come from `date "+%Y-%m-%d %H:%M %z"`.

Commit history (full list: `git log --format="%h %ad %s" --date=format:"%Y-%m-%d %H:%M %z"`):

| When | Commit | What |
| --- | --- | --- |
| 2026-10-03 21:03 +0600 | `d645e35` | initialize project |
| 2026-10-03 21:28 +0600 | `9a49801` | architecture |
| 2026-10-03 21:33 +0600 | `78e3bb7` | cursor rules and decisions log |
| 2026-10-03 21:40 +0600 | `1a126ad` | docker compose |
| 2026-10-03 21:44 +0600 | `a500063` | backend skeleton |
| 2026-10-03 21:45 +0600 | `67806e9` | Prisma schema and migrations |
| 2026-10-03 21:48 +0600 | `dade7c1` | minimal frontend |
| 2026-10-03 21:49 +0600 | `cd9190e` | Vitest and Supertest |
| 2026-10-03 21:54 +0600 | `75ceaea` | step 1 decisions |
| 2026-10-03 22:04 +0600 | `dba015f` | reservation tests (red) |
| 2026-10-03 22:05 +0600 | `9db4b93` | login stub and reserve |
| 2026-10-03 22:19 +0600 | `b03bea7` | cart and ticker tests (red) |
| 2026-10-03 22:21 +0600 | `4fde07e` | cart cancel, expiry, ticker |
| 2026-10-03 22:27 +0600 | `6ae62ad` | step 3 decisions |
| 2026-10-03 22:36 +0600 | `699d627` | isolate ticker steps |
| 2026-10-03 22:39 +0600 | `4b0af8b` | checkout tests (red) |
| 2026-10-03 22:41 +0600 | `223c224` | checkout, resolve, orders |
| 2026-10-03 22:49 +0600 | `b98a16d` | step 4 decisions |
| 2026-10-03 23:02 +0600 | `6387e5a` | realtime tests (red) |
| 2026-10-03 23:07 +0600 | `c20a1fc` | Socket.IO, current sale, seed |
| 2026-10-03 23:13 +0600 | `eb7b895` | step 5a decisions |
| 2026-10-04 14:28 +0600 | `1472aa1` | proxy `/api` and `/socket.io` |
| 2026-10-04 14:31 +0600 | `16cc4e3` | frontend lib tests (red) |
| 2026-10-04 14:41 +0600 | `9e42972` | storefront, cart, orders |
| 2026-10-04 14:57 +0600 | `47618e1` | step 5b decisions and the two-tab check |
| 2026-10-04 15:10 +0600 | `988d2d3` | `paymentId` on `GET /api/orders/me` |
| 2026-10-04 15:20 +0600 | `019c7c4` | email and dashboard tests (red) |
| 2026-10-04 15:23 +0600 | `125bfa9` | email dispatcher and dashboard API |
| 2026-10-04 15:28 +0600 | `0cd94f4` | dashboard page |
| 2026-10-04 15:35 +0600 | `3539565` | step 6 decisions |
| 2026-10-04 16:32 +0600 | `e17be76` | demo script |
| 2026-10-04 16:35 +0600 | `cd437ee` | demo revenue check scoped to that sale |
| 2026-10-04 16:35 +0600 | `103a693` | restart check |
| 2026-10-04 16:37 +0600 | `776adea` | final README |

Not every commit is in the table. `git log` is the full history. The step 7 decisions entry is the commit after `776adea`.

## Third-party code

None, besides the libraries in `package.json` (root, `backend/`, and `frontend/`). Application code was written for this assignment.
