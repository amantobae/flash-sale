import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In docker compose BACKEND_URL is http://backend:3000; locally the backend listens on localhost.
const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:3000';
const proxy = {
  '/health': backendUrl,
  '/api': backendUrl,
  '/socket.io': { target: backendUrl, ws: true },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 5173, strictPort: true, proxy },
});
