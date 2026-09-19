import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Own ports, a fake model and a throwaway workspace: the checks never touch the owner's running stage or data.
// WebKit is not listed: Playwright's build cannot launch on this machine; the WebKitGTK check belongs to the Tauri slice.
const env = { STAGE_PORT: '7430', STAGE_API_PORT: '7431', STAGE_FAKE_MODEL: '1', STAGE_API_TOKEN: 'e2e-token', STAGE_WORKSPACE: mkdtempSync(join(tmpdir(), 'stage-e2e-')) };

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  workers: 1,
  // `page.request` is a script, not the app's page: it shows the launch token the way any script must.
  use: { baseURL: 'http://localhost:7430', extraHTTPHeaders: { 'x-stage-token': env.STAGE_API_TOKEN } },
  webServer: { command: 'pnpm dev', url: 'http://localhost:7430', env, reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } }],
});
