import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { conditions: ['development'] },
  // '../router/test-setup.ts' refuses any real provider connection and names the test that tried; see its docblock.
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'], setupFiles: ['../router/test-setup.ts'], testTimeout: 30000, hookTimeout: 30000 },
});
