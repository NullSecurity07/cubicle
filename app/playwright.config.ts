import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Own ports, a fake model and a throwaway workspace: the checks never touch the owner's running stage or data.
// WebKit is not listed: Playwright's build cannot launch on this machine; the WebKitGTK check belongs to the Tauri slice.
// Made once, by the process that starts the server, and put on the environment so the workers inherit the same path:
// a journey that has to seed files (the playbook with a shelf-full of skills) writes them where the server reads them.
process.env.STAGE_WORKSPACE ??= mkdtempSync(join(tmpdir(), 'stage-e2e-'));
// Several checkouts may run their checks at once (one worktree per piece of work), so the pair of ports can be moved.
const web = Number(process.env.E2E_PORT ?? 7430);
const env = { STAGE_PORT: String(web), STAGE_API_PORT: String(web + 1), STAGE_FAKE_MODEL: '1', STAGE_API_TOKEN: 'e2e-token', STAGE_WORKSPACE: process.env.STAGE_WORKSPACE };

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  workers: 1,
  // `page.request` is a script, not the app's page: it shows the launch token the way any script must.
  use: { baseURL: `http://localhost:${web}`, extraHTTPHeaders: { 'x-stage-token': env.STAGE_API_TOKEN } },
  webServer: { command: 'pnpm dev', url: `http://localhost:${web}`, env, reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } }],
});
