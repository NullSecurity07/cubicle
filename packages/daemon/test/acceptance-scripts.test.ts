/**
 * §14 acceptance tests 8 and 9 are whole-process scenarios: a real daemon, a real browser, real signals. They
 * live as standalone scripts because they spawn and kill processes, but until now `pnpm test:acceptance` did not
 * run them at all — you had to remember `pnpm test:replay` and `pnpm test:sleep`. These two cases run the same
 * scripts, with the same node flags `package.json` uses, and fail the suite when they do.
 *
 * Each half is skipped only when the machine genuinely cannot run it, and says so on the console rather than
 * passing quietly: test 8 needs a built viewer (`pnpm --filter @cubicle/viewer build`) plus a Playwright
 * Chromium, test 9 needs `dbus-daemon` for the PrepareForSleep half.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');
/** The flags `pnpm test:replay` / `pnpm test:sleep` use, so the scripts run exactly as they do by hand. */
const NODE_FLAGS = ['--import', 'tsx/esm', '--conditions=development'];
const TIMEOUT_MS = 180_000;

function runScript(script: string) {
  const r = spawnSync(process.execPath, [...NODE_FLAGS, path.join(root, 'scripts', script)], {
    cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS - 10_000, env: process.env,
  });
  return { ...r, tail: `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd().split('\n').slice(-25).join('\n') };
}

/** Vitest swallows a bare console.log at collection time, so a skip reason goes straight to stderr. */
function reason(message: string): void { process.stderr.write(`${message}\n`); }

const viewerDist = path.join(root, 'packages', 'viewer', 'dist', 'index.html');
const noViewer = !existsSync(viewerDist);
if (noViewer) reason(`SKIP acceptance test 8: ${viewerDist} is missing — run \`pnpm --filter @cubicle/viewer build\` first.`);

const noDbus = spawnSync('which', ['dbus-daemon']).status !== 0;
if (noDbus) reason('SKIP acceptance test 9: dbus-daemon is not installed — the PrepareForSleep half cannot run.');

describe.skipIf(noViewer)('close the viewer, work, reopen, replay the day', () => {
  it('scripts/test-replay.ts reconstructs the office and shows the stored frames (acceptance test 8)', () => {
    const r = runScript('test-replay.ts');
    expect(r.status, r.tail).toBe(0);
    expect(r.stdout).toContain('PASS:');
  }, TIMEOUT_MS);
});

describe.skipIf(noDbus)('sleep and SIGTERM checkpoint, exit and resume', () => {
  it('scripts/test-sleep.ts checkpoints, exits under 5 s and resumes (acceptance test 9)', () => {
    const r = runScript('test-sleep.ts');
    expect(r.status, r.tail).toBe(0);
    expect(r.stdout).toContain('PASS:');
  }, TIMEOUT_MS);
});
