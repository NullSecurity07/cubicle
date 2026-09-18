import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BrowserContext, Page, CDPSession } from 'playwright';
import { defineTool, type ToolContext } from '../registry.js';
import { assertPublicHost } from './http.js';

/** Frames flow to the daemon's WS `frame` op through this emitter: ('frame', {session, seq, jpegBase64}). */
export const browserFrames = new EventEmitter();
browserFrames.setMaxListeners(50);

const FPS = 5;
const MAX_SESSIONS = 2;
const IDLE_MS = 10 * 60_000;

interface Session { id: string; ctx: BrowserContext; page: Page; cdp: CDPSession | null; seq: number; lastFrameAt: number; lastUsed: number; roleId: string; jobId: string | null;
  /** the page is a security check rather than the site: the office does not hang one of these on its billboard */
  challenge: boolean }

/**
 * Is this page the site, or the wall in front of it?
 *
 * A bot check is a real thing that happens to an agent with a browser, and the agent's own transcript should say
 * so. What it must not do is become the company's hero screen: the dry-run found the office billboard — the one
 * picture a visitor sees of what the company is working on — showing "Performing security verification".
 */
export function isInterstitial(title: string, text = ''): boolean {
  const t = `${title}\n${text.slice(0, 400)}`.toLowerCase();
  return /security verification|just a moment|checking your browser|verify (you are|you're) (a )?human|are you a robot|captcha|access denied|attention required|ddos protection|enable javascript and cookies/.test(t);
}
const sessions = new Map<string, Session>();

async function launch(ctx: ToolContext): Promise<Session> {
  const { chromium } = await import('playwright');
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    await closeSession(oldest.id, ctx);
  }
  const profile = ctx.vault.abs(`.cubicle/browser/${ctx.roleId.replace(/[^a-z0-9_-]/gi, '_')}`); // one profile per role: logins never cross roles
  mkdirSync(profile, { recursive: true });
  const bctx = await chromium.launchPersistentContext(profile, { headless: ctx.env.CUBICLE_BROWSER_HEADED !== '1', viewport: { width: 1024, height: 700 }, args: ['--disable-dev-shm-usage'] });
  // Every request (navigations, redirects, clicks, subresources) is checked: only http(s) to public hosts.
  await bctx.route('**/*', async (route) => {
    const u = route.request().url();
    let reason: string | null = null;
    try {
      const url = new URL(u);
      if (!/^https?:$/.test(url.protocol)) reason = `scheme ${url.protocol} refused`;
      else reason = await assertPublicHost(url.hostname, ctx.env);
      const banned = ctx.vault.constitution().banned_channels.map((b) => b.toLowerCase());
      if (!reason && banned.some((b) => url.hostname.toLowerCase().includes(b))) reason = `constitution: channel ${url.hostname} is banned`;
    } catch { reason = 'unparsable url'; }
    if (reason) { ctx.events.emit({ type: 'guardrail.blocked', agent: ctx.roleId, job: ctx.jobId, payload: { tool: 'browser', url: u.slice(0, 200), reason } }); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const page = bctx.pages()[0] ?? (await bctx.newPage());
  const id = `${ctx.jobId ?? ctx.roleId}-${Date.now().toString(36)}`;
  const s: Session = { id, ctx: bctx, page, cdp: null, seq: 0, lastFrameAt: 0, lastUsed: Date.now(), roleId: ctx.roleId, jobId: ctx.jobId , challenge: false };
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
      storeFrame(ctx, s, ev.data);
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 45, maxWidth: 640, maxHeight: 440, everyNthFrame: 2 });
  } catch (err) {
    ctx.events.emit({ type: 'daemon.warning', agent: ctx.roleId, job: ctx.jobId, payload: { where: 'browser.screencast', message: String((err as Error).message) } });
  }
  return s;
}

/** Persist one JPEG frame (base64) for a session: file + screens row + event + WS push; throttled to FPS. */
function storeFrame(ctx: ToolContext, s: Session, jpegBase64: string, force = false): boolean {
  const now = Date.now();
  if (!force && now - s.lastFrameAt < 1000 / FPS) return false; // drop at the daemon, not the viewer
  s.lastFrameAt = now; s.seq++;
  const rel = `.cubicle/screens/${s.id}/${String(s.seq).padStart(5, '0')}.jpg`;
  try { mkdirSync(path.dirname(ctx.vault.abs(rel)), { recursive: true }); writeFileSync(ctx.vault.abs(rel), Buffer.from(jpegBase64, 'base64')); } catch { return false; }
  ctx.vault.db.prepare('INSERT OR REPLACE INTO screens(session_id, seq, ts, path) VALUES (?, ?, ?, ?)').run(s.id, s.seq, new Date(now).toISOString(), rel);
  ctx.events.emit({ type: 'browser.frame', agent: ctx.roleId, job: ctx.jobId, payload: { session: s.id, seq: s.seq, path: rel, ...(s.challenge ? { challenge: true } : {}) } });
  browserFrames.emit('frame', { session: s.id, seq: s.seq, jpegBase64 });
  return true;
}

/** After a navigation, make sure the billboard has something to show even if the screencast has not fired yet. */
async function ensureFrame(ctx: ToolContext, s: Session): Promise<void> {
  const before = s.seq;
  await s.page.waitForTimeout(350).catch(() => undefined);
  if (s.seq > before) return;
  try { const buf = await s.page.screenshot({ type: 'jpeg', quality: 45 }); storeFrame(ctx, s, buf.toString('base64'), true); } catch { /* page gone */ }
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

let launching: Promise<Session> | null = null;
async function get(ctx: ToolContext, session?: string): Promise<Session> {
  if (session && sessions.has(session)) {
    const s = sessions.get(session)!;
    if (s.roleId !== ctx.roleId) throw new Error(`session ${session} belongs to ${s.roleId}`);
    s.lastUsed = Date.now(); return s;
  }
  const own = [...sessions.values()].find((s) => s.jobId === ctx.jobId && s.roleId === ctx.roleId);
  if (own) { own.lastUsed = Date.now(); return own; }
  if (launching) await launching.catch(() => undefined); // serialise launches so MAX_SESSIONS holds
  launching = launch(ctx);
  try { return await launching; } finally { launching = null; }
}

/** Idle sessions are closed (with a real session_ended event) so a forgotten browser does not sit on the billboard forever. */
const idleEvents: { emit: ToolContext['events']['emit'] }[] = [];
setInterval(() => { for (const s of sessions.values()) if (Date.now() - s.lastUsed > IDLE_MS) void closeSession(s.id, { events: (idleEvents[0] ?? { emit: () => undefined }) as never, roleId: s.roleId, jobId: s.jobId }); }, 60_000).unref();

const sessionArg = z.string().optional().describe('session id from browser.open (defaults to this job\'s session)');

/** Pre-navigation check (the route handler is the enforcement; this gives a clear error before a session is opened). */
async function refuseUrl(u: string, ctx: ToolContext): Promise<string | null> {
  let url: URL;
  try { url = new URL(u); } catch { return 'invalid url'; }
  if (!/^https?:$/.test(url.protocol)) return `only http(s) URLs may be opened (got ${url.protocol})`;
  const bad = await assertPublicHost(url.hostname, ctx.env);
  if (bad) return bad;
  const banned = ctx.vault.constitution().banned_channels.map((b) => b.toLowerCase());
  if (banned.some((b) => url.hostname.toLowerCase().includes(b))) return `constitution: channel ${url.hostname} is banned`;
  return null;
}

export const browserOpen = defineTool({
  name: 'browser.open',
  description: 'Open a browser session (persistent profile). Returns the session id. Optionally navigates to a URL.',
  schema: { url: z.string().url().optional() },
  async handler({ url }, ctx) {
    idleEvents[0] = ctx.events;
    if (url) { const bad = await refuseUrl(url, ctx); if (bad) return { ok: false, text: `blocked: ${bad}` }; }
    const s = await get(ctx);
    if (url) { await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); await ensureFrame(ctx, s); }
    return { ok: true, text: `session ${s.id} open${url ? ` at ${s.page.url()}` : ''}`, data: { session: s.id } };
  },
});

export const browserGoto = defineTool({
  name: 'browser.goto',
  description: 'Navigate the session to a URL and return the page title + first 2000 chars of visible text.',
  schema: { url: z.string().url(), session: sessionArg },
  async handler({ url, session }, ctx) {
    const bad = await refuseUrl(url, ctx); if (bad) return { ok: false, text: `blocked: ${bad}` };
    const s = await get(ctx, session);
    const res = await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((err: Error) => { throw new Error(`navigation failed: ${err.message.split('\n')[0]}`); });
    await ensureFrame(ctx, s);
    const text = (await s.page.innerText('body').catch(() => '')).replace(/\s+\n/g, '\n').slice(0, 2000);
    const title = await s.page.title();
    // What the agent sees is what the agent sees; what the office hangs on the billboard is not a bot check.
    s.challenge = isInterstitial(title, text);
    return { ok: !!res && res.ok(), text: `${res?.status() ?? '?'} ${title}\n${s.page.url()}\n\n${text}`, data: { session: s.id, status: res?.status(), ...(s.challenge ? { challenge: true } : {}) } };
  },
});

export const browserClick = defineTool({
  name: 'browser.click',
  description: 'Click an element by CSS selector or visible text (text=...).',
  schema: { selector: z.string(), session: sessionArg },
  async handler({ selector, session }, ctx) {
    const s = await get(ctx, session);
    const el = s.page.locator(selector).first();
    const submits = await el.evaluate((e) => {
      const el = e as HTMLElement;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (tag === 'button' && type !== 'button' && (el.closest('form') || el.getAttribute('form'))) return true;
      if (tag === 'input' && (type === 'submit' || type === 'image')) return true;
      return false;
    }, { timeout: 10_000 }).catch(() => false);
    if (submits) return { ok: false, text: `"${selector}" submits a form; use browser.submit (owner approval) instead` };
    await el.click({ timeout: 10_000 });
    await s.page.waitForLoadState('domcontentloaded').catch(() => undefined);
    return { ok: true, text: `clicked ${selector}; now at ${s.page.url()}` };
  },
});

export const browserType = defineTool({
  name: 'browser.type',
  description: 'Type text into an input (CSS selector). Does NOT submit; use browser.submit for forms that send data.',
  schema: { selector: z.string(), text: z.string(), session: sessionArg },
  async handler({ selector, text, session }, ctx) {
    if (/[\r\n]/.test(text)) return { ok: false, text: 'newlines are not allowed in browser.type (they could submit); use browser.submit for the final action' };
    const s = await get(ctx, session);
    await s.page.fill(selector, text, { timeout: 10_000 });
    return { ok: true, text: `typed ${text.length} chars into ${selector}` };
  },
});

export const browserSubmit = defineTool({
  name: 'browser.submit',
  description: 'Submit a form as one self-contained action: navigate to url, fill fields, press the submit control. Outbound: the owner approves exactly this url + fields. Works even after the session was closed.',
  schema: {
    url: z.string().url().describe('the page with the form'),
    fields: z.record(z.string(), z.string()).default({}).describe('CSS selector → value to fill before submitting'),
    submit: z.string().describe('submit button selector, or the input to press Enter in'),
    session: sessionArg,
  },
  async handler({ url, fields, submit, session }, ctx) {
    if (!ctx.idempotencyKey) return { ok: false, text: 'browser.submit requires an idempotency key (harness bug)' };
    const bad = await refuseUrl(url, ctx); if (bad) return { ok: false, text: `blocked: ${bad}` };
    const s = await get(ctx, session);
    const wantHost = new URL(url).hostname;
    if (s.page.url() !== url) await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (new URL(s.page.url()).hostname !== wantHost) return { ok: false, text: `page is at ${s.page.url()}, not ${wantHost}; refusing to submit` };
    for (const [sel, val] of Object.entries(fields)) await s.page.fill(sel, val, { timeout: 10_000 });
    const el = s.page.locator(submit).first();
    const tag = (await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => 'button'));
    if (tag === 'input' || tag === 'textarea') await el.press('Enter'); else await el.click({ timeout: 10_000 });
    await s.page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await ensureFrame(ctx, s);
    return { ok: true, text: `submitted ${Object.keys(fields).length} field(s) at ${url}; now at ${s.page.url()}`, sideEffectKey: ctx.idempotencyKey };
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
