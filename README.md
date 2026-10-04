# Flash Sale

Task: [TASK.md](TASK.md). Design: [ARCHITECTURE.md](ARCHITECTURE.md). Decision log: [DECISIONS.md](DECISIONS.md).

## Quick start

Requirements: Docker with Docker Compose v2, Node.js 20.6+ (only for running tests and local dev outside Docker).

Run the whole stack (postgres, postgres-test, backend, frontend):

```bash
docker compose up --build
```

- Frontend (customer storefront, cart, orders): http://localhost:5173. The Vite server proxies `/api`, `/health` and `/socket.io` (WebSocket included) to `BACKEND_URL` (`http://backend:3000` in compose, `http://localhost:3000` by default).
- Backend health: http://localhost:3000/health returns `{"status":"ok","db":"ok"}`

The backend container applies migrations (`prisma migrate deploy`) before it starts listening. Ports and credentials can be overridden by copying `.env.example` to `.env`.

Run the tests (they use the separate `postgres-test` database on port 5433; migrations are applied automatically before the run):

```bash
npm run install:all
npm test
```

`npm test` starts `postgres-test` if it is not running, runs `vitest run` in `backend/`, then the frontend unit tests (`npm test --prefix frontend`, pure logic in `frontend/src/lib`, no database needed). `npm run test:backend` and `npm run test:frontend` run one side only.

Local development without the backend/frontend containers:

```bash
docker compose up -d --wait postgres
cp backend/.env.example backend/.env
cd backend && npx prisma migrate deploy && cd ..
npm run dev --prefix backend     # http://localhost:3000
npm run dev --prefix frontend    # http://localhost:5173, proxies /api, /health, /socket.io to localhost:3000
```

Demo data: `npm run seed --prefix backend` (locally, uses `backend/.env`) or `docker compose exec backend npx tsx prisma/seed.ts` creates one product and one sale (stock 10, starts in 1 minute, lasts 10 minutes). It does nothing if a sale that has not ended already exists. Override with `SEED_STOCK`, `SEED_STARTS_IN_SECONDS`, `SEED_DURATION_SECONDS`, `SEED_PRICE_CENTS`. Tests never run the seed.

Root scripts: `npm run dev` (= `docker compose up --build`), `npm run build` (builds backend and frontend), `npm test`.

## Manual two-tab check

The customer UI keeps the logged-in user in `sessionStorage`, so every tab is its own session. Open the second tab by typing the URL into a new tab; "Duplicate tab" copies `sessionStorage` and would log in as the same user. The seed refuses to create a sale while one has not ended, so start from an empty database:

```bash
docker compose down -v
docker compose up --build -d --wait
docker compose exec -e SEED_STOCK=1 -e SEED_STARTS_IN_SECONDS=90 -e SEED_DURATION_SECONDS=1500 backend npx tsx prisma/seed.ts
```

This gives 1 unit, start in 90 s, a 25-minute sale (long enough for one 10-minute hold to expire).

1. **Two users.** Tab A: open http://localhost:5173 and log in as `alice`. Tab B: open a new tab with the same URL and log in as `bob`. Both headers show `Live · <username>`.
2. **Start moment.** Both tabs show `Starts in mm:ss`, `In stock: 1` and a disabled `Add to cart`. When the countdown reaches `00:00`, the button becomes enabled in both tabs at the same time without a reload, the timer switches to `Ends in 25:00`, and within a second the notice `Sale started` appears.
3. **Same last unit.** Click `Add to cart` in both tabs as close together as you can. Exactly one tab gets `The item is in your cart.` and `Cart (1)`; the other shows `Sold out: the last unit has just been taken.` Both tabs show `In stock: 0` without a reload. If one tab was clearly faster, the slower one already sees `Sold out` on a disabled button: that is the live stock update.
4. **Cancel returns the unit.** In the winning tab open `Cart` and press `Cancel`. The other tab shows `In stock: 1` immediately.
5. **Expiry.** Reserve again in tab A and open `Cart`: `Held for you: 10:00` counts down. Leave it for 10 minutes. At `00:00` (plus up to 1 s for the server ticker) tab A shows the notice `Your cart expired` and an empty cart; tab B shows `In stock: 1` without a reload.
6. **Declined payment and a retry after a network error.** Reserve in tab A, open `Cart`, select `FAILED (decline)`. In DevTools, Network tab, switch to `Offline` and press `Pay`: the page shows `Network error...` and the button reads `Pay (retry same attempt)`. Switch back to `No throttling` and press it: the `checkout` request carries the same `Idempotency-Key` header as the failed attempt (compare the request headers; the page shows its first 8 characters). The answer is `Payment declined...` and the item stays in the cart. The next `Pay` uses a new key.
7. **PENDING, then resolve.** Select `PENDING (provider hangs)` and press `Pay`. The cart shows `Payment pending...` without Cancel and Pay; tab B still shows `In stock: 0` (the unit stays held, also after the 10-minute timer would have run out). Open `Orders`: the order is `PENDING` with the box `Demo: simulate provider webhook`. Press `Resolve FAILED`: the badge turns `FAILED`, the notice `Payment for order #N failed` appears, the cart is empty and both tabs show `In stock: 1`.
8. **Double click on Pay.** Reserve again in tab A, select `SUCCESS (approve)` and double-click `Pay` quickly. The Network tab shows exactly one `checkout` request; the notice `Order #N paid` appears once, `Orders` lists that order once as `PAID`, and both tabs show `In stock: 0`.
9. **Reload and refetch.** Press F5 in either tab: the user stays logged in, and the stock, the countdown and the cart are reloaded from the server (with an active cart, its timer continues from the server's `expiresAt`, it does not restart at 10:00). Then run `docker compose stop backend`: the header shows `Reconnecting…`. Run `docker compose start backend`: within a few seconds the header shows `Live` again, and the tab has re-joined its rooms and refetched the sale, cart and orders over REST.
10. **Sale end (optional, needs a fresh sale).** After the sale has ended, seed a short one: `docker compose exec -e SEED_STOCK=2 -e SEED_STARTS_IN_SECONDS=30 -e SEED_DURATION_SECONDS=90 backend npx tsx prisma/seed.ts`, then reload both tabs (a newly seeded sale is not pushed to open tabs). Reserve in tab A and leave the item in the cart. When the sale ends, tab A shows the notices `Sale ended` and `Sale ended, your cart was cleared` and an empty cart; both tabs show `Sale ended` and a disabled button.
