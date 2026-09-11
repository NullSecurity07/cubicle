/**
 * Visual check for the tower: starts a daemon on a temp vault with a scripted model, opens the viewer in headless
 * Chromium, injects a burst of events, and saves the thirteen scenes of docs/office-visual-checklist.md to <outDir>
 * (default .shots/).
 * Usage: pnpm office:shot [outDir] — always go through the script, never `tsx scripts/office-shot.ts` directly: the
 * daemon serves the viewer's built `dist/`, so `office:shot` rebuilds the viewer first. A stale `dist/` makes every
 * screenshot a claim about last night's code.
 *
 * The scenes, in the checklist's own order and under its own names:
 *   01-first-run  02-lobby  03-f1  04-f2  05-f3  06-f4  07-elevator  08-board
 *   09-night  10-browser-live  11-terminal  12-light-theme  13-stack
 * Order is not free. `01-first-run` has to come before the Escape that dismisses the card, because the card is shown
 * once per session and never returns; `09-night` has to come before the shell burst that scene 11 needs, because that
 * burst walks the one lit engineer out of her room. The frame-rate reading sits between 09 and 10, on the bare office
 * with no panel over it, so the number is the cost of drawing the tower rather than of compositing an HTML sheet.
 */
import path from 'node:path';
import { mkdtempSync, mkdirSync } from 'node:fs';
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
// by itself, and the logged `gl:` line says which one produced the number — the gate is skipped on that path.
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[page exception]', String(e).slice(0, 200)));

type Tile = { tx: number; ty: number };
type Cub = { __cubicle: { state: { jobs: Record<string, { id: string; title: string; status: string }> }; agents: () => unknown; floor: (n: number) => void; elevator: () => unknown; stand: (name: string) => Tile | null; setHour: (h: number | null) => void; fps: () => number; open: (k: string) => void; zoom: (z: number) => void; center: (tx: number, ty: number) => void; theme: (m: 'dark' | 'light' | 'system') => void; stack: () => { kind: string; title: string }[]; pushFrame: (id: string, dataUrl: string) => void } };
/** Run `fn` inside the page against `window.__cubicle`. `fn` crosses over as source text, so it can close over
 *  nothing from this script: whatever it needs (a floor number, an hour) is passed as `arg` and arrives as its
 *  second parameter. */
const cub = <T, A = undefined>(fn: (c: Cub['__cubicle'], arg: A) => T, arg?: A): Promise<T> => page.evaluate(([src, a]) => { const c = (window as unknown as Cub).__cubicle; return (new Function('c', 'a', `return (${src})(c, a)`))(c, a); }, [fn.toString(), arg] as [string, A | undefined]) as Promise<T>;
const shot = async (name: string, settleMs = 900): Promise<void> => { await page.waitForTimeout(settleMs); await page.screenshot({ path: path.join(out, `${name}.png`) }); console.log(`shot ${name}`); };
const failures: string[] = [];
const fail = (m: string): void => { failures.push(m); console.log(`FAIL: ${m}`); };
/** A pushable browser frame, drawn in the page. `page.evaluate` is handed source text, not a function: tsx rewrites
 *  named inner bindings to call a `__name` helper that does not exist in the page. (`cub` dodges this the same way.) */
const frameUrl = (n: number): Promise<string> => page.evaluate(`(() => { const c = document.createElement('canvas'); c.width = 640; c.height = 400; const g = c.getContext('2d'); const grad = g.createLinearGradient(0, 0, 640, 400); grad.addColorStop(0, '#2b5fc7'); grad.addColorStop(1, '#1f7a33'); g.fillStyle = grad; g.fillRect(0, 0, 640, 400); g.fillStyle = '#ffffff'; g.font = 'bold 34px sans-serif'; g.fillText('example.com \\u00b7 frame ${n}', 40, 210); return c.toDataURL('image/png'); })()`) as Promise<string>;
/** Pop the panel stack back to the office. Escape goes through the stack's own handler — nothing here edits state. */
const closePanels = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    if ((await cub((c) => c.stack().length)) === 0) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
};

let fps = 0;
let gl = 'unknown';
try {
  await page.goto(`http://127.0.0.1:7512/?token=${token}`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // 01: an empty company asks the one question (spec §12 d/e). The card is centred over the office and is shown once
  // per session, so it is the first scene and the Escape that dismisses it comes after — never before.
  await page.waitForSelector('#firstrun:not([hidden])', { timeout: 15000 }).catch(() => fail('01: the first-run card did not appear on a fresh vault'));
  await shot('01-first-run', 600);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  if (await page.$eval('#firstrun', (el) => !(el as HTMLElement).hidden).catch(() => false)) fail('01: Escape did not dismiss the first-run card');
  await closePanels();   // if the card handed over to the cabin sheet, pop it the same way a user would

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
  // on the machine. Wait for the ride itself — a car in motion — rather than for a guessed number of milliseconds, or
  // the shot catches an idle shaft and proves nothing. `moving` specifically, not merely `waiting`: this shot is the
  // one that proves the doors stay shut while the car travels, and a car still parked proves nothing.
  // A raw Playwright timeout here would skip the daemon shutdown below, so turn it into a throw the try/finally owns.
  await page.waitForFunction(() => ((window as unknown as Cub).__cubicle.elevator() as { status: string }).status === 'moving', undefined, { timeout: 30000, polling: 50 })
    .catch(() => { throw new Error('07: the car never moved'); });
  const elev = await cub((c) => c.elevator()) as { row: number };
  console.log('elevator:', JSON.stringify(elev));
  // A floor fit is zoom 1, at which the car is 48 px tall and its doors are a smear. This shot is the one that has to
  // prove the doors stay shut in transit, so frame the shaft itself; `row` is where the car was a moment ago, and it
  // keeps climbing, so centre one tile ahead of it and settle briefly. `zoom`/`center` set the camera outright while
  // `floor(n)` tweens it, so they cannot be combined: a `floor(n)` here would tween straight back over them.
  await cub((c) => c.zoom(3));
  // The car covers about nine tiles a second, so a row read even a fraction of a second early frames it off-centre:
  // zoom first, then read the row and centre on it in the same step as the shot. It hangs three tiles below `row`,
  // and the shaft is centred on 52.5.
  await cub((c) => { const r = (c.elevator() as { row: number }).row; c.center(52.5, r + 1.5); });
  await shot('07-elevator', 0);

  // 08: a board meeting on F1 with the owner in the chair
  ev.emit({ type: 'meeting.opened', agent: 'ceo', job: null, payload: { id: 'm1', room: 'board', participants: ['ceo', 'advisor_skeptic', 'advisor_investor', 'advisor_customer'], agenda: 'Two jobs failed' } });
  await page.waitForTimeout(4500);
  await cub((c) => c.floor(1));
  await page.waitForTimeout(1500);
  // The checklist asks this shot for the owner's "You" label, the advisors' glasses and crisp text at zoom 3, and a
  // floor fit is zoom 1: at that size a head is eight pixels and none of the three can be judged. So frame the table.
  // `zoom`/`center` set the camera outright while `floor(n)` tweens it — a `floor(n)` after them tweens straight back.
  const seat = await cub((c) => c.stand('boardroom'));
  if (!seat) fail('08: the map has no stand tile for the boardroom, so the shot is a floor fit');
  await cub((c) => c.zoom(3));
  if (seat) await cub((c, s: Tile) => c.center(s.tx, s.ty - 1), seat);
  // The spoken turn goes last, not with `meeting.opened`: a bubble times out after a few seconds, and the walk to the
  // table plus the camera framing above eat more than that. Emitted here, it is still up when the shutter opens —
  // which is the point, since this is the shot that has to show a bubble not colliding with a room label.
  ev.emit({ type: 'meeting.turn', agent: 'advisor_skeptic', job: null, payload: { id: 'm1', round: 1, text: 'Let us cut the queue to one job per role.' } });
  await shot('08-board', 1200);

  // 09: the same office at night: lamps only where someone works
  // Lamps light a room that holds an agent in `working` or `talking` state, and scene 07's failure sent the only
  // worker on F2 idle. Put a frontend engineer on a job — queued and started, with no tool call, so she stays at her
  // desk in the Dev room instead of walking off to the terminal — and the Dev room is lit while Sales beside it is not.
  const w = 'job_demo_night';
  ev.emit({ type: 'job.queued', agent: 'dev_manager', job: w, payload: { type: 'engineer.ship', title: 'Fix the build', assigned: 'frontend_engineer' } });
  ev.emit({ type: 'job.started', agent: 'frontend_engineer', job: w, payload: { type: 'engineer.ship', title: 'Fix the build' } });
  await cub((c) => c.setHour(22));
  await cub((c) => c.floor(2));
  await shot('09-night', 1200);
  await cub((c) => c.setHour(null));

  // The frame rate, measured here rather than at the end: every scene from 10 on has an HTML sheet over the canvas,
  // and `actualFps` is a rolling average, so a reading taken there would be about compositing, not about the office.
  // The screenshot just before it also stalls the GPU on a read-back — let the loop run clean for a couple of seconds.
  gl = String(await page.evaluate(`(() => { const gl = document.createElement('canvas').getContext('webgl'); const x = gl && gl.getExtension('WEBGL_debug_renderer_info'); return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`));
  console.log('gl:', gl);
  // Best of three windows, not one. `actualFps` is a rolling average, and this box runs the screenshot script beside
  // whatever else is building: a single sample taken in someone else's compile reads 22 where the next reads 58, and
  // the gate below would then fail a build that draws fine. Three clean windows and the best of them answers the only
  // question the gate asks — can the office hold 30 fps when the machine lets it — without lowering the bar.
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(2500);
    const sample = await cub((c) => c.fps());
    console.log(`fps sample ${i + 1}: ${sample}`);
    fps = Math.max(fps, sample);
    if (fps >= 30) break;
  }
  console.log(`fps: ${fps}`);

  // 10: the browser viewer, live. Three pushed frames give it a seq, an fps readout and the amber LIVE badge; the
  // 'demo' session opened in the burst above is still active, so nothing here has to fake the badge.
  for (const n of [1, 2, 3]) { await cub((c, u: string) => c.pushFrame('demo', u), await frameUrl(n)); await page.waitForTimeout(240); }
  await cub((c) => c.open('billboard'));
  await shot('10-browser-live', 900);
  await closePanels();

  // 11: the terminal viewer. The night job left the frontend engineer at her desk with no tool, and the caret only
  // shows while a shell is running, so send her to the terminal first — after 09, never before it.
  ev.emit({ type: 'agent.tool_call', agent: 'frontend_engineer', job: w, payload: { tool: 'shell.run', summary: 'pnpm test', step: 2 } });
  // The tool call already prints its own `$ pnpm test` prompt line, so the output starts at the command's first line.
  ev.emit({ type: 'shell.output', agent: 'frontend_engineer', job: w, payload: { session: 's', stream: 'stdout', text: '> vitest run\n Test Files  18 passed (18)\n      Tests  204 passed (204)' } });
  await page.waitForTimeout(1200);
  await cub((c) => c.open('terminal'));
  await shot('11-terminal', 900);
  if (!(await page.$('.term .caret'))) fail('11: no caret in the terminal viewer, so a running shell reads as finished');
  await closePanels();

  // 12: the light theme over an open sheet — body text, the segmented control and the row chips all have to hold
  // contrast, and the switch itself must not flash white.
  await cub((c) => c.theme('light'));
  await cub((c) => c.open('noticeboard'));
  await shot('12-light-theme', 900);
  await closePanels();
  await cub((c) => c.theme('dark'));
  await page.waitForTimeout(400);

  // 13: two levels deep — Queue, then one job's reader — with the back chevron in the trail, and Tab moved onto a
  // control so its focus ring is in the picture.
  await cub((c) => c.open('noticeboard'));
  await page.waitForTimeout(500);
  // Take the job id from the snapshot rather than from the burst above: the daemon rebuilds `jobs` from the vault's
  // Job notes on every snapshot, and these events were injected straight onto the stream with no note behind them, so
  // by now only the ones the daemon itself wrote survive. A hard-coded id here renders "not in the current snapshot".
  const job = await cub((c) => Object.values(c.state.jobs)[0]?.id ?? '');
  if (!job) fail('13: no job in the snapshot to open a reader on');
  else await cub((c, id: string) => c.open(`job:${id}`), job);
  await page.waitForTimeout(700);
  const depth = (await cub((c) => c.stack().length));
  if (depth < 2) fail(`13: the panel stack is ${depth} deep, so there is no back chevron to show`);
  const trail = (await page.$eval('#panel-trail', (el) => el.textContent?.trim() ?? '').catch(() => ''));
  if (!trail.includes('Queue')) fail(`13: the trail does not show the Queue crumb (got "${trail}")`);
  // `jobView` falls back to the bare title "Job" with an empty state when the id is not in the snapshot — that is a
  // picture of an empty reader, not of a two-level stack, so say so rather than shipping it as the scene.
  const title = (await page.$eval('#panel-title', (el) => el.textContent?.trim() ?? '').catch(() => ''));
  if (title === 'Job' || !title) fail(`13: the reader is the job empty state, not a real job (title "${title}")`);
  await page.keyboard.press('Tab');
  await shot('13-stack', 700);
  await closePanels();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await browser.close().catch(() => undefined);
  await d.stop().catch(() => undefined);
}
console.log(`screenshots in ${out}`);

// Budget gate (visual notes §4): the tray wants ≥ 55 fps at 1280×800; headless Chromium is slower, so the script
// fails only under 30 — low enough to be a real regression, high enough to catch a per-frame redraw. On a software
// rasteriser the number measures SwiftShader rather than the office (~12 fps on code that runs at 60 on a GPU), so
// the gate is skipped there instead of lowered: a lowered bar would pass a real regression on the GPU path too.
if (/swiftshader|llvmpipe/i.test(gl)) console.log(`fps gate skipped: ${gl} is a software rasteriser, so ${fps} fps measures it, not the office`);
else if (fps < 30) fail(`fps ${fps} is under 30`);
if (failures.length) { console.error(`FAIL: ${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`); process.exit(1); }
process.exit(0);
