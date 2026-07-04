/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // appType 'spa' (default) enables history API fallback — Vite serves index.html
  // for all non-file requests, so browser refresh on /forge, /pipeline, etc. works.
  appType: 'spa',
  server: {
    port: 5210,
    proxy: {
      // WebSocket proxy for terminal sessions
      '/ws': {
        target: 'ws://localhost:3030',
        ws: true,
      },
    },
  },
  build: {
    // Inject modulepreload hints for dynamically imported chunks
    modulePreload: { polyfill: true },
    // Target modern browsers — avoid legacy polyfills that bloat main bundle
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks(id) {
          // React core — shared by everything, cached aggressively
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'react';
          }
          // Charting library — only pulled by analytics panels
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) {
            return 'charts';
          }
          // Command palette — lazy loaded, separate chunk
          if (id.includes('node_modules/cmdk')) {
            return 'cmdk';
          }
          // Lucide icons — tree-shaken but used widely; separate chunk
          if (id.includes('node_modules/lucide-react')) {
            return 'icons';
          }
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts', './src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'shared/**/*.test.{ts,tsx}'],
  },
});
