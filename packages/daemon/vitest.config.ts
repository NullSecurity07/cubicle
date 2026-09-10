import { defineConfig, configDefaults } from 'vitest/config';
export default defineConfig({
  resolve: { conditions: ['development'] },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Whole-process scenarios (real daemons, headless Chromium, fixed ports): ~100 s and racy under file parallelism.
    // They belong to the root `pnpm test:acceptance` run, which runs files one at a time.
    exclude: [...configDefaults.exclude, 'test/acceptance-scripts.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
