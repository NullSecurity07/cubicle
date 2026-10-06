import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Own ports, a fake model and a throwaway workspace: the checks never touch the owner's running stage or data.
// WebKit is not listed: Playwright's build cannot launch on this machine; the WebKitGTK check belongs to the Tauri slice.
// Made once, by the process that starts the server, and put on the environment so the workers inherit the same path:
// a journey that has to seed files (the playbook with a shelf-full of skills) writes them where the server reads them.
process.env.STAGE_WORKSPACE ??= mkdtempSync(join(tmpdir(), 'stage-e2e-'));
// A folder of its own, outside the checkout, that the api also watches: a journey that has to see the app restart
// under a person writes a file in here. Nothing of the repository is ever written to, so the founder's own app —
// which watches `server` and `shared` from their working copy — is never restarted by a check running beside it.
process.env.STAGE_RESTART_DIR ??= mkdtempSync(join(tmpdir(), 'stage-e2e-restart-'));
// The api watches only that folder, never the code: an edit under server/ mid-run no longer restarts it under a journey.
// Several checkouts may run their checks at once (one worktree per piece of work), so the pair of ports can be moved.
const web = Number(process.env.E2E_PORT ?? 7430);
const env = { STAGE_PORT: String(web), STAGE_API_PORT: String(web + 1), STAGE_FAKE_MODEL: '1', STAGE_NO_ENV_FILE: '1', STAGE_API_TOKEN: 'e2e-token', STAGE_WORKSPACE: process.env.STAGE_WORKSPACE, STAGE_RESTART_DIR: process.env.STAGE_RESTART_DIR, STAGE_NO_CODE_WATCH: '1' };

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  workers: 1,
  // `page.request` is a script, not the app's page: it shows the launch token the way any script must.
  use: { baseURL: `http://localhost:${web}`, extraHTTPHeaders: { 'x-stage-token': env.STAGE_API_TOKEN } },
  webServer: { command: 'pnpm dev', url: `http://localhost:${web}`, env, reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } }],
});
