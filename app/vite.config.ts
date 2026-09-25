/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const port = Number(process.env.STAGE_PORT ?? 7420);
const apiPort = Number(process.env.STAGE_API_PORT ?? 7421);

export default defineConfig({
  plugins: [react()],
  server: { port, strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiPort}` } },
  // Twenty seconds a test, not five: the suite runs sixteen workers at once and shares the disk with whatever else the
  // machine is doing (the owner's local model server, a film render, another check), and a test that writes a few
  // files can wait longer than five seconds for the disk under that load. A test that hangs still fails.
  test: { include: ['src/**/*.test.ts', 'server/**/*.test.ts', 'shared/**/*.test.ts'], testTimeout: 20_000, hookTimeout: 20_000 },
});
