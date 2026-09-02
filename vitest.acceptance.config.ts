import { defineConfig } from 'vitest/config';
// `pnpm test:acceptance` — runs every test tagged "(acceptance test N)" across the workspace (spec §14).
export default defineConfig({
  resolve: { conditions: ['development'] },
  test: { include: ['packages/*/test/**/*.test.ts'], testNamePattern: /acceptance test/, testTimeout: 60000, hookTimeout: 60000 },
});
