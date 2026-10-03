# Flash Sale

Task: [TASK.md](TASK.md). Design: [ARCHITECTURE.md](ARCHITECTURE.md). Decision log: [DECISIONS.md](DECISIONS.md).

## Quick start

Requirements: Docker with Docker Compose v2, Node.js 20.6+ (only for running tests and local dev outside Docker).

Run the whole stack (postgres, postgres-test, backend, frontend):

```bash
docker compose up --build
```

- Frontend: http://localhost:5173 (shows the backend health status)
- Backend health: http://localhost:3000/health returns `{"status":"ok","db":"ok"}`

The backend container applies migrations (`prisma migrate deploy`) before it starts listening. Ports and credentials can be overridden by copying `.env.example` to `.env`.

Run the tests (they use the separate `postgres-test` database on port 5433; migrations are applied automatically before the run):

```bash
npm run install:all
npm test
```

`npm test` starts `postgres-test` if it is not running and then runs `vitest run` in `backend/`.

Local development without the backend/frontend containers:

```bash
docker compose up -d --wait postgres
cp backend/.env.example backend/.env
cd backend && npx prisma migrate deploy && cd ..
npm run dev --prefix backend     # http://localhost:3000
npm run dev --prefix frontend    # http://localhost:5173, proxies /health to localhost:3000
```

Root scripts: `npm run dev` (= `docker compose up --build`), `npm run build` (builds backend and frontend), `npm test`.
