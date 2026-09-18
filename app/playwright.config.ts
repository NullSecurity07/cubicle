import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Own ports, a fake model and a throwaway workspace: the checks never touch the owner's running stage or data.
// WebKit is not listed: Playwright's build cannot launch on this machine; the WebKitGTK check belongs to the Tauri slice.
const env = { STAGE_PORT: '7430', STAGE_API_PORT: '7431', STAGE_FAKE_MODEL: '1', STAGE_WORKSPACE: mkdtempSync(join(tmpdir(), 'stage-e2e-')) };

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  workers: 1,
  use: { baseURL: 'http://localhost:7430' },
  webServer: { command: 'pnpm dev', url: 'http://localhost:7430', env, reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } }],
});
