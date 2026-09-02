import { defineConfig } from 'vite';
export default defineConfig({
  server: { port: 7412, strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist', target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 2000 },
  test: { include: ['src/**/*.test.ts'] },
});
