import { defineConfig } from 'vite';
export default defineConfig({
  server: { port: 7412, strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist', target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 2000 },
  // The viewer has no provider code and no `@cubicle/*` dependency, but it runs the same guard as every other
  // package so that "every suite is isolated" is true by construction rather than by inspection. The setup file
  // is loaded by path and its guard module is dependency-free, so this costs the viewer nothing.
  test: { include: ['src/**/*.test.ts'], setupFiles: ['../router/test-setup.ts'] },
});
