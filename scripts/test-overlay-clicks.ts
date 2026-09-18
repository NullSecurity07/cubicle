/**
 * The HTML layer (bar, rail, sheet, reader, viewer, scrim, time bar, minimap chrome, toast) sits over the office
 * canvas. A press that starts on it must not reach the office: the campus renderer hit-tests every press against
 * the zones, screens and people under it, so a click in the Queue sheet must not open whatever is drawn beneath.
 * Releases must still be handled, so a drag let go over the sheet ends rather than leaving the camera stuck to the
 * cursor.
 *
 * SP9 re-scened this. The tower was a Phaser scene with window-level input listeners, which is what made the leak
 * possible in the first place and what the original gate instrumented (`gameobjectdown` / `pointerdownoutside`).
 * The campus draws to a plain canvas and binds its listeners to that element, so the gate reads the office through
 * its own hit test instead: `__cubicle.hitAt(x, y)` says what the office has under a point, a listener on the canvas
 * records every press that actually arrived there, and `dragging()` / `settled()` replace Phaser's pointer and
 * tween flags. The claims are the same ones; only the instrument changed. There is no floor rail, so the rail check
 * presses a zone tab and asserts the camera went to that zone.
 *
 * Runs a daemon on a temp vault, opens the built viewer in headless Chromium, parks the whiteboard under each HTML
 * element in turn, and clicks. Prints PASS: / FAIL: and exits non-zero on failure.
 * Usage: pnpm --filter @cubicle/viewer build && pnpm test:overlay
 * (`test:overlay` is `node --import tsx/esm --conditions=development scripts/test-overlay-clicks.ts`; the daemon
 * serves the viewer's built `dist/`, so a stale build makes every line below a claim about yesterday's code.)
 *
 * `CUBICLE_OVERLAY_PORT` moves the daemon off 7611 when something else holds it; the viewer is served on port + 1,
 * and a busy pair is retried a few steps up before the script gives up.
 */
import path from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scaffoldVault, createProposal } from '@cubicle/core';
import type { RoutedChatResult } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig } from '@cubicle/daemon';

type Hit = { ev: string; x: number; y: number; go?: string; domTarget?: string };
type OfficeHit = { kind: string; id: string } | null;
type Rect = { x: number; y: number; w: number; h: number };
type Point = { x: number; y: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = Window & { __cubicle: any; __hits: Hit[]; __frameNode: unknown };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-overlay-'));
const { vault } = await scaffoldVault(dir);
vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } });
vault.close();
const llm: Llm = { async chat(): Promise<RoutedChatResult> { await new Promise((r) => setTimeout(r, 400)); return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'ok' } }] }; }, promptBudget: () => 6000 };

/** The daemon takes `port` for the socket and `port + 1` for the viewer, so candidates step by two. */
async function startDaemon(): Promise<{ d: Daemon; port: number }> {
  const base = Number(process.env.CUBICLE_OVERLAY_PORT ?? 7611);
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    const port = base + i * 2;
    // `disablePantry`: this gate clicks through a fixed scene, and from the `brand_change` below on the company
    // has an idea and a completed cycle — so a tick could seat two sprites at the pantry mid-run (SP5 Decision 20).
    const d = new Daemon(defaultConfig(dir, process.env, { port, tickMs: 5000, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableSleepWatch: true, disablePantry: true, memory: false, log: () => undefined });
    try { await d.start(); return { d, port }; } catch (e) { last = e; console.log(`port ${port} busy, trying the next pair`); await d.stop().catch(() => undefined); }
  }
  throw last;
}
const { d, port: PORT } = await startDaemon();
const token = d.ws!.token;
const { chromium } = await import('playwright');
// A setup step that throws (the browser will not launch; the camera cannot park the board; an element never appears)
// still has to read as a failure and take the daemon and the browser down with it, or the run leaks a Chromium and
// an open port. Registered *before* the launch: a launch that throws used to leave the daemon and its port behind,
// which is exactly the case with nothing else to clean it up.
let browser: import('playwright').Browser | null = null;
const bail = (e: unknown): void => { console.log(`FAIL: the run stopped: ${String(e).split('\n')[0].slice(0, 300)}`); void (async () => { await browser?.close().catch(() => undefined); await d.stop().catch(() => undefined); process.exit(1); })(); };
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);
// Same GPU flags as scripts/office-shot.ts: SwiftShader draws the office at ~10 fps, which turns every settle wait
// below into a race. A machine without ANGLE falls back to software by itself.
browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const W = 1280, H = 800;
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('[page exception]', String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${PORT + 1}/?token=${token}&vault=Cubicle`, { waitUntil: 'load' });
await page.waitForFunction(() => { const c = (window as unknown as Win).__cubicle; return c?.state.connected && Object.keys(c.state.agents).length > 0; }, undefined, { timeout: 30_000 });
// A fresh vault has no brand, so the first-run card opens over the office; Escape hides it (ui/firstrun.ts) and it
// does not come back this session. Dismiss it before anything else so it cannot swallow a press.
if (await page.waitForSelector('#firstrun:not([hidden])', { timeout: 15_000 }).then(() => true).catch(() => false)) {
  await page.focus('#fr-input');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('firstrun')!.hidden, undefined, { timeout: 5000 });
}

/**
 * The zoom the helpers below hold the main camera at. Close enough that the whiteboard is a wide target — its face
 * is about 190 px across at this zoom — and far enough out that the camera's own clamp (the centre may leave the
 * campus by three cells, no more) still lets the board reach every corner of the 1280 x 800 frame.
 */
const ZOOM = 2.4;
const camSettled = () => page.waitForFunction(() => (window as unknown as Win).__cubicle.settled() as boolean, undefined, { timeout: 10_000 });
const framePainted = () => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const presentation = () => page.evaluate(() => { const l = document.getElementById('layer')!; return l.hidden ? null : l.dataset.presentation ?? null; });
const panelTitle = () => page.evaluate(() => document.getElementById('panel-title')!.textContent?.trim() ?? null);
const hits = () => page.evaluate(() => { const w = window as unknown as Win; const h = w.__hits; w.__hits = []; return h; });
const boxOf = async (selector: string): Promise<Rect> => { const b = (await page.locator(selector).boundingBox())!; if (!b) throw new Error(`setup: ${selector} has no box`); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
const centre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const underIs = (p: Point, closest: string) => page.evaluate(({ p, closest }) => !!document.elementFromPoint(p.x, p.y)?.closest(closest), { p, closest });
/** What the office itself has under a screen point — its own hit test, run without pressing anything. */
const officeAt = (p: Point): Promise<OfficeHit> => page.evaluate(({ x, y }) => (window as unknown as Win).__cubicle.hitAt(x, y) as OfficeHit, p) as Promise<OfficeHit>;

const failures: string[] = [];
const fail = (msg: string) => { failures.push(msg); console.log(`FAIL: ${msg}`); };

/**
 * Every press that actually reached the office canvas, with what the office had under it.
 *
 * This is the whole instrument. The campus binds its pointer handlers to the canvas element, so an event that the
 * HTML layer swallowed never arrives here at all and `__hits` stays empty — which is exactly the claim each check
 * below makes. Recorded in the capture phase so it sees the press before the renderer's own listener does, and a
 * renderer that stopped listening would still be caught by the `pres`/`title` half of each check.
 *
 * Nothing in here may be a *named* function (an inner `const f = () => …` included): tsx compiles those to a call
 * on an `__name` helper that exists in Node and not in the page, so the whole callback throws on arrival.
 */
await page.evaluate(() => {
  const w = window as unknown as Win;
  w.__hits = [];
  const canvas = document.querySelector('#game canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('setup: the office has no canvas');
  for (const ev of ['pointerdown', 'pointerup']) {
    canvas.addEventListener(ev, (e) => {
      const pe = e as PointerEvent;
      const r = canvas.getBoundingClientRect();
      const hit = w.__cubicle.hitAt(pe.clientX - r.left, pe.clientY - r.top) as OfficeHit;
      w.__hits.push({ ev, x: Math.round(pe.clientX), y: Math.round(pe.clientY), go: hit ? `${hit.kind}:${hit.id}` : undefined, domTarget: (pe.target as Element | undefined)?.id || (pe.target as Element | undefined)?.tagName });
    }, true);
  }
});
/** A press that reached the office with something of the office's under it. */
const reachedOffice = (hs: Hit[]): boolean => hs.some((h) => h.ev === 'pointerdown' && !!h.go);

/**
 * Pan so the whiteboard's face lies under `target` (a screen point inside `box`), then return the point to press
 * inside both. Throws rather than failing a check: a press that never had the board beneath it would pass every
 * assertion below while proving nothing.
 *
 * Iterative, not a single solve: `screenBox` measures the board's face, which stands 1.1 cells off the floor, while
 * `toGrid` unprojects onto the floor plane — so one step lands a few pixels out and the next closes it. Three steps
 * are enough at any zoom this script uses; the loop stops as soon as the board's centre is within two pixels.
 */
async function parkWhiteboardUnder(target: Point, box: Rect, what: string, closest: string): Promise<Point> {
  await page.evaluate((z) => { (window as unknown as Win).__cubicle.zoom(z); }, ZOOM);
  let geo: { x: number; y: number; w: number; h: number; cx: number; cy: number } | null = null;
  for (let i = 0; i < 4; i++) {
    await framePainted();
    geo = await page.evaluate(() => (window as unknown as Win).__cubicle.screenBox('whiteboard') as { x: number; y: number; w: number; h: number; cx: number; cy: number } | null);
    if (!geo) throw new Error('setup: the campus has no whiteboard screen');
    const dx = geo.cx - target.x, dy = geo.cy - target.y;
    if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2) break;
    await page.evaluate(({ dx, dy, W, H }) => {
      const c = (window as unknown as Win).__cubicle;
      const cell = c.toGrid(W / 2 + dx, H / 2 + dy) as { x: number; y: number };
      c.center(cell.x, cell.y);
    }, { dx, dy, W, H });
  }
  await framePainted();
  geo = await page.evaluate(() => (window as unknown as Win).__cubicle.screenBox('whiteboard') as { x: number; y: number; w: number; h: number; cx: number; cy: number });
  const ix0 = Math.max(geo.x, box.x), ix1 = Math.min(geo.x + geo.w, box.x + box.w);
  const iy0 = Math.max(geo.y, box.y), iy1 = Math.min(geo.y + geo.h, box.y + box.h);
  if (ix1 <= ix0 || iy1 <= iy0) throw new Error(`setup: the whiteboard ${JSON.stringify(geo)} is not under ${what} ${JSON.stringify(box)} (the camera stops three cells past the campus edge)`);
  const p = { x: Math.round((ix0 + ix1) / 2), y: Math.round((iy0 + iy1) / 2) };
  const on = await officeAt(p);
  if (on?.kind !== 'screen' || on.id !== 'whiteboard') throw new Error(`setup: the office does not place the whiteboard under (${p.x},${p.y}) — it has ${JSON.stringify(on)}`);
  if (!(await underIs(p, closest))) throw new Error(`setup: expected ${what} (${closest}) on top at (${p.x},${p.y})`);
  return p;
}

/** A spot on the canvas with nothing clickable under it, so a drag can start without opening a surface. */
async function emptyOfficePoint(): Promise<Point> {
  for (let y = 140; y <= 620; y += 60) for (let x = 130; x <= 1150; x += 70) {
    const p = { x, y };
    if (!(await underIs(p, '#game'))) continue;
    // Not an agent and not a screen: either would open a panel if the drag were ever mistaken for a click. The bare
    // floor between the zones is what this is looking for, and there is plenty of it on one open plane.
    const on = await officeAt(p);
    if (on === null) return p;
  }
  throw new Error('setup: no empty spot on the office to start a drag from');
}

// 1. The sheet: a click inside it over the whiteboard stays in the sheet.
await page.evaluate(() => (window as unknown as Win).__cubicle.open('noticeboard'));
await page.waitForFunction(() => document.getElementById('layer')!.dataset.presentation === 'sheet', undefined, { timeout: 10_000 });
await camSettled();
const body = await boxOf('#panel-body');
const p1 = await parkWhiteboardUnder({ x: body.x + body.w * 0.25, y: body.y + body.h / 2 }, body, 'the sheet body', '#panel');
await hits();
await page.mouse.click(p1.x, p1.y);
await page.waitForTimeout(300);
const r1 = { hits: await hits(), pres: await presentation(), title: await panelTitle() };
console.log('click in the sheet over the whiteboard →', JSON.stringify(r1));
if (reachedOffice(r1.hits)) fail('a press on the sheet reached the office beneath it');
if (r1.pres !== 'sheet') fail(`the presentation changed to ${r1.pres} from a click inside the sheet`);
if (r1.title !== 'Queue') fail(`the sheet changed to "${r1.title}" from a click inside it`);

// 2. Drag the office and release over the sheet: the pointer must not stay down, and the release must not press
//    whatever is under it. A camera drag carries the world with the cursor, so whatever sat under the press sits
//    under the release — and the press has to start on empty office or it opens a surface on `pointerdown`. The
//    board is therefore parked back under the release point while the button is still held, just before letting go.
const start = await emptyOfficePoint();
await page.mouse.move(start.x, start.y);
await page.mouse.down();
await page.mouse.move(start.x + 60, start.y + 20, { steps: 4 });
await page.mouse.move(p1.x, p1.y, { steps: 4 });
await parkWhiteboardUnder(p1, body, 'the sheet body', '#panel');
await hits();
await page.mouse.up();
await page.waitForTimeout(200);
const r2 = { isDown: await page.evaluate(() => (window as unknown as Win).__cubicle.dragging() as boolean), hits: await hits(), pres: await presentation(), title: await panelTitle() };
console.log('drag from the office, release over the sheet →', JSON.stringify(r2));
if (r2.isDown) fail('after releasing over the sheet the office is still dragging (the camera would keep following the cursor)');
if (r2.hits.some((h) => h.ev === 'pointerdown' && !!h.go)) fail('a drag that started on the office pressed something when released over the sheet');
if (r2.pres !== 'sheet' || r2.title !== 'Queue') fail(`releasing a drag over the sheet opened ${r2.pres} "${r2.title}"`);

// 3. Clicks on the office itself still work and open the reader; Escape closes it.
await page.evaluate(() => document.getElementById('panel-close')!.click());
await page.waitForFunction(() => document.getElementById('layer')!.hidden, undefined, { timeout: 10_000 });
await camSettled();
await parkWhiteboardUnder({ x: W / 2, y: H / 2 }, { x: 0, y: 0, w: W, h: H }, 'the middle of the office', '#game');
await hits();
await page.mouse.click(W / 2, H / 2);
await page.waitForTimeout(500);
const r3 = { hits: await hits(), pres: await presentation(), title: await panelTitle() };
console.log('click on the whiteboard in the office →', JSON.stringify(r3));
if (!r3.hits.some((h) => h.ev === 'pointerdown' && h.go === 'screen:whiteboard')) fail('a click on the office no longer reaches the whiteboard');
if (r3.pres !== 'reader' || r3.title !== 'Plan') fail(`clicking the whiteboard opened ${r3.pres} "${r3.title}" instead of the Plan reader`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
if ((await presentation()) !== null) fail('Escape did not close the reader');

// 4. The zone rail: a press on the Dev tab over the whiteboard frames the Dev studio and never reaches the office.
//    The floor rail is gone with the tower — there is one plane — so the tab under test is a zone, and what it has
//    to do is take the camera there.
const devTab = await boxOf('#rail [data-zone="dev"]');
const p4 = await parkWhiteboardUnder(centre(devTab), devTab, 'the Dev tab', '#rail');
await hits();
await page.mouse.click(p4.x, p4.y);
await page.waitForTimeout(300);
await camSettled();
const r4 = { hits: await hits(), zone: await page.evaluate(() => (window as unknown as Win).__cubicle.zone() as string), pres: await presentation() };
console.log('click on the Dev rail tab over the whiteboard →', JSON.stringify(r4));
if (reachedOffice(r4.hits)) fail('a press on the rail reached the office beneath it');
if (r4.zone !== 'dev') fail(`the rail tab did not take the camera to the Dev studio (zone = ${r4.zone})`);
if (r4.pres !== null) fail('a press on the rail opened a panel');

// 4b. The reader: the one level-2 presentation with a scrollable document under it. A press inside its body must
//     stay in it, exactly as the sheet's does — the sheet, the viewer and the toast were covered and this was not.
await page.evaluate(() => (window as unknown as Win).__cubicle.open('whiteboard'));
await page.waitForFunction(() => document.getElementById('layer')!.dataset.presentation === 'reader', undefined, { timeout: 10_000 });
await camSettled();
const readerBody = await boxOf('#panel-body');
const p4b = await parkWhiteboardUnder({ x: readerBody.x + readerBody.w * 0.3, y: readerBody.y + readerBody.h / 2 }, readerBody, 'the reader body', '#panel');
await hits();
await page.mouse.click(p4b.x, p4b.y);
await page.waitForTimeout(300);
const r4b = { hits: await hits(), pres: await presentation(), title: await panelTitle() };
console.log('click in the reader over the whiteboard →', JSON.stringify(r4b));
if (reachedOffice(r4b.hits)) fail('a press on the reader reached the office beneath it');
if (r4b.pres !== 'reader') fail(`the presentation changed to ${r4b.pres} from a click inside the reader`);
if (r4b.title !== 'Plan') fail(`the reader changed to "${r4b.title}" from a click inside it`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
if ((await presentation()) !== null) fail('Escape did not close the reader after the isolation check');

// 5. The browser viewer: opens from a pushed frame, updates the <img> in place, swallows presses, closes on Escape.
const frameUrl = (n: number) => page.evaluate((n) => { const c = document.createElement('canvas'); c.width = 320; c.height = 200; const g = c.getContext('2d')!; g.fillStyle = n % 2 ? '#2b5fc7' : '#1f7a33'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#ffffff'; g.font = '32px sans-serif'; g.fillText(`frame ${n}`, 40, 110); return c.toDataURL('image/png'); }, n);
d.vault.events.emit({ type: 'browser.session_started', agent: 'cmo', job: null, payload: { session: 'demo' } });
await page.waitForFunction(() => !!(window as unknown as Win).__cubicle.state.surfaces['demo'], undefined, { timeout: 10_000 });
const url1 = await frameUrl(1);
await page.evaluate((u) => (window as unknown as Win).__cubicle.pushFrame('demo', u), url1);
await page.evaluate(() => (window as unknown as Win).__cubicle.open('billboard'));
await page.waitForFunction(() => document.getElementById('layer')!.dataset.presentation === 'viewer', undefined, { timeout: 10_000 });
await camSettled();
// `data-key="frame"` keeps the <img> across a re-render; hold the node itself, not an attribute on it — `morph`
// strips attributes the new HTML does not carry, so a marker attribute would be wiped by the very update we test.
const v1 = await page.evaluate(() => { const w = window as unknown as Win; const img = document.querySelector<HTMLImageElement>('#panel-body img[data-key="frame"]'); w.__frameNode = img; return { src: img?.src ?? null, live: !!document.querySelector('#panel-body .badge.live') }; });
if (v1.src !== url1) fail('the viewer does not show the pushed frame');
if (!v1.live) fail('the viewer does not show LIVE for an active browser session');
const url2 = await frameUrl(2);
await page.evaluate((u) => (window as unknown as Win).__cubicle.pushFrame('demo', u), url2);
await page.waitForTimeout(450);
const v2 = await page.evaluate(() => { const w = window as unknown as Win; const img = document.querySelector<HTMLImageElement>('#panel-body img[data-key="frame"]'); return { src: img?.src ?? null, same: !!img && img === w.__frameNode }; });
if (v2.src !== url2) fail('a new frame did not reach the open viewer within 450 ms');
if (!v2.same) fail('the frame <img> was recreated instead of updated in place (it would flicker)');
const frameBox = await boxOf('#panel-body .vframe');
const p5 = await parkWhiteboardUnder(centre(frameBox), frameBox, 'the viewer frame', '#panel');
await hits();
await page.mouse.click(p5.x, p5.y);
await page.waitForTimeout(300);
const r5 = { hits: await hits(), pres: await presentation() };
console.log('click in the viewer over the whiteboard →', JSON.stringify(r5));
if (reachedOffice(r5.hits)) fail('a press on the viewer reached the office beneath it');
if (r5.pres !== 'viewer') fail(`the viewer changed to ${r5.pres} from a click inside it`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
if ((await presentation()) !== null) fail('Escape did not close the viewer');

// 6. The toast: a press on its text stays on it. A toast clears itself after five seconds, so it is raised again if
//    parking the board took longer than it lived; the box is the same either way.
let raised = 0;
const raiseToast = async (): Promise<void> => {
  raised += 1;
  createProposal(d.vault, { kind: 'brand_change', from: 'ceo', target: `Brand/name-${raised}.md`, title: `Name the company: WeekPlate ${raised}`, body: 'x' }, 'ceo');
  await page.waitForSelector('#toast:not([hidden])', { timeout: 10_000 });
};
await raiseToast();
const toastBox = await boxOf('#toast');
const p6 = await parkWhiteboardUnder({ x: toastBox.x + 30, y: toastBox.y + toastBox.h / 2 }, toastBox, 'the toast', '#toast').catch(async (e: unknown) => { await raiseToast(); throw e; });
if (await page.locator('#toast').evaluate((el) => (el as HTMLElement).hidden)) await raiseToast();
await hits();
await page.mouse.click(p6.x, p6.y);
await page.waitForTimeout(300);
const r6 = { hits: await hits(), pres: await presentation() };
console.log('click on the toast over the whiteboard →', JSON.stringify(r6));
if (reachedOffice(r6.hits)) fail('a press on the toast reached the office beneath it');
if (r6.pres !== null) fail('a press on the toast text opened a panel');


// ---------------------------------------------------------------------------------------------------------------
// SP8: the office decides and reads for itself.
//
// Both screens are driven by real notes in this run's vault and by the daemon's own ops — `decide` looks its id up
// in the inbox and `conversation.get` parses the thread off disk, so a fixture pushed into the page would be
// overwritten by the daemon's answer (and was: the first version of these checks passed against a daemon that did
// not know the ops yet, and failed the moment it did). A real proposal and a real board transcript are written
// below; `createProposal` emits `proposal.created`, which is what makes the viewer re-read the snapshot, so the
// meeting note is written first and both arrive together.
/** The board transcript written into this run’s vault below, and the three turns Messages has to show. */
const MEETING = 'demo_board';
const TURNS = ['Who is the first customer?', 'Six dollars a month is a thin margin.', 'Parents who cook on Sundays.'];
d.vault.writeText(
  `Meetings/${new Date().toISOString().slice(0, 10)}-1100-board-demo.md`,
  `---\nid: ${MEETING}\nroom: board\nopened: ${new Date().toISOString()}\nfacilitator: advisor_skeptic\nparticipants: [advisor_skeptic, advisor_investor, ceo]\nstatus: open\n---\n\n# Board meeting\n\n## Transcript\n\n**Round 1 — advisor_skeptic:** ${TURNS[0]}\n\n**Round 2 — advisor_investor:** ${TURNS[1]}\n\n**Round 3 — ceo:** ${TURNS[2]}\n`,
  'advisor_skeptic',
);
// A kind the dispatcher can apply on its own: a `file_change` with a `## Proposed content` fence needs nothing
// but the block and the target. (A `spend` without a stored call is refused, which is a true answer from the
// daemon and a dead end for this check — the point here is to reach the resolved outcome.)
const proposal = createProposal(d.vault, {
  kind: 'file_change', from: 'cfo', target: 'Docs/overlay-demo.md', title: 'Write the overlay demo note',
  body: 'One paragraph, so the run has something the dispatcher can apply.\n\nThe note is [in the vault](obsidian://open?vault=Cubicle&file=00%20Inbox%2Fspend).\n\n## Proposed content\n\n```\n# Overlay demo\n\nWritten by the owner approving a file_change in the office.\n```\n',
}, 'cfo');
// The socket is not faked — the frames below go to the daemon and come back from it. What is recorded here is what
// the page put on the wire, so "Approve sent one decide frame" is a claim about the op and not about the button.
await page.evaluate(`(() => { const send = WebSocket.prototype.send; window.__sent = []; WebSocket.prototype.send = function (d) { window.__sent.push(String(d)); return send.call(this, d); }; window.__external = []; })()`);
const sentOps = () => page.evaluate(() => ((window as unknown as { __sent: string[] }).__sent ?? []).map((s) => JSON.parse(s) as Record<string, unknown>));
/** What the reader says about the decision: the bar's live line while it is being applied, or the resolved note. */
const decisionState = () => page.evaluate(() => {
  const line = document.querySelector('#panel-body .actionbar .state');
  const body = document.getElementById('panel-body');
  const text = body ? body.textContent ?? '' : '';
  return { text: line ? (line.textContent ?? '').trim() : '', bad: !!line && line.classList.contains('bad'), resolved: !line && /Approved/.test(text), body: text.replace(/\s+/g, ' ').slice(0, 160) };
});
// The daemon rebuilds `inbox` from the vault on every snapshot, so this is the note itself arriving, with whatever
// `decidable`, body and band the daemon decided it has.
await page.waitForFunction((id) => {
  const rows = (window as unknown as Win).__cubicle.state.inbox ?? [];
  for (const n of rows) if (n.id === id) return true;
  return false;
}, proposal.id, { timeout: 30_000 }).catch(() => { throw new Error(`setup: the proposal ${proposal.id} never reached the viewer's snapshot`); });

// 7. Decisions: the sheet lists what needs the owner, and a row opens the reader.
await page.evaluate(() => (window as unknown as Win).__cubicle.open('postoffice'));
await page.waitForFunction(() => document.getElementById('layer')!.dataset.presentation === 'sheet', undefined, { timeout: 10_000 });
if ((await panelTitle()) !== 'Decisions') fail(`the post office sheet is "${await panelTitle()}", not Decisions`);
await page.click(`#panel-body [data-open="decision:${proposal.id}"]`);
await page.waitForFunction(() => document.getElementById('layer')!.dataset.presentation === 'reader', undefined, { timeout: 10_000 }).catch(() => fail('a Decisions row did not open the reader'));
const r7 = { pres: await presentation(), title: await panelTitle(), bar: await page.$$eval('#panel-body [data-act]', (els) => els.map((e) => (e as HTMLElement).dataset.act)) };
console.log('a Decisions row →', JSON.stringify(r7));
if (r7.title !== 'Write the overlay demo note') fail(`the reader opened on "${r7.title}" instead of the decision`);
if (!r7.bar.includes('decide:yes') || !r7.bar.includes('decide:no')) fail(`the reader has no action bar (controls: ${r7.bar.join(', ')})`);

// 7a. A toast never covers a fixed action bar (ruling P8-12): it used to land on the comment field and half of
//     the refusal button, in a delivered scene. The bar is measured, so a bar of any height is cleared.
createProposal(d.vault, { kind: 'file_change', from: 'cto', target: 'Docs/overlay-toast.md', title: 'A second decision, raised while the reader is open', body: 'Raised so the office toasts over the open reader.\n\n## Proposed content\n\n```\n# Toast demo\n```\n' }, 'cto');
await page.waitForSelector('#toast:not([hidden])', { timeout: 15_000 });
const overBar = await boxOf('#toast');
const readerBar = await boxOf('#panel-body .actionbar');
console.log('the toast against the action bar \u2192', JSON.stringify({ toast: overBar, bar: readerBar }));
if (overBar.y + overBar.h > readerBar.y) fail(`the toast (bottom ${Math.round(overBar.y + overBar.h)}) covers the action bar (top ${Math.round(readerBar.y)})`);

// 7b. Approve: one `decide` frame, the daemon writes the owner's yes into the note, and the bar stops saying
//     "applying" only when the dispatcher has resolved it. Either state is a pass — which one the run catches
//     depends on whether the scripted daemon's `runTick('decide')` gets to the note inside the wait — but an
//     error in the bar never is, and the frontmatter has to carry the decision either way.
await page.fill('#panel-body input[data-key="comment"]', 'go ahead');
await page.click('#panel-body [data-act="decide:yes"]');
await page.waitForTimeout(300);
const decided = (await sentOps()).filter((m) => m.op === 'decide');
console.log('Approve →', JSON.stringify(decided));
if (decided.length !== 1) fail(`Approve sent ${decided.length} decide frames`);
else if (decided[0].id !== proposal.id || decided[0].approved !== true || decided[0].comment !== 'go ahead') fail(`the decide frame is wrong: ${JSON.stringify(decided[0])}`);
// Either shape is a pass: the bar saying it is being applied, or — once the dispatcher has run — the reader
// showing the resolved note, which has no bar left on it at all.
let said = await decisionState();
for (let i = 0; i < 60 && !said.bad && !said.resolved && !said.text; i++) { await page.waitForTimeout(250); said = await decisionState(); }
console.log('the reader after Approve →', JSON.stringify(said));
if (said.bad) fail(`Approve was refused: "${said.text}"`);
else if (!said.resolved && !said.text) fail(`Approve left the reader saying nothing about the decision (${said.body})`);
// The owner's yes, on disk, written as theirs (`ownerDecide`): the one fact neither the page nor the socket can fake.
let frontmatter = '';
for (let i = 0; i < 60; i++) {
  try { frontmatter = readFileSync(path.join(dir, proposal.path), 'utf8').split('\n---')[0]; } catch (e) { frontmatter = `unreadable: ${String(e).slice(0, 120)}`; }
  if (/^approved:\s*true\b/m.test(frontmatter)) break;
  await page.waitForTimeout(250);
}
if (!/^approved:\s*true\b/m.test(frontmatter)) fail(`the note still reads "${frontmatter.replace(/\n/g, ' | ').slice(0, 200)}" after Approve`);
if (!frontmatter.includes('owner')) console.log('note: the decision was recorded without "owner" in the frontmatter —', JSON.stringify(frontmatter.slice(0, 160)));

// 7c. An `obsidian:` link hands off and never navigates: the office window cannot load that scheme and goes blank.
//     `openExternal` is the Tauri window's own hook (it assigns location and the navigation guard takes it from
//     there); in a browser there is none, and the page falls back to the clipboard toast.
await page.evaluate(`(() => { window.__cubicle.openExternal = function (u) { window.__external.push(String(u)); }; })()`);
const urlBefore = page.url();
// The note's own body link where the daemon sent a body (ui/markdown.ts renders it), else the panel header's
// "Open in Obsidian" — the same delegated handler owns both, and one of the two is always on the screen.
const vaultLink = (await page.$('#panel-body a[href^="obsidian:"]')) ? '#panel-body a[href^="obsidian:"]' : '#panel-link';
if (vaultLink === '#panel-link') console.log('note: the decision carried no body, so the header link is the one under test');
await page.click(vaultLink);
await page.waitForTimeout(400);
const r7c = { url: page.url(), handed: await page.evaluate(() => (window as unknown as { __external: string[] }).__external), pres: await presentation() };
console.log('an obsidian: link →', JSON.stringify(r7c));
if (r7c.url !== urlBefore) fail(`an obsidian: link navigated the office window to ${r7c.url}`);
if (r7c.handed.length !== 1 || !r7c.handed[0].startsWith('obsidian://')) fail(`the shell was not handed the link (${JSON.stringify(r7c.handed)})`);
if (r7c.pres !== 'reader') fail(`the reader closed when the link was clicked (now ${r7c.pres})`);
await page.evaluate(() => document.getElementById('panel-close')!.click());
await page.waitForFunction(() => document.getElementById('layer')!.hidden, undefined, { timeout: 10_000 });

// 8. Messages: the tab opens the sheet, and the board transcript written above is in it — parsed out of the vault
//    by the daemon, fetched with `conversation.get`, and shown as the three turns it holds.
await page.click('#bar [data-open="messages"]');
await page.waitForFunction(() => document.getElementById('layer')!.dataset.presentation === 'sheet', undefined, { timeout: 10_000 });
const boardThread = await page.evaluate(() => {
  const threads = (window as unknown as Win).__cubicle.state.conversations ?? [];
  for (const t of threads) if (t.kind === 'board' || t.room === 'board') return String(t.id);
  return null;
}) as string | null;
if (!boardThread) fail('the board transcript in Meetings/ is not in the conversation index, so there is no thread to open');
else {
  await page.click(`#panel-body [data-act="thread:${boardThread}"]`);
  await page.waitForFunction(() => document.querySelectorAll('#panel-body .thread .msg .bubble').length > 0, undefined, { timeout: 15_000 }).catch(() => undefined);
  const r8 = {
    title: await panelTitle(),
    open: await page.evaluate(() => (window as unknown as Win).__cubicle.ui().thread as string | null),
    bubbles: await page.$$eval('#panel-body .thread .msg .bubble', (els) => els.map((e) => e.textContent ?? '')),
    asked: (await sentOps()).filter((m) => m.op === 'conversation.get').map((m) => m.id),
  };
  console.log('a Messages thread →', JSON.stringify(r8));
  if (r8.title !== 'Messages') fail(`the Messages tab opened "${r8.title}"`);
  if (r8.open !== boardThread) fail(`the thread row left ${JSON.stringify(r8.open)} open`);
  if (!r8.asked.includes(boardThread)) fail('opening a thread did not ask the daemon for its turns');
  for (const turn of TURNS) if (!r8.bubbles.some((b) => b.includes(turn))) fail(`the conversation is missing the turn "${turn}" (it shows ${JSON.stringify(r8.bubbles)})`);
}
await page.evaluate(() => document.getElementById('panel-close')!.click());
await page.waitForFunction(() => document.getElementById('layer')!.hidden, undefined, { timeout: 10_000 });

/* ============================================================================================================ */
/* 9. The office the owner arranges (SP9b)                                                                       */
/*                                                                                                              */
/* The claims here are the owner's own sentences: a desk they drag is still there after a reload, a line they    */
/* draw is on the wire and in the note, one they cut is gone, a note from the dock lands on the floor, and a     */
/* hire from the dock arrives in Decisions. Driven through `__cubicle`, which is the pointer's own calls — the   */
/* renderer's methods, not a second path — so what passes here is what a hand does.                              */
/* ============================================================================================================ */

/** The note as the office holds it. */
const officeLayout = () => page.evaluate(() => (window as unknown as Win).__cubicle.layout() as { nodes: Record<string, { x?: number; y?: number; kind?: string }>; connections: { from: string; to: string; kind: string }[] });
const layoutFrames = async (): Promise<Record<string, unknown>[]> => (await sentOps()).filter((m) => m.op === 'layout.set');
/** `Office/campus.md` on disk, which is the only copy that survives the page. */
const campusNote = (): string => { try { return readFileSync(path.join(dir, 'Office/campus.md'), 'utf8'); } catch (e) { return `unreadable: ${String(e).slice(0, 120)}`; } };

// 9a. Drag a desk. A cell is looked for rather than assumed: the campus may be re-generated, and a drag onto a
//     taken spot is refused by design, which would read as "dragging is broken" instead of "that spot is taken".
const dragged = await page.evaluate(() => {
  const c = (window as unknown as Win).__cubicle;
  const id = 'cto';
  const was = c.nodeBox(id) as { cx: number; cy: number } | null;
  if (!was) return { id, ok: false, why: 'the campus has no cto desk' };
  const from = c.desks()[id] as { tx: number; ty: number } | undefined;
  const base = from ?? { tx: 10, ty: 10 };
  for (let r = 1; r <= 12; r++) {
    for (const d of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, -r]]) {
      const to = { x: base.tx + d[0], y: base.ty + d[1] };
      if (c.drag(id, to)) return { id, ok: true, to, why: '' };
    }
  }
  return { id, ok: false, why: 'every spot tried was taken' };
}) as { id: string; ok: boolean; to?: { x: number; y: number }; why: string };
await page.waitForTimeout(400);
const afterDrag = await officeLayout();
const landed = afterDrag.nodes[dragged.id];
const dragFrames = await layoutFrames();
console.log('drag the CTO desk →', JSON.stringify({ dragged, node: afterDrag.nodes[dragged.id], frames: dragFrames.length }));
if (!dragged.ok) fail(`the CTO desk could not be dragged: ${dragged.why}`);
else {
  // A drag names where the thing's *middle* lands and the note records its footprint's near corner, so the claim
  // is not a coordinate but a round trip: the desk has an entry, it is on the half-cell grid, and section 9g
  // asserts the office hands back this same entry after a reload.
  if (!landed) fail('a dragged desk left no entry in the office note');
  else if (landed.x === undefined || landed.y === undefined) fail(`the note's entry for the desk has no position: ${JSON.stringify(landed)}`);
  else if (landed.x * 2 !== Math.round(landed.x * 2) || landed.y * 2 !== Math.round(landed.y * 2)) fail(`the desk landed off the half-cell grid at ${JSON.stringify(landed)}`);
  if (!dragFrames.length) fail('a drag sent no layout.set to the daemon');
  const note = campusNote();
  if (!new RegExp(`^\\s*${dragged.id}:`, 'm').test(note)) fail(`Office/campus.md does not name the desk that moved: ${note.split('\n---')[0].replace(/\n/g, ' | ').slice(0, 200)}`);
}

// 9b–9c. A line drawn and a line cut. The pair is chosen in the page: the migration already wires the room and
//        the reporting lines, and connecting two desks that are connected is not a test of anything.
const wiring = await page.evaluate(() => {
  const c = (window as unknown as Win).__cubicle;
  const ids = Object.keys(c.desks() as Record<string, unknown>).sort();
  const lay = c.layout() as { connections: { from: string; to: string }[] };
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      let already = false;
      for (const cn of lay.connections) if ((cn.from === a && cn.to === b) || (cn.from === b && cn.to === a)) already = true;
      if (already) continue;
      return { a, b, connected: c.connect(a, b) as boolean };
    }
  }
  return { a: '', b: '', connected: false };
}) as { a: string; b: string; connected: boolean };
await page.waitForTimeout(300);
const afterConnect = await officeLayout();
const hasLine = (l: { connections: { from: string; to: string }[] }, a: string, b: string): boolean => l.connections.some((c) => (c.from === a && c.to === b) || (c.from === b && c.to === a));
console.log('connect two desks →', JSON.stringify({ ...wiring, lines: afterConnect.connections.length }));
if (!wiring.a) fail('every pair of desks on the campus is already wired, so connect could not be tested');
else {
  if (!wiring.connected) fail(`connecting ${wiring.a} and ${wiring.b} was refused`);
  if (!hasLine(afterConnect, wiring.a, wiring.b)) fail(`the note has no line between ${wiring.a} and ${wiring.b}`);
  const peer = afterConnect.connections.find((c) => (c.from === wiring.a && c.to === wiring.b) || (c.from === wiring.b && c.to === wiring.a));
  if (peer && peer.kind !== 'peer') fail(`a line between two desks came out as ${peer.kind}, not peer`);
  if (!campusNote().includes(wiring.b)) fail('Office/campus.md does not carry the line that was drawn');

  const cut = await page.evaluate(({ a, b }) => (window as unknown as Win).__cubicle.disconnect(a, b) as boolean, wiring) as boolean;
  await page.waitForTimeout(300);
  const afterCut = await officeLayout();
  console.log('cut it again →', JSON.stringify({ cut, lines: afterCut.connections.length }));
  if (!cut) fail(`cutting the line between ${wiring.a} and ${wiring.b} was refused`);
  if (hasLine(afterCut, wiring.a, wiring.b)) fail('the line is still in the note after it was cut');
}

// 9d. The dock puts a sticky note on the floor: the dock opens, the glyph is armed and dropped, and what lands is
//     a thing the office can find under the pointer — not just a line in a file.
const placed = await page.evaluate(() => {
  const c = (window as unknown as Win).__cubicle;
  c.dock(true);
  const open = !document.getElementById('dock')!.hidden;
  const from = c.desks().cto as { tx: number; ty: number } | undefined;
  const base = from ?? { tx: 10, ty: 10 };
  for (let r = 2; r <= 14; r++) {
    for (const d of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r]]) {
      const at = { x: base.tx + d[0], y: base.ty + d[1] };
      if (c.place('note', at, { body: 'Ask the CFO about runway' })) return { open, at, ok: true };
    }
  }
  return { open, ok: false, at: null };
}) as { open: boolean; ok: boolean; at: { x: number; y: number } | null };
await page.waitForTimeout(400);
const afterPlace = await officeLayout();
const noteIds = Object.keys(afterPlace.nodes).filter((k) => afterPlace.nodes[k].kind === 'note');
const noteBox = noteIds.length ? await page.evaluate((id) => (window as unknown as Win).__cubicle.nodeBox(id), noteIds[0]) : null;
console.log('a sticky note from the dock →', JSON.stringify({ placed, noteIds, noteBox }));
if (!placed.open) fail('the dock did not open');
if (!placed.ok) fail('a sticky note could not be put down anywhere on the campus');
else {
  if (!noteIds.length) fail('a note placed from the dock left no entry in the office note');
  if (!noteBox) fail('the note is in the layout but the office draws nothing there');
  if (!campusNote().includes('note_1')) fail('Office/campus.md does not carry the note that was added');
}
await page.evaluate(() => (window as unknown as Win).__cubicle.dock(false));

// 9e. A hire from the dock: the sheet, the op, and the proposal the owner then decides. The desk stays a ghost —
//     the office must not seat anybody on a hire nobody has approved.
const pendingBefore = await page.evaluate(() => (window as unknown as Win).__cubicle.state.pendingProposals as number);
const hireTeam = await page.evaluate(() => {
  const teams = (window as unknown as Win).__cubicle.state.teams as { id: string }[];
  return teams.length ? teams[0].id : '';
}) as string;
if (!hireTeam) fail('the company has no team for a hire to join');
await page.evaluate((team) => {
  const c = (window as unknown as Win).__cubicle;
  const from = c.desks().cto as { tx: number; ty: number } | undefined;
  const base = from ?? { tx: 10, ty: 10 };
  c.hire({ x: base.tx + 3, y: base.ty + 3 }, { role: 'support', display: 'Head of Support', team });
}, hireTeam);
await page.waitForTimeout(600);
const hireFrames = (await sentOps()).filter((m) => m.op === 'hire.propose');
const ghost = await page.evaluate(() => (window as unknown as Win).__cubicle.hiring());
// The proposal arrives in the snapshot the daemon rebuilds from the vault, so this waits on the inbox rather than
// on a timer: it is the row the owner will click in Decisions that is being claimed, not the frame that asked.
let hired: { inbox: number; titles: string[]; seated: boolean } = { inbox: 0, titles: [], seated: false };
for (let i = 0; i < 40; i++) {
  hired = await page.evaluate(() => {
    const s = (window as unknown as Win).__cubicle.state;
    return { inbox: (s.inbox ?? []).length, titles: (s.inbox ?? []).map((n: { title: string }) => n.title), seated: !!s.agents.support };
  });
  if (hired.titles.some((t) => /support/i.test(t))) break;
  await page.waitForTimeout(250);
}
console.log('hire from the dock →', JSON.stringify({ frames: hireFrames, ghost, hired, pendingBefore }));
if (hireFrames.length !== 1) fail(`the hire sheet sent ${hireFrames.length} hire.propose frames`);
else if (hireFrames[0].role !== 'support' || !hireFrames[0].at) fail(`the hire frame is wrong: ${JSON.stringify(hireFrames[0])}`);
if (!ghost) fail('no ghost desk stands where the hire was asked for');
if (!hired.titles.some((t) => /support/i.test(t))) fail(`the hire never reached Decisions (the inbox holds ${JSON.stringify(hired.titles)})`);
if (hired.seated) fail('the office seated the new hire before the owner decided it');
await page.evaluate(() => { const el = document.getElementById('hire'); if (el) el.hidden = true; });

// 9e2. The office, as a list. A canvas has no accessibility tree of its own, so the one thing that can be
//      asserted about this is that the outline is really in the page, really names the room, and that its
//      buttons are the same ones the pointer presses — a `data-open` the panel already routes.
const outline = await page.evaluate(() => {
  const el = document.getElementById('office-a11y');
  if (!el) return null;
  const buttons = [...el.querySelectorAll('button[data-open]')].map((b) => ({ open: (b as HTMLElement).dataset.open ?? '', text: (b.textContent ?? '').slice(0, 60) }));
  return { headings: [...el.querySelectorAll('h2')].map((h) => h.textContent ?? ''), buttons, label: el.getAttribute('aria-label') };
}) as { headings: string[]; buttons: { open: string; text: string }[]; label: string | null } | null;
console.log('the office as a list →', JSON.stringify({ label: outline?.label, headings: outline?.headings, buttons: outline?.buttons.length, first: outline?.buttons.slice(0, 3) }));
if (!outline) fail('the office canvas has no accessibility tree beside it');
else {
  if (!outline.headings.includes('People')) fail(`the outline does not name the people (it has ${JSON.stringify(outline.headings)})`);
  if (!outline.headings.includes('Screens')) fail('the outline does not name the screens on the walls');
  if (outline.buttons.length < 5) fail(`the outline has ${outline.buttons.length} buttons, which is not an office`);
  const person = outline.buttons.find((b) => b.open.startsWith('agent:'));
  if (!person) fail('nobody in the office can be reached from the outline');
  else {
    // And it works: pressing it opens exactly what clicking that person in the room opens. Activated the way a
    // keyboard activates it — `.sr-only` is a one-pixel clip, so a pointer cannot reach it and Playwright will
    // not pretend otherwise.
    await page.$eval(`#office-a11y button[data-open="${person.open}"]`, (el) => (el as HTMLElement).click());
    await page.waitForTimeout(500);
    const opened = await presentation();
    if (!opened) fail(`pressing ${person.open} in the outline opened nothing`);
    await page.evaluate(() => document.getElementById('panel-close')?.click());
    await page.waitForTimeout(300);
  }
}

// 9f. A drag that starts on the sheet never reaches the office. The one gesture SP9b added that the HTML layer
//     could leak: a press-move-release inside a sheet parked over a desk must move neither the camera nor the desk.
await page.evaluate(() => (window as unknown as Win).__cubicle.open('noticeboard'));
await page.waitForFunction(() => document.getElementById('layer')!.dataset.presentation === 'sheet', undefined, { timeout: 10_000 });
await camSettled();
const sheetBox = await boxOf('#panel-body');
const pDrag = await parkWhiteboardUnder({ x: sheetBox.x + sheetBox.w * 0.4, y: sheetBox.y + sheetBox.h * 0.45 }, sheetBox, 'the sheet body', '#panel');
const beforeDrag = await officeLayout();
await hits();
await page.mouse.move(pDrag.x, pDrag.y);
await page.mouse.down();
for (const step of [12, 26, 44, 60]) await page.mouse.move(pDrag.x + step, pDrag.y + step * 0.6);
await page.mouse.up();
await page.waitForTimeout(400);
const r9f = { hits: await hits(), pres: await presentation(), layout: await officeLayout(), dragging: await page.evaluate(() => (window as unknown as Win).__cubicle.dragging() as boolean) };
console.log('a drag inside the sheet over the office →', JSON.stringify({ hits: r9f.hits, pres: r9f.pres, dragging: r9f.dragging }));
if (reachedOffice(r9f.hits)) fail('a drag started on the sheet reached the office beneath it');
if (r9f.pres !== 'sheet') fail(`a drag inside the sheet changed the presentation to ${r9f.pres}`);
if (r9f.dragging) fail('a drag inside the sheet left the office holding something');
if (JSON.stringify(r9f.layout) !== JSON.stringify(beforeDrag)) fail('a drag inside the sheet changed the office layout');
await page.evaluate(() => document.getElementById('panel-close')!.click());
await page.waitForFunction(() => document.getElementById('layer')!.hidden, undefined, { timeout: 10_000 });

// 9g. And the one the owner will check first: reload, and the office is as they left it. This is the round trip
//     through `Office/campus.md` — the page is thrown away, so what comes back came off the disk.
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => { const c = (window as unknown as Win).__cubicle; return c?.state.connected && Object.keys(c.state.agents).length > 0; }, undefined, { timeout: 30_000 });
await page.waitForFunction(() => Object.keys(((window as unknown as Win).__cubicle.layout() as { nodes: Record<string, unknown> }).nodes).length > 0, undefined, { timeout: 15_000 }).catch(() => undefined);
const reloaded = await officeLayout();
console.log('after a reload →', JSON.stringify({ desk: reloaded.nodes[dragged.id], notes: Object.keys(reloaded.nodes).filter((k) => reloaded.nodes[k].kind === 'note') }));
if (dragged.ok && landed) {
  const back = reloaded.nodes[dragged.id];
  if (!back || back.x !== landed.x || back.y !== landed.y) fail(`the CTO desk came back at ${JSON.stringify(back)} instead of ${JSON.stringify(landed)}`);
}
if (placed.ok && !Object.keys(reloaded.nodes).some((k) => reloaded.nodes[k].kind === 'note')) fail('the sticky note was gone after a reload');

await browser.close();
await d.stop();
if (failures.length) { console.log(`FAIL: ${failures.length} check(s) failed`); process.exit(1); }
console.log('PASS: presses on the sheet, reader, rail, viewer and toast stay on the HTML layer; releases and office clicks still reach the campus; the zone rail takes the camera to Dev; a real proposal opens its reader and Approve decides it on the wire; the board transcript in the vault opens as a thread; an obsidian: link hands off without navigating; a desk dragged, a line drawn and cut, a note dropped from the dock and a hire filed all reach Office/campus.md, a drag on the sheet reaches nothing, the office publishes itself as a list that names the people and the screens and whose buttons open what the pointer opens, and the office comes back as it was left');
process.exit(0);
