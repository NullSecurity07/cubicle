import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { conditions: ['development'] },
  test: { include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'], testTimeout: 30000, hookTimeout: 30000 },
});
