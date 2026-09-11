/**
 * The HTML layer (bar, rail, sheet, reader, viewer, scrim, time bar, minimap chrome, toast) sits over the Phaser
 * office. A press that starts on it must not reach the office: Phaser's window-level listeners (`input.windowEvents`)
 * hit-test off-canvas presses against the scene, so without the guard in viewer/src/main.ts a click in the Queue
 * sheet opened whatever surface was drawn beneath it. Releases must still reach Phaser, so a drag let go over the
 * sheet ends (`isDown` clears).
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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scaffoldVault, createProposal } from '@cubicle/core';
import type { RoutedChatResult } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig } from '@cubicle/daemon';

type Hit = { ev: string; x: number; y: number; go?: string; domTarget?: string };
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
    const d = new Daemon(defaultConfig(dir, process.env, { port, tickMs: 5000, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableSleepWatch: true, memory: false, log: () => undefined });
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
await page.goto(`http://127.0.0.1:${PORT + 1}/?token=${token}`, { waitUntil: 'load' });
await page.waitForFunction(() => { const c = (window as unknown as Win).__cubicle; return c?.state.connected && Object.keys(c.state.agents).length > 0; }, undefined, { timeout: 30_000 });
// A fresh vault has no brand, so the first-run card opens over the office; Escape hides it (ui/firstrun.ts) and it
// does not come back this session. Dismiss it before anything else so it cannot swallow a press.
if (await page.waitForSelector('#firstrun:not([hidden])', { timeout: 15_000 }).then(() => true).catch(() => false)) {
  await page.focus('#fr-input');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('firstrun')!.hidden, undefined, { timeout: 5000 });
}

/**
 * The zoom the helpers below hold the main camera at. 3 is what `open(kind)` itself zooms to, and it is also the
 * lowest step at which the whiteboard can reach the rail: the camera stops at the map bounds, and at zoom 2 the
 * board's screen x bottoms out around 256 — far right of the rail's x ≈ 22.
 */
const ZOOM = 3;
/** `__cubicle.zoom(z)` sets the zoom and hands back the main camera; it is the only way in to the camera and scene. */
const camSettled = () => page.waitForFunction((z) => { const c = (window as unknown as Win).__cubicle.zoom(z); return !c.panEffect.isRunning && !c.zoomEffect.isRunning; }, ZOOM, { timeout: 10_000 });
const framePainted = () => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const presentation = () => page.evaluate(() => { const l = document.getElementById('layer')!; return l.hidden ? null : l.dataset.presentation ?? null; });
const panelTitle = () => page.evaluate(() => document.getElementById('panel-title')!.textContent?.trim() ?? null);
const hits = () => page.evaluate(() => { const w = window as unknown as Win; const h = w.__hits; w.__hits = []; return h; });
const boxOf = async (selector: string): Promise<Rect> => { const b = (await page.locator(selector).boundingBox())!; if (!b) throw new Error(`setup: ${selector} has no box`); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
const centre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const underIs = (p: Point, closest: string) => page.evaluate(({ p, closest }) => !!document.elementFromPoint(p.x, p.y)?.closest(closest), { p, closest });
await camSettled();

const failures: string[] = [];
const fail = (msg: string) => { failures.push(msg); console.log(`FAIL: ${msg}`); };

// What Phaser makes of each press: the game object it hit, and the DOM element the raw event actually targeted.
// Nothing in here may be a *named* function (an inner `const f = () => …` included): tsx compiles those to a call
// on an `__name` helper that exists in Node and not in the page, so the whole callback throws on arrival.
await page.evaluate((z) => {
  const w = window as unknown as Win;
  const scene = w.__cubicle.zoom(z).scene;
  w.__hits = [];
  scene.input.on('gameobjectdown', (p: { x: number; y: number; event?: Event }, go: { type: string }) => w.__hits.push({ ev: 'gameobjectdown', x: p.x, y: p.y, go: go.type, domTarget: (p.event?.target as Element | undefined)?.id || (p.event?.target as Element | undefined)?.tagName }));
  scene.input.on('pointerdownoutside', (p: { x: number; y: number; event?: Event }) => w.__hits.push({ ev: 'pointerdownoutside', x: p.x, y: p.y, domTarget: (p.event?.target as Element | undefined)?.id || (p.event?.target as Element | undefined)?.tagName }));
}, ZOOM);

/**
 * Pan so the whiteboard's hit box lies under `target` (a screen point inside `box`), then return the point to press
 * inside both. Throws rather than failing a check: a press that never had a game object beneath it would pass every
 * assertion below while proving nothing.
 */
async function parkWhiteboardUnder(target: Point, box: Rect, what: string, closest: string): Promise<Point> {
  await camSettled();
  await page.evaluate(({ W, H, target, z }) => {
    const cam = (window as unknown as Win).__cubicle.zoom(z);
    const b = cam.scene.surfaces.get('whiteboard').bg.getBounds();
    cam.centerOn(b.centerX + (W / 2 - target.x) / z, b.centerY + (H / 2 - target.y) / z);
  }, { W, H, target, z: ZOOM });
  // `worldView` is recomputed in the camera's pre-render, so where the board *landed* can only be read after a frame.
  await framePainted();
  const geo = await page.evaluate((z) => {
    const cam = (window as unknown as Win).__cubicle.zoom(z);
    const b = cam.scene.surfaces.get('whiteboard').bg.getBounds();
    const wv = cam.worldView;
    return { x: (b.x - wv.x) * z, y: (b.y - wv.y) * z, w: b.width * z, h: b.height * z };
  }, ZOOM);
  const ix0 = Math.max(geo.x, box.x), ix1 = Math.min(geo.x + geo.w, box.x + box.w);
  const iy0 = Math.max(geo.y, box.y), iy1 = Math.min(geo.y + geo.h, box.y + box.h);
  if (ix1 <= ix0 || iy1 <= iy0) throw new Error(`setup: whiteboard ${JSON.stringify(geo)} is not under ${what} ${JSON.stringify(box)} (the camera stops at the map bounds)`);
  const p = { x: Math.round((ix0 + ix1) / 2), y: Math.round((iy0 + iy1) / 2) };
  const onBoard = await page.evaluate(({ p, z }) => { const cam = (window as unknown as Win).__cubicle.zoom(z); const wp = cam.getWorldPoint(p.x, p.y); return cam.scene.surfaces.get('whiteboard').bg.getBounds().contains(wp.x, wp.y) as boolean; }, { p, z: ZOOM });
  if (!onBoard) throw new Error(`setup: Phaser does not place the whiteboard under (${p.x},${p.y})`);
  if (!(await underIs(p, closest))) throw new Error(`setup: expected ${what} (${closest}) on top at (${p.x},${p.y})`);
  return p;
}

/** A spot on the canvas with nothing interactive under it, so a drag can start without opening a surface or an agent. */
async function emptyOfficePoint(): Promise<Point> {
  for (let y = 140; y <= 620; y += 80) for (let x = 90; x <= 620; x += 90) {
    const p = { x, y };
    if (!(await underIs(p, '#game'))) continue;
    await page.mouse.move(p.x, p.y);
    await framePainted();
    const clear = await page.evaluate((z) => { const sc = (window as unknown as Win).__cubicle.zoom(z).scene; return sc.input.hitTestPointer(sc.input.activePointer).length === 0; }, ZOOM);
    if (clear) return p;
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
if (r1.hits.some((h) => h.ev === 'gameobjectdown')) fail('a press on the sheet reached a game object beneath it');
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
const r2 = { ...(await page.evaluate((z) => ({ isDown: (window as unknown as Win).__cubicle.zoom(z).scene.input.activePointer.isDown as boolean }), ZOOM)), hits: await hits(), pres: await presentation(), title: await panelTitle() };
console.log('drag from the office, release over the sheet →', JSON.stringify(r2));
if (r2.isDown) fail('after releasing over the sheet the pointer is still down (drag would keep panning)');
if (r2.hits.some((h) => h.ev === 'gameobjectdown')) fail('a drag that started on the office hit a game object when released over the sheet');
if (r2.pres !== 'sheet' || r2.title !== 'Queue') fail(`releasing a drag over the sheet opened ${r2.pres} "${r2.title}"`);

// 3. Clicks on the office itself still work and open the reader; Escape closes it.
await page.evaluate(() => document.getElementById('panel-close')!.click());
await page.waitForFunction(() => document.getElementById('layer')!.hidden, undefined, { timeout: 10_000 });
await camSettled();
await page.evaluate((z) => { const cam = (window as unknown as Win).__cubicle.zoom(z); cam.scene.input.activePointer.reset(); const b = cam.scene.surfaces.get('whiteboard').bg.getBounds(); cam.centerOn(b.centerX, b.centerY); }, ZOOM);
await framePainted();
await hits();
await page.mouse.click(W / 2, H / 2);
await page.waitForTimeout(500);
const r3 = { hits: await hits(), pres: await presentation(), title: await panelTitle() };
console.log('click on the whiteboard in the office →', JSON.stringify(r3));
if (!r3.hits.some((h) => h.ev === 'gameobjectdown' && h.domTarget === 'CANVAS')) fail('a click on the office no longer reaches the whiteboard');
if (r3.pres !== 'reader' || r3.title !== 'Plan') fail(`clicking the whiteboard opened ${r3.pres} "${r3.title}" instead of the Plan reader`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
if ((await presentation()) !== null) fail('Escape did not close the reader');

// 4. The rail: a press on the F3 tab over the whiteboard switches floors and never reaches the office.
const tab3 = await boxOf('#rail [data-floor="3"]');
const p4 = await parkWhiteboardUnder(centre(tab3), tab3, 'the F3 tab', '#rail');
await hits();
await page.mouse.click(p4.x, p4.y);
await page.waitForTimeout(300);
await camSettled();
const r4 = { hits: await hits(), floor: await page.evaluate(() => (window as unknown as Win).__cubicle.currentFloor() as number), pres: await presentation() };
console.log('click on the F3 rail tab over the whiteboard →', JSON.stringify(r4));
if (r4.hits.some((h) => h.ev === 'gameobjectdown')) fail('a press on the rail reached a game object beneath it');
if (r4.floor !== 3) fail(`the rail tab did not take the camera to floor 3 (currentFloor = ${r4.floor})`);
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
if (r4b.hits.some((h) => h.ev === 'gameobjectdown')) fail('a press on the reader reached a game object beneath it');
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
if (r5.hits.some((h) => h.ev === 'gameobjectdown')) fail('a press on the viewer reached a game object beneath it');
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
if (r6.hits.some((h) => h.ev === 'gameobjectdown')) fail('a press on the toast reached a game object beneath it');
if (r6.pres !== null) fail('a press on the toast text opened a panel');

await browser.close();
await d.stop();
if (failures.length) { console.log(`FAIL: ${failures.length} check(s) failed`); process.exit(1); }
console.log('PASS: presses on the sheet, reader, rail, viewer and toast stay on the HTML layer; releases and office clicks still reach Phaser');
process.exit(0);
