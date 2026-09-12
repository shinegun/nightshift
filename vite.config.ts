import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = `http://127.0.0.1:${process.env.PORT ?? 4455}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': api, '/s': api, '/t.js': api, '/public': api },
  },
});
