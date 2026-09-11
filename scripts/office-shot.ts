/**
 * Visual check for the office: starts a daemon on a temp vault with a scripted model, opens the viewer in headless
 * Chromium, injects a burst of events, and saves screenshots to .cubicle/shots/ in the temp vault (paths printed).
 * Usage: pnpm office:shot [outDir] — always go through the script, never `tsx scripts/office-shot.ts` directly: the
 * daemon serves the viewer's built `dist/`, so `office:shot` rebuilds the viewer first. A stale `dist/` makes every
 * screenshot a claim about last night's code.
 *
 * Scenes 02–09 live here; 01 and 10–13 are the overlay plan's and are appended with the same `shot()` helper.
 */
import path from 'node:path';
import { mkdtempSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scaffoldVault, createProposal } from '@cubicle/core';
import type { RoutedChatResult } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig } from '@cubicle/daemon';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, '.shots');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-shot-'));
const { vault } = await scaffoldVault(dir);
vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } });
vault.close();
const llm: Llm = { async chat(): Promise<RoutedChatResult> { await new Promise((r) => setTimeout(r, 400)); return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'ok' } }] }; }, promptBudget: () => 6000 };
const d = new Daemon(defaultConfig(dir, process.env, { port: 7511, tickMs: 5000, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableSleepWatch: true, memory: false, log: (m) => console.log(`[daemon] ${m}`) });
await d.start();
const token = d.ws!.token;
const { chromium } = await import('playwright');
// Headless Chromium draws through SwiftShader by default, which renders the office at ~10 fps: the frame-rate gate at
// the bottom would then measure the software rasteriser instead of the renderer (measured here: 10 fps on SwiftShader
// against 61 on the GPU, same build). Ask ANGLE for the real device; a machine without one falls back to SwiftShader
// by itself, and the logged `gl:` line says which one produced the number.
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[page exception]', String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:7512/?token=${token}`, { waitUntil: 'load' });
await page.waitForTimeout(2500);
type Cub = { __cubicle: { agents: () => unknown; anchors: () => Record<string, unknown>; floor: (n: number) => void; elevator: () => unknown; setHour: (h: number | null) => void; fps: () => number; open: (k: string) => void } };
/** Run `fn` inside the page against `window.__cubicle`. `fn` crosses over as source text, so it can close over
 *  nothing from this script: whatever it needs (a floor number, an hour) is passed as `arg` and arrives as its
 *  second parameter. */
const cub = <T, A = undefined>(fn: (c: Cub['__cubicle'], arg: A) => T, arg?: A): Promise<T> => page.evaluate(([src, a]) => { const c = (window as unknown as Cub).__cubicle; return (new Function('c', 'a', `return (${src})(c, a)`))(c, a); }, [fn.toString(), arg] as [string, A | undefined]) as Promise<T>;
const shot = async (name: string, settleMs = 900): Promise<void> => { await page.waitForTimeout(settleMs); await page.screenshot({ path: path.join(out, `${name}.png`) }); console.log(`shot ${name}`); };

// An empty company opens the first-run card in the CEO drawer (spec §12 d/e), which covers the right third of the
// office. That card is the overlay plan's `01-first-run` shot; scenes 02–09 are about the office behind it, so
// dismiss it once here — the drawer is opened once per session and does not come back.
await page.keyboard.press('Escape');
// 02: the lobby with the whole tower's ground floor
await cub((c) => c.floor(1));
await shot('02-lobby');
// a burst of work so every floor has something to show: CMO browses (F4), backend engineer shells (F2), CEO speaks (F1), QA lead deploys (F3)
const ev = d.vault.events;
const g = 'job_demo_cmo';
ev.emit({ type: 'job.queued', agent: 'ceo', job: g, payload: { type: 'growth.post', title: 'Find a channel', assigned: 'cmo' } });
ev.emit({ type: 'job.started', agent: 'cmo', job: g, payload: { type: 'growth.post', title: 'Find a channel' } });
ev.emit({ type: 'agent.tool_call', agent: 'cmo', job: g, payload: { tool: 'browser.goto', summary: '{"url":"https://example.com"}', step: 1 } });
ev.emit({ type: 'browser.session_started', agent: 'cmo', job: g, payload: { session: 'demo' } });
const e = 'job_demo_backend';
ev.emit({ type: 'job.queued', agent: 'dev_manager', job: e, payload: { type: 'engineer.ship', title: 'Build site', assigned: 'backend_engineer' } });
ev.emit({ type: 'job.started', agent: 'backend_engineer', job: e, payload: { type: 'engineer.ship', title: 'Build site' } });
ev.emit({ type: 'agent.tool_call', agent: 'backend_engineer', job: e, payload: { tool: 'shell.run', summary: 'npm run build', step: 1 } });
ev.emit({ type: 'shell.output', agent: 'backend_engineer', job: e, payload: { session: 's', stream: 'stdout', text: '> astro build\n✓ 3 pages built in 412ms' } });
const q = 'job_demo_qa';
ev.emit({ type: 'job.queued', agent: 'cto', job: q, payload: { type: 'engineer.ship', title: 'Release 0.2', assigned: 'qa_lead' } });
ev.emit({ type: 'job.started', agent: 'qa_lead', job: q, payload: { type: 'engineer.ship', title: 'Release 0.2' } });
ev.emit({ type: 'agent.tool_call', agent: 'qa_lead', job: q, payload: { tool: 'deploy.site', summary: '{}', step: 1 } });
ev.emit({ type: 'agent.spoke', agent: 'ceo', job: null, payload: { to: 'owner', text: 'I proposed the name WeekPlate — approve it in 00 Inbox/.' } });
createProposal(d.vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'Name the company: WeekPlate', body: 'x' }, 'ceo');
await page.waitForTimeout(5000);
// 03..06: one shot per floor
for (const n of [1, 2, 3, 4]) { await cub((c, f: number) => c.floor(f), n); await shot(`0${n + 2}-f${n}`); }
console.log('agents:', JSON.stringify(await cub((c) => c.agents())));
// 07: a cross-floor ride: a failed job on F2 sends the COO (F4) down to the engineer's desk
ev.emit({ type: 'job.failed', agent: 'backend_engineer', job: e, payload: { reason: 'step_limit' } });
// The COO walks from her office on F4 to the shaft before the car moves at all, and how long that walk takes depends
// on the machine. Wait for the ride itself — a car in motion, or the COO queued at a door — rather than for a guessed
// number of milliseconds, or the shot catches an idle shaft and proves nothing.
// `moving` specifically, not merely `waiting`: this shot is the one that proves the doors stay shut while the car
// travels, and a car still parked with the COO queued three floors up proves nothing.
await page.waitForFunction(() => ((window as unknown as Cub).__cubicle.elevator() as { status: string }).status === 'moving', undefined, { timeout: 30000, polling: 50 });
await cub((c) => c.floor(3));
console.log('elevator:', JSON.stringify(await cub((c) => c.elevator())));
await shot('07-elevator', 300);
// 08: a board meeting on F1 with the owner in the chair
ev.emit({ type: 'meeting.opened', agent: 'ceo', job: null, payload: { id: 'm1', room: 'board', participants: ['ceo', 'advisor_skeptic', 'advisor_investor', 'advisor_customer'], agenda: 'Two jobs failed' } });
await page.waitForTimeout(4500);
ev.emit({ type: 'meeting.turn', agent: 'advisor_skeptic', job: null, payload: { id: 'm1', round: 1, text: 'Let us cut the queue to one job per role.' } });
await cub((c) => c.floor(1));
await shot('08-board', 1500);
// 09: the same office at night: lamps only where someone works
await cub((c) => c.setHour(22));
await cub((c) => c.floor(2));
await shot('09-night', 1200);
await cub((c) => c.setHour(null));
// `actualFps` is a rolling average, and the screenshot just before it stalls the GPU on a read-back. Let the loop run
// clean for a couple of seconds first, or the number reported is the cost of taking the picture, not of drawing the office.
await page.waitForTimeout(2500);
// Which GL produced the number below — the gate is only meaningful on the GPU path. `page.evaluate` is handed source
// text here, not a function: tsx rewrites named inner functions to call an `__name` helper that does not exist in the
// page, so any callback with a named binding throws `__name is not defined`. (`cub` dodges this the same way.)
console.log('gl:', await page.evaluate(`(() => { const gl = document.createElement('canvas').getContext('webgl'); const x = gl && gl.getExtension('WEBGL_debug_renderer_info'); return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`));
const fps = await cub((c) => c.fps());
console.log(`fps: ${fps}`);
await page.click('#game', { position: { x: 640, y: 400 } }).catch(() => undefined);
await browser.close();
console.log(`screenshots in ${out}`);
await d.stop();
// Budget gate (visual notes §4): the tray wants ≥ 55 fps at 1280×800; headless Chromium with software GL is slower,
// so the script fails only under 30 — low enough to be a real regression, high enough to catch a per-frame redraw.
if (fps < 30) { console.error(`fps ${fps} is under 30`); process.exit(1); }
process.exit(0);
