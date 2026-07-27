import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const BACKEND = process.env.VITE_BACKEND ?? 'http://localhost:8000';

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
      '/api':       { target: BACKEND, changeOrigin: true },
      '/games':     { target: BACKEND, changeOrigin: true },
      '/socket.io': { target: BACKEND, changeOrigin: true, ws: true },
    },
  },
});
