FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production \
  PRISMA_HIDE_UPDATE_MESSAGE=1
EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/server.js"]
