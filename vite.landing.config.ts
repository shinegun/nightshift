import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The public landing page. Built on its own so the public endpoint serves this bundle and
// nothing of the dashboard's. Dev: `npm run dev:landing`, then http://localhost:5174.
export default defineConfig({
  root: 'web/landing',
  plugins: [react()],
  build: { outDir: '../../dist/landing', emptyOutDir: true },
  server: { port: 5174 },
});
