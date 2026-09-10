/**
 * Visual check for the office: starts a daemon on a temp vault with a scripted model, opens the viewer in headless
 * Chromium, injects a burst of events, and saves screenshots to .cubicle/shots/ in the temp vault (paths printed).
 * Usage: pnpm exec tsx --conditions=development scripts/office-shot.ts [outDir]
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
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[page exception]', String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:7512/?token=${token}`, { waitUntil: 'load' });
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(out, '1-office.png') });
// burst of events: the CMO browses, the backend engineer shells, ceo speaks, a meeting, a failed job, a hire
const ev = d.vault.events;
const g = 'job_demo_cmo'; // synthetic ids: a real job note would be picked up and finished by the worker at once
ev.emit({ type: 'job.queued', agent: 'cto', job: g, payload: { type: 'research', title: 'Find a channel', assigned: 'cmo' } });
ev.emit({ type: 'job.started', agent: 'cmo', job: g, payload: { type: 'research', title: 'Find a channel' } });
ev.emit({ type: 'agent.tool_call', agent: 'cmo', job: g, payload: { tool: 'browser.goto', summary: '{"url":"https://example.com"}', step: 1 } });
ev.emit({ type: 'browser.session_started', agent: 'cmo', job: g, payload: { session: 'demo' } });
const e = 'job_demo_engineer';
ev.emit({ type: 'job.queued', agent: 'cto', job: e, payload: { type: 'engineer.ship', title: 'Build site', assigned: 'backend_engineer' } });
ev.emit({ type: 'job.started', agent: 'backend_engineer', job: e, payload: { type: 'engineer.ship', title: 'Build site' } });
ev.emit({ type: 'agent.tool_call', agent: 'backend_engineer', job: e, payload: { tool: 'shell.run', summary: 'npm run build', step: 1 } });
ev.emit({ type: 'shell.output', agent: 'backend_engineer', job: e, payload: { session: 's', stream: 'stdout', text: '> astro build\n✓ 3 pages built in 412ms' } });
ev.emit({ type: 'agent.spoke', agent: 'ceo', job: null, payload: { to: 'owner', text: 'I proposed the name WeekPlate — approve it in 00 Inbox/.' } });
createProposal(d.vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'Name the company: WeekPlate', body: 'x' }, 'ceo');
await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(out, '2-working.png') });
console.log('billboard anchor:', JSON.stringify(await page.evaluate(() => (window as unknown as { __cubicle: { anchors: () => Record<string, unknown> } }).__cubicle.anchors().billboard)));
ev.emit({ type: 'meeting.opened', agent: 'ceo', job: null, payload: { id: 'm1', room: 'board', participants: ['ceo', 'cto', 'coo'], agenda: 'Two jobs failed' } });
// fail the backend engineer's job, not the CMO's: the CMO and the COO are both on floor 4, so failing the CMO's
// job never leaves the floor. The engineer's desk is in Dev on floor 2, so this is what actually exercises the
// COO's cross-floor ride and the elevator on the way there.
ev.emit({ type: 'job.failed', agent: 'backend_engineer', job: e, payload: { reason: 'step_limit' } });
ev.emit({ type: 'role.hired', agent: 'daemon', job: null, payload: { role: 'sales_rep', display: 'Sales rep', desk: 'sales_1', sprite: 'sales_rep' } });
await page.waitForTimeout(4500);
console.log('agents:', JSON.stringify(await page.evaluate(() => (window as unknown as { __cubicle: { agents: () => unknown } }).__cubicle.agents())));
ev.emit({ type: 'meeting.turn', agent: 'cto', job: null, payload: { id: 'm1', round: 1, text: 'Let us cut the queue to one job per role.' } });
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(out, '3-meeting.png') });
await page.click('#game', { position: { x: 640, y: 400 } }).catch(() => undefined);
await page.evaluate(() => { const el = document.querySelector('#panel'); return !!el; });
await browser.close();
console.log(`screenshots in ${out}`);
await d.stop();
process.exit(0);
