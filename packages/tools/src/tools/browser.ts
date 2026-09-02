import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BrowserContext, Page, CDPSession } from 'playwright';
import { defineTool, type ToolContext } from '../registry.js';

/** Frames flow to the daemon's WS `frame` op through this emitter: ('frame', {session, seq, jpegBase64}). */
export const browserFrames = new EventEmitter();
browserFrames.setMaxListeners(50);

const FPS = 5;
const MAX_SESSIONS = 2;
const IDLE_MS = 10 * 60_000;

interface Session { id: string; ctx: BrowserContext; page: Page; cdp: CDPSession | null; seq: number; lastFrameAt: number; lastUsed: number; roleId: string; jobId: string | null }
const sessions = new Map<string, Session>();

async function launch(ctx: ToolContext): Promise<Session> {
  const { chromium } = await import('playwright');
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    await closeSession(oldest.id, ctx);
  }
  const profile = ctx.vault.abs('.cubicle/browser');
  mkdirSync(profile, { recursive: true });
  const bctx = await chromium.launchPersistentContext(profile, { headless: ctx.env.CUBICLE_BROWSER_HEADED !== '1', viewport: { width: 1024, height: 700 }, args: ['--disable-dev-shm-usage'] });
  const page = bctx.pages()[0] ?? (await bctx.newPage());
  const id = `${ctx.jobId ?? ctx.roleId}-${Date.now().toString(36)}`;
  const s: Session = { id, ctx: bctx, page, cdp: null, seq: 0, lastFrameAt: 0, lastUsed: Date.now(), roleId: ctx.roleId, jobId: ctx.jobId };
  sessions.set(id, s);
  ctx.events.emit({ type: 'browser.session_started', agent: ctx.roleId, job: ctx.jobId, payload: { session: id } });
  // Screencast (verified CDP API): frames ≤ 5 fps → .cubicle/screens/<session>/<seq>.jpg + screens table + WS frame op
  try {
    const cdp = await bctx.newCDPSession(page);
    s.cdp = cdp;
    const dir = ctx.vault.abs(`.cubicle/screens/${id}`);
    mkdirSync(dir, { recursive: true });
    cdp.on('Page.screencastFrame', (ev: { data: string; sessionId: number }) => {
      cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => undefined);
      const now = Date.now();
      if (now - s.lastFrameAt < 1000 / FPS) return; // drop at the daemon, not the viewer
      s.lastFrameAt = now; s.seq++;
      const rel = `.cubicle/screens/${id}/${String(s.seq).padStart(5, '0')}.jpg`;
      try { writeFileSync(ctx.vault.abs(rel), Buffer.from(ev.data, 'base64')); } catch { return; }
      ctx.vault.db.prepare('INSERT OR REPLACE INTO screens(session_id, seq, ts, path) VALUES (?, ?, ?, ?)').run(id, s.seq, new Date(now).toISOString(), rel);
      ctx.events.emit({ type: 'browser.frame', agent: ctx.roleId, job: ctx.jobId, payload: { session: id, seq: s.seq, path: rel } });
      browserFrames.emit('frame', { session: id, seq: s.seq, jpegBase64: ev.data });
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 45, maxWidth: 640, maxHeight: 440, everyNthFrame: 2 });
  } catch (err) {
    ctx.events.emit({ type: 'daemon.warning', agent: ctx.roleId, job: ctx.jobId, payload: { where: 'browser.screencast', message: String((err as Error).message) } });
  }
  return s;
}

export async function closeSession(id: string, ctx: Pick<ToolContext, 'events' | 'roleId' | 'jobId'>): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { await s.cdp?.send('Page.stopScreencast'); } catch { /* ignore */ }
  try { await s.ctx.close(); } catch { /* ignore */ }
  ctx.events.emit({ type: 'browser.session_ended', agent: ctx.roleId, job: ctx.jobId, payload: { session: id, frames: s.seq } });
}

export async function closeAllSessions(events: ToolContext['events']): Promise<void> {
  for (const id of [...sessions.keys()]) await closeSession(id, { events, roleId: 'daemon', jobId: null });
}

async function get(ctx: ToolContext, session?: string): Promise<Session> {
  if (session && sessions.has(session)) { const s = sessions.get(session)!; s.lastUsed = Date.now(); return s; }
  const own = [...sessions.values()].find((s) => s.jobId === ctx.jobId);
  if (own) { own.lastUsed = Date.now(); return own; }
  return launch(ctx);
}

/** Idle sessions are closed so a forgotten browser does not sit on the billboard forever. */
setInterval(() => { for (const s of sessions.values()) if (Date.now() - s.lastUsed > IDLE_MS) void closeSession(s.id, { events: { emit: () => undefined } as never, roleId: s.roleId, jobId: s.jobId }); }, 60_000).unref();

const sessionArg = z.string().optional().describe('session id from browser.open (defaults to this job\'s session)');

function isPrivateUrl(u: string, env: NodeJS.ProcessEnv): boolean {
  if (env.CUBICLE_ALLOW_LOCAL_FETCH) return false;
  try { const url = new URL(u); return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\]|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) || url.hostname.endsWith('.local'); } catch { return true; }
}

export const browserOpen = defineTool({
  name: 'browser.open',
  description: 'Open a browser session (persistent profile). Returns the session id. Optionally navigates to a URL.',
  schema: { url: z.string().url().optional() },
  async handler({ url }, ctx) {
    const s = await launch(ctx);
    if (url) { if (isPrivateUrl(url, ctx.env)) return { ok: false, text: 'refusing to open a private/local address' }; await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
    return { ok: true, text: `session ${s.id} open${url ? ` at ${s.page.url()}` : ''}`, data: { session: s.id } };
  },
});

export const browserGoto = defineTool({
  name: 'browser.goto',
  description: 'Navigate the session to a URL and return the page title + first 2000 chars of visible text.',
  schema: { url: z.string().url(), session: sessionArg },
  async handler({ url, session }, ctx) {
    if (isPrivateUrl(url, ctx.env)) return { ok: false, text: 'refusing to open a private/local address' };
    const s = await get(ctx, session);
    const res = await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const text = (await s.page.innerText('body').catch(() => '')).replace(/\s+\n/g, '\n').slice(0, 2000);
    return { ok: !!res && res.ok(), text: `${res?.status() ?? '?'} ${await s.page.title()}\n${s.page.url()}\n\n${text}`, data: { session: s.id, status: res?.status() } };
  },
});

export const browserClick = defineTool({
  name: 'browser.click',
  description: 'Click an element by CSS selector or visible text (text=...).',
  schema: { selector: z.string(), session: sessionArg },
  async handler({ selector, session }, ctx) {
    const s = await get(ctx, session);
    await s.page.click(selector, { timeout: 10_000 });
    await s.page.waitForLoadState('domcontentloaded').catch(() => undefined);
    return { ok: true, text: `clicked ${selector}; now at ${s.page.url()}` };
  },
});

export const browserType = defineTool({
  name: 'browser.type',
  description: 'Type text into an input (CSS selector). Does NOT submit; use browser.submit for forms that send data.',
  schema: { selector: z.string(), text: z.string(), session: sessionArg },
  async handler({ selector, text, session }, ctx) {
    const s = await get(ctx, session);
    await s.page.fill(selector, text, { timeout: 10_000 });
    return { ok: true, text: `typed ${text.length} chars into ${selector}` };
  },
});

export const browserSubmit = defineTool({
  name: 'browser.submit',
  description: 'Submit a form (press Enter in / click the submit control). Outbound: requires owner approval by default.',
  schema: { selector: z.string().describe('submit button selector, or the input to press Enter in'), session: sessionArg },
  async handler({ selector, session }, ctx) {
    const s = await get(ctx, session);
    const el = s.page.locator(selector).first();
    const tag = (await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => 'button'));
    if (tag === 'input' || tag === 'textarea') await el.press('Enter'); else await el.click({ timeout: 10_000 });
    await s.page.waitForLoadState('domcontentloaded').catch(() => undefined);
    return { ok: true, text: `submitted via ${selector}; now at ${s.page.url()}`, sideEffectKey: ctx.idempotencyKey };
  },
});

export const browserExtract = defineTool({
  name: 'browser.extract',
  description: 'Extract text (default) or the inner HTML of the page or a selector; also lists links when links=true.',
  schema: { selector: z.string().default('body'), html: z.boolean().default(false), links: z.boolean().default(false), session: sessionArg },
  async handler({ selector, html, links, session }, ctx) {
    const s = await get(ctx, session);
    const loc = s.page.locator(selector).first();
    const content = html ? await loc.innerHTML({ timeout: 10_000 }) : await loc.innerText({ timeout: 10_000 });
    let out = content.slice(0, 20_000);
    if (links) {
      const hrefs = await s.page.$$eval('a[href]', (as) => as.slice(0, 200).map((a) => `${(a as HTMLAnchorElement).innerText.trim().slice(0, 60)} → ${(a as HTMLAnchorElement).href}`));
      out += `\n\nLinks:\n${hrefs.join('\n')}`;
    }
    return { ok: true, text: out };
  },
});

export const browserScreenshot = defineTool({
  name: 'browser.screenshot',
  description: 'Save a full-page screenshot under .cubicle/screens and return its path.',
  schema: { session: sessionArg, fullPage: z.boolean().default(false) },
  async handler({ session, fullPage }, ctx) {
    const s = await get(ctx, session);
    const rel = `.cubicle/screens/${s.id}/shot-${Date.now().toString(36)}.png`;
    mkdirSync(path.dirname(ctx.vault.abs(rel)), { recursive: true });
    await s.page.screenshot({ path: ctx.vault.abs(rel), fullPage });
    return { ok: true, text: `screenshot saved: ${rel}`, data: { path: rel } };
  },
});

export const browserClose = defineTool({
  name: 'browser.close',
  description: 'Close the browser session.',
  schema: { session: sessionArg },
  async handler({ session }, ctx) {
    const s = session ? sessions.get(session) : [...sessions.values()].find((x) => x.jobId === ctx.jobId);
    if (!s) return { ok: true, text: 'no open session' };
    await closeSession(s.id, ctx);
    return { ok: true, text: `closed ${s.id}` };
  },
});

export const browserTools = [browserOpen, browserGoto, browserClick, browserType, browserSubmit, browserExtract, browserScreenshot, browserClose];
