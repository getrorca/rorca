/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5210,
  },
  build: {
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
          // Terminal — only pulled by RunView
          if (id.includes('node_modules/@xterm/')) {
            return 'xterm';
          }
          // Command palette
          if (id.includes('node_modules/cmdk')) {
            return 'cmdk';
          }
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
