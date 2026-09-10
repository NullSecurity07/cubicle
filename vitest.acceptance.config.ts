import { defineConfig } from 'vitest/config';
// `pnpm test:acceptance` — runs every test tagged "(acceptance test N)" across the workspace (spec §14).
export default defineConfig({
  resolve: { conditions: ['development'] },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/viewer/src/**/*.test.ts'],
    testNamePattern: /acceptance test/,
    // Tests 8, 8b and 9 spawn whole daemons on fixed ports: files run one at a time so they never race for them.
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
