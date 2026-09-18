/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const port = Number(process.env.STAGE_PORT ?? 7420);
const apiPort = Number(process.env.STAGE_API_PORT ?? 7421);

export default defineConfig({
  plugins: [react()],
  server: { port, strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiPort}` } },
  test: { include: ['src/**/*.test.ts', 'server/**/*.test.ts'] },
});
