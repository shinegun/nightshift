import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = `http://127.0.0.1:${process.env.PORT ?? 4455}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    // Anchored: a plain '/api' or '/s' key is a prefix match, and would also send web/api.ts and
    // web/styles.css to the backend, which answers 404 and leaves the dev page blank.
    proxy: { '^/api/': api, '^/s/': api, '^/t\\.js$': api, '^/public/': api },
  },
});
