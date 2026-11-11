import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server runs on 5173 because that is what `FRONTEND_URL` in
 * `backend/.env.example` points at, and that value is baked into invite emails,
 * password-reset links and every QR code the backend generates. Changing the
 * port here means changing it there too.
 *
 * `/api` is proxied to the Flask dev server so local development is same-origin:
 * no CORS preflight, and `VITE_API_URL` can stay empty. A deployed build talks to
 * an absolute origin instead — set `VITE_API_URL` at build time and make sure that
 * origin is listed in the backend's `CORS_ORIGINS`.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:5000',
        changeOrigin: true,
      },
      '/healthz': {
        target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:5000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
