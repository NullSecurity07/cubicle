/**
 * Acceptance test 8: close the viewer, run work that opens a browser (frames stored), reopen the viewer → office
 * reconstructs from the snapshot; replay of the day shows the stored frames on the billboard.
 * Usage: pnpm test:replay   (headless Chromium; local test page; no external network)
 */
import http from 'node:http';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scaffoldVault, createJob, readJob, RoleFrontmatter, parseNote } from '@cubicle/core';
import type { RoutedChatResult } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig } from '@cubicle/daemon';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-replay-'));
const site = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body style="background:#ffe"><h1>Hello from the test page</h1><p>frames should be captured</p></body></html>'); });
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
const sitePort = (site.address() as { port: number }).port;

const { vault } = await scaffoldVault(dir);
vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } });
const jobId = createJob(vault, { type: 'research', title: 'Look at the test page', assigned: 'cmo', goal: 'browse' }, 'cto');
vault.close();
// scripted head of growth: open the page, extract, close, finish
const steps = [{ name: 'browser.open', args: { url: `http://127.0.0.1:${sitePort}/` } }, { name: 'browser.extract', args: {} }, { name: 'browser.close', args: {} }, { name: 'finish', args: { status: 'done', summary: 'looked' } }];
const llm: Llm = {
  async chat(req, chat): Promise<RoutedChatResult> {
    const base = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
    if (!chat.tools) return base;
    if (req.roleId !== 'cmo') return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'x' } }] };
    const m = String(chat.messages[1]?.content ?? '').match(/Jobs\/(job_\w+)\.md/);
    const v = new (await import('@cubicle/core')).Vault.constructor as unknown; void v;
    const { Vault } = await import('@cubicle/core');
    const vv = Vault.open(dir); const j = m ? readJob(vv, m[1]) : null; vv.close();
    const step = j?.data.checkpoint_step ?? 0;
    return { ...base, parsedToolCalls: [steps[Math.min(step, steps.length - 1)]] };
  },
  promptBudget: () => 6000,
};
const d = new Daemon(defaultConfig(dir, { ...process.env, CUBICLE_ALLOW_LOCAL_FETCH: '1' }, { port: 0, tickMs: 1000, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableSleepWatch: true, memory: false, log: () => undefined });
await d.start();
const token = d.ws!.token;
const webPort = d.config.port + 1; // port 0 binds an ephemeral port; d.config.port is the real one after start()
// "viewer closed" — nothing connected while the job runs
const t0 = Date.now();
while (Date.now() - t0 < 60_000 && readJob(d.vault, jobId)!.data.status !== 'done') await new Promise((r) => setTimeout(r, 300));
const frames = d.vault.events.count('browser.frame');
console.log(`job ${readJob(d.vault, jobId)!.data.status}; browser frames stored: ${frames}`);
let pass = frames >= 1;
// "reopen": fresh viewer, snapshot + replay
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const today = new Date().toISOString().slice(0, 10);
await page.goto(`http://127.0.0.1:${webPort}/?token=${token}&replay=${today}`, { waitUntil: 'load' });
await page.waitForTimeout(4000);
type Tile = { tx: number; ty: number };
type Dbg = {
  __cubicle: {
    state: { agents: Record<string, { active: boolean }>; mode: string; surfaces: Record<string, { lastFrame?: string }> };
    agents: () => { role: string; desk: string; home: Tile; tile: Tile }[];
    desks: () => Record<string, Tile>;
    stand: (name: string) => Tile | null;
    surfaces: () => Record<string, { streamKind: string; streamId: string; lastFrame: string | null; image: string | null }>;
  };
};
const snapshotOk = await page.evaluate(() => { const w = window as unknown as Dbg; return { roles: Object.keys(w.__cubicle.state.agents).length, mode: w.__cubicle.state.mode, surfaces: Object.values(w.__cubicle.state.surfaces).map((s) => s.lastFrame) }; });
console.log('viewer after reopen:', JSON.stringify(snapshotOk));
if (snapshotOk.roles < 5) pass = false;
// "the office reconstructs correctly" is more than a role count: every sprite must have sat down at its own
// desk. A role whose desk anchor is missing from the map falls back to the door tile (world/agents.ts
// homeTile), which is exactly the stale-map failure a role count cannot see.
const desks = await page.evaluate(() => {
  const w = window as unknown as Dbg;
  const all = w.__cubicle.desks();
  // the exact tile homeTile() falls back to when a desk anchor is missing
  return { door: w.__cubicle.stand('door'), sprites: w.__cubicle.agents().map((a) => ({ role: a.role, desk: a.desk, home: a.home, anchor: all[a.desk] ?? null })) };
});
const homeless = desks.sprites.filter((s) => !s.desk || !s.anchor || s.home.tx !== s.anchor.tx || s.home.ty !== s.anchor.ty);
const atDoor = desks.sprites.filter((s) => desks.door && s.home.tx === desks.door.tx && s.home.ty === desks.door.ty);
console.log(`desks: ${desks.sprites.length} sprites, ${homeless.length} not homed on their desk anchor, ${atDoor.length} homed at the door`);
if (desks.sprites.length < 5 || homeless.length > 0 || atDoor.length > 0) { console.log('sprites without a desk:', JSON.stringify(homeless.concat(atDoor))); pass = false; }
// scrub to the end so every frame event is applied, then read the billboard image
await page.evaluate(() => { const el = document.getElementById('scrub') as HTMLInputElement; el.value = '1000'; el.dispatchEvent(new Event('input')); });
await page.waitForTimeout(1500);
const shown = await page.evaluate(() => { const w = window as unknown as { __cubicle: { state: { mode: string; frames: Record<string, { path?: string }> } } }; return { mode: w.__cubicle.state.mode, frames: Object.values(w.__cubicle.state.frames).map((f) => f.path) }; });
console.log('replay state:', JSON.stringify(shown));
const framePath = shown.frames[0];
if (shown.mode !== 'replay' || !framePath) pass = false;
// …and the frame has to be on the *billboard*: ask the surface registry which stream that surface is bound to
// and check it carries a stored frame and an image to draw. A frame in state.frames that no surface shows is
// exactly the regression this half is meant to catch.
const billboard = (await page.evaluate(() => (window as unknown as Dbg).__cubicle.surfaces()))['billboard'];
console.log('billboard surface:', JSON.stringify(billboard));
if (!billboard || billboard.streamKind !== 'browser' || !billboard.streamId || !billboard.lastFrame || !billboard.image?.includes('/screens/')) pass = false;
if (framePath) {
  const res = await page.request.get(`http://127.0.0.1:${webPort}/screens/${framePath.replace('.cubicle/screens/', '')}?token=${token}`);
  const noTok = await fetch(`http://127.0.0.1:${webPort}/screens/${framePath.replace('.cubicle/screens/', '')}`); // cookie-less client
  console.log(`frame without token/cookie: HTTP ${noTok.status}`); if (noTok.status !== 403) pass = false;
  console.log(`billboard frame served: HTTP ${res.status()} ${res.headers()['content-type']}`);
  if (res.status() !== 200) pass = false;
}
await page.click('#game', { position: { x: 20, y: 400 } }).catch(() => undefined);
await page.screenshot({ path: path.join(root, '.shots', 'replay.png') }).catch(() => undefined);
await browser.close();
await d.stop();
site.close();
rmSync(dir, { recursive: true, force: true });
console.log(pass ? 'PASS: office reconstructed after reopen; replay carries stored browser frames on the billboard' : 'FAIL');
process.exit(pass ? 0 : 1);
