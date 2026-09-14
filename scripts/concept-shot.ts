/**
 * SP9 concept render.
 *
 * Serves packages/viewer with Vite, opens the standalone concept page in headless Chromium at 1280 x 800 with a
 * device pixel ratio of 2, and saves the two pictures the owner approves the art direction from:
 *
 *   concept-campus.png   the whole open plan at overview zoom, at dusk
 *   concept-room.png     the board room and the pantry at room zoom, at midday
 *
 * Usage: node --import tsx/esm scripts/concept-shot.ts [outDir]   (default .shots/)
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, '.shots');
mkdirSync(out, { recursive: true });

const PORT = 7413;
const viewer = path.join(root, 'packages/viewer');
const vite = spawn(process.execPath, [path.join(viewer, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: viewer,
  stdio: ['ignore', 'pipe', 'pipe'],
});
vite.stderr.on('data', (d: Buffer) => process.stderr.write(`[vite] ${d}`));
// a crash between here and the end used to leave the dev server holding the port, so the next run could not start
const stop = (): void => { if (!vite.killed) vite.kill('SIGTERM'); };
for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException'] as const) process.once(sig, stop);

const ready = await new Promise<boolean>((resolve) => {
  const t = setTimeout(() => resolve(false), 30_000);
  vite.stdout.on('data', (d: Buffer) => {
    const s = d.toString();
    process.stdout.write(`[vite] ${s}`);
    if (s.includes('ready in') || s.includes('Local:')) { clearTimeout(t); resolve(true); }
  });
});
if (!ready) { vite.kill('SIGTERM'); throw new Error('vite did not come up'); }

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'dark' });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}]`, m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('[page exception]', String(e).slice(0, 600)));

for (const [scene, file] of [['campus', 'concept-campus.png'], ['room', 'concept-room.png']] as const) {
  await page.goto(`http://127.0.0.1:${PORT}/concept/index.html?scene=${scene}`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as unknown as { __concept?: { ready: boolean } }).__concept?.ready === true, null, { timeout: 20_000 });
  await page.waitForTimeout(500);
  const zoom = await page.evaluate(() => (window as unknown as { __concept: { zoom: number } }).__concept.zoom);
  await page.screenshot({ path: path.join(out, file) });
  console.log(`shot ${file} (zoom ${zoom.toFixed(3)})`);
}

await browser.close();
vite.kill('SIGTERM');
