/**
 * The HTML layer (drawer, modal, top bar, time bar) sits over the Phaser office. A press that starts on it must not
 * reach the office: Phaser's window-level listeners (`input.windowEvents`) hit-test off-canvas presses against the
 * scene, so without the guard in viewer/src/main.ts a click in the Queue drawer opened whatever surface was drawn
 * beneath it. Releases must still reach Phaser, so a drag let go over the drawer ends (`isDown` clears).
 *
 * Runs a daemon on a temp vault, opens the built viewer in headless Chromium, parks the whiteboard under the
 * drawer body, and clicks. Prints PASS: / FAIL: and exits non-zero on failure.
 * Usage: pnpm test:overlay   (node --import tsx/esm --conditions=development scripts/test-overlay-clicks.ts)
 */
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scaffoldVault } from '@cubicle/core';
import type { RoutedChatResult } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig } from '@cubicle/daemon';

type Hit = { ev: string; x: number; y: number; go?: string; domTarget?: string };
type Rect = { x: number; y: number; w: number; h: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = Window & { __cubicle: any; __hits: Hit[] };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-overlay-'));
const { vault } = await scaffoldVault(dir);
vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } });
vault.close();
const llm: Llm = { async chat(): Promise<RoutedChatResult> { await new Promise((r) => setTimeout(r, 400)); return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'ok' } }] }; }, promptBudget: () => 6000 };
const PORT = 7611;
const d = new Daemon(defaultConfig(dir, process.env, { port: PORT, tickMs: 5000, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableSleepWatch: true, memory: false, log: () => undefined });
await d.start();
const token = d.ws!.token;
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const W = 1280, H = 800;
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('[page exception]', String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${PORT + 1}/?token=${token}`, { waitUntil: 'load' });
// The first snapshot opens the CEO cabin and pans to it (first run); wait for it so that pan cannot race ours.
await page.waitForFunction(() => { const c = (window as unknown as Win).__cubicle; return c?.state.connected && Object.keys(c.state.agents).length > 0; }, undefined, { timeout: 30_000 });
await page.waitForTimeout(1500);
/** Opening a surface pans the camera with a 400 ms tween. Under headless software rendering a frame can take
 *  longer than that, so the tween's last frame lands after any fixed wait and overwrites a centerOn made in
 *  between: wait for the effect itself, then for a rendered frame (worldView is refreshed on render). */
const panSettled = () => page.waitForFunction(() => !(window as unknown as Win).__cubicle.zoom(2.2).panEffect.isRunning, undefined, { timeout: 10_000 });
const framePainted = () => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
await panSettled();

const failures: string[] = [];
const fail = (msg: string) => { failures.push(msg); console.log(`FAIL: ${msg}`); };

// Record what Phaser does with each press: object-level hits, and the DOM element the raw event targeted.
await page.evaluate(() => {
  const w = window as unknown as Win;
  const scene = w.__cubicle.zoom(2.2).scene;
  w.__hits = [];
  scene.input.on('gameobjectdown', (p: { x: number; y: number; event?: Event }, go: { type: string }) => w.__hits.push({ ev: 'gameobjectdown', x: p.x, y: p.y, go: go.type, domTarget: (p.event?.target as Element | undefined)?.id || (p.event?.target as Element | undefined)?.tagName }));
  scene.input.on('pointerdownoutside', (p: { x: number; y: number; event?: Event }) => w.__hits.push({ ev: 'pointerdownoutside', x: p.x, y: p.y, domTarget: (p.event?.target as Element | undefined)?.id || (p.event?.target as Element | undefined)?.tagName }));
});

// 1. Open the Queue drawer, then pan so the whiteboard's hit box lies under the drawer body.
await page.evaluate(() => (window as unknown as Win).__cubicle.open('noticeboard'));
await page.waitForTimeout(300);   // the drawer's open transition
await panSettled();
const body = (await page.locator('#panel-body').boundingBox())!;
const target = { x: body.x + body.width * 0.25, y: body.y + body.height / 2 };   // inside the drawer, near its left edge
await page.evaluate(({ W, H, target }) => {
  const w = window as unknown as Win;
  const cam = w.__cubicle.zoom(2.2);
  const b = cam.scene.surfaces.get('whiteboard').bg.getBounds();
  cam.centerOn(b.centerX + (W / 2 - target.x) / cam.zoom, b.centerY + (H / 2 - target.y) / cam.zoom);
}, { W, H, target });
await framePainted();
const geo = await page.evaluate(() => {
  const w = window as unknown as Win;
  const cam = w.__cubicle.zoom(2.2);
  const b = cam.scene.surfaces.get('whiteboard').bg.getBounds();
  const wv = cam.worldView;
  const screen: Rect = { x: (b.x - wv.x) * cam.zoom, y: (b.y - wv.y) * cam.zoom, w: b.width * cam.zoom, h: b.height * cam.zoom };
  return screen;
});
const pb = { x0: body.x, x1: body.x + body.width, y0: body.y, y1: body.y + body.height };
const ix0 = Math.max(geo.x, pb.x0), ix1 = Math.min(geo.x + geo.w, pb.x1), iy0 = Math.max(geo.y, pb.y0), iy1 = Math.min(geo.y + geo.h, pb.y1);
if (ix1 <= ix0 || iy1 <= iy0) throw new Error(`setup: whiteboard ${JSON.stringify(geo)} is not under the drawer body ${JSON.stringify(pb)}`);
const px = Math.round((ix0 + ix1) / 2), py = Math.round((iy0 + iy1) / 2);
const under = await page.evaluate(({ px, py }) => document.elementFromPoint(px, py)?.closest('#panel') ? 'panel' : document.elementFromPoint(px, py)?.tagName, { px, py });
if (under !== 'panel') throw new Error(`setup: expected the drawer at (${px},${py}), found ${under}`);
// Phaser's own camera math must agree that the whiteboard is under that point.
const onBoard = await page.evaluate(({ px, py }) => { const w = window as unknown as Win; const cam = w.__cubicle.zoom(2.2); const wp = cam.getWorldPoint(px, py); return cam.scene.surfaces.get('whiteboard').bg.getBounds().contains(wp.x, wp.y) as boolean; }, { px, py });
if (!onBoard) throw new Error(`setup: Phaser does not place the whiteboard under (${px},${py})`);

// 2. Click inside the drawer, over the whiteboard.
await page.mouse.click(px, py);
await page.waitForTimeout(300);
const r1 = await page.evaluate(() => { const w = window as unknown as Win; return { hits: w.__hits, modalOpen: document.getElementById('modal')!.classList.contains('open'), drawer: document.getElementById('panel-title')!.textContent }; });
console.log(`click in the drawer at (${px},${py}) over the whiteboard →`, JSON.stringify(r1));
if (r1.hits.some((h) => h.ev === 'gameobjectdown')) fail('a press on the drawer reached a game object beneath it');
if (r1.modalOpen) fail('the Plan modal opened from a click inside the Queue drawer');
if (r1.drawer !== 'Queue') fail(`the drawer changed to "${r1.drawer}" from a click inside it`);

/** Close a modal a failed step may have left open, so each step judges only its own press. */
const closeModal = () => page.evaluate(() => { const m = document.getElementById('modal')!; if (m.classList.contains('open')) document.getElementById('modal-close')!.click(); (window as unknown as Win).__hits = []; });

// 3. Drag the office and release over the drawer: the pointer must not stay down.
await closeModal();
const canvasPt = { x: 300, y: 400 };
await page.mouse.move(canvasPt.x, canvasPt.y);
await page.mouse.down();
await page.mouse.move(canvasPt.x + 60, canvasPt.y + 20, { steps: 4 });
await page.mouse.move(px, py, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(200);
const r2 = await page.evaluate(() => { const w = window as unknown as Win; const scene = w.__cubicle.zoom(2.2).scene; return { isDown: scene.input.activePointer.isDown as boolean, hits: w.__hits, modalOpen: document.getElementById('modal')!.classList.contains('open') }; });
console.log('drag from the office, release over the drawer →', JSON.stringify(r2));
if (r2.isDown) fail('after releasing over the drawer the pointer is still down (drag would keep panning)');
if (r2.hits.some((h) => h.ev === 'gameobjectdown')) fail('a drag that started on the office hit a game object when released over the drawer');
if (r2.modalOpen) fail('releasing a drag over the drawer opened the Plan modal');

// 4. Clicks on the office itself still work.
await closeModal();
await page.evaluate(() => { (window as unknown as Win).__cubicle.zoom(2.2).scene.input.activePointer.reset(); });
await page.evaluate(() => { const w = window as unknown as Win; const cam = w.__cubicle.zoom(2.2); const b = cam.scene.surfaces.get('whiteboard').bg.getBounds(); cam.centerOn(b.centerX, b.centerY); });
await page.evaluate(() => document.getElementById('panel-close')!.click());
await panSettled();
await framePainted();
await page.mouse.click(W / 2, H / 2);
await page.waitForTimeout(300);
const r3 = await page.evaluate(() => { const w = window as unknown as Win; return { hits: w.__hits, modalOpen: document.getElementById('modal')!.classList.contains('open') }; });
console.log('click on the whiteboard in the office →', JSON.stringify(r3));
if (!r3.hits.some((h) => h.ev === 'gameobjectdown' && h.domTarget === 'CANVAS')) fail('a click on the office no longer reaches the whiteboard');
if (!r3.modalOpen) fail('clicking the whiteboard in the office did not open the Plan modal');

await browser.close();
await d.stop();
if (failures.length) { console.log(`FAIL: ${failures.length} check(s) failed`); process.exit(1); }
console.log('PASS: presses on the HTML layer stay on the HTML layer; releases and office clicks still reach Phaser');
process.exit(0);
