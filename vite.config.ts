import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

/**
 * Upstream the dev server proxies API traffic to.
 *
 * WHY A PROXY AT ALL, when `VITE_API_BASE` already names an absolute URL:
 * the gateway's CORS allowlist contains the deployed web origins only.
 * `https://ocva.online` gets an `Access-Control-Allow-Origin` header back;
 * `http://localhost:5173` gets none, so the browser blocks every call and the
 * app shows "Could not reach the server". Proxying makes the request
 * SAME-ORIGIN from the browser's point of view, and Vite forwards it
 * server-side where CORS does not apply.
 *
 * To use it, set `VITE_API_BASE=http://localhost:5173` in `.env.development`.
 * The permanent fix is to add the dev origin to the gateway's allowlist; then
 * `VITE_API_BASE` can point straight at the API and this proxy goes unused.
 */
const API_UPSTREAM = process.env.VITE_DEV_API_PROXY ?? 'https://api.ocva.online';

/** Every path prefix the backend serves (INTEGRATION.md §3). */
const API_PREFIXES = ['/auth', '/api', '/games', '/wager', '/rpc'];

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'stream', 'events'],
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  optimizeDeps: {
    exclude: ['bufferutil', 'utf-8-validate'],
  },
  build: {
    rollupOptions: {
      external: ['bufferutil', 'utf-8-validate'],
    },
  },
  server: {
    port: 5173,
    proxy: {
      ...Object.fromEntries(
        API_PREFIXES.map((p) => [p, { target: API_UPSTREAM, changeOrigin: true, secure: true }]),
      ),
      // The boardgame.io match transport. `ws: true` is required — without it
      // the upgrade request is proxied as plain HTTP and the socket never opens.
      '/socket.io': { target: API_UPSTREAM, changeOrigin: true, secure: true, ws: true },
    },
  },
});
