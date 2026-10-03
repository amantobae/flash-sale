FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 5173

CMD ["node_modules/.bin/vite", "preview", "--host", "0.0.0.0"]
