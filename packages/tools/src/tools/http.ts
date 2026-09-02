import { z } from 'zod';
import dns from 'node:dns/promises';
import net from 'node:net';
import { defineTool } from '../registry.js';

const lastHit = new Map<string, number>();
const robotsCache = new Map<string, { rules: string[]; at: number }>();
const ROBOTS_TTL_MS = 6 * 3600_000;

/** Minimal robots.txt: collect Disallow rules for User-agent: * (and our UA). Cached 6 h. */
async function disallowedPaths(origin: string, ua: string, timeoutMs: number): Promise<string[]> {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.at < ROBOTS_TTL_MS) return cached.rules;
  let rules: string[] = [];
  try {
    const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': ua }, redirect: 'manual' });
    if (res.ok) {
      const text = (await res.text()).slice(0, 200_000);
      let applies = false;
      for (const raw of text.split('\n')) {
        const line = raw.split('#')[0].trim();
        const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const [, k, v] = m;
        if (k.toLowerCase() === 'user-agent') applies = v.trim() === '*' || ua.toLowerCase().startsWith(v.trim().toLowerCase());
        else if (applies && k.toLowerCase() === 'disallow' && v.trim()) rules.push(v.trim());
      }
    }
  } catch { rules = []; }
  robotsCache.set(origin, { rules, at: Date.now() });
  return rules;
}

/** True for loopback, link-local, RFC1918, CGNAT, unspecified, and their IPv6 equivalents / mapped forms. */
export function isPrivateAddress(ip: string): boolean {
  let a = ip.trim().replace(/^\[|\]$/g, '');
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (net.isIPv4(a)) {
    const [o1, o2] = a.split('.').map(Number);
    if (o1 === 10 || o1 === 127 || o1 === 0) return true;
    if (o1 === 169 && o2 === 254) return true;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 === 192 && o2 === 168) return true;
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;
    return false;
  }
  if (net.isIPv6(a)) {
    const l = a.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (/^f[cd]/.test(l)) return true;        // fc00::/7
    if (/^fe[89ab]/.test(l)) return true;     // fe80::/10
    return false;
  }
  return true; // not an IP at all → treat as unsafe
}

export async function assertPublicHost(hostname: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (env.CUBICLE_ALLOW_LOCAL_FETCH) return null;
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return `refusing local hostname ${hostname}`;
  if (net.isIP(h)) return isPrivateAddress(h) ? `refusing private address ${hostname}` : null;
  let addrs: { address: string }[];
  try { addrs = await dns.lookup(h, { all: true }); } catch (err) { return `dns lookup failed for ${hostname}: ${(err as Error).message}`; }
  if (addrs.length === 0) return `no address for ${hostname}`;
  for (const a of addrs) if (isPrivateAddress(a.address)) return `refusing ${hostname}: resolves to private address ${a.address}`;
  return null;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Read at most `max` bytes from a response body, aborting the rest. */
async function readCapped(res: Response, max: number): Promise<{ body: Buffer; truncated: boolean }> {
  if (!res.body) return { body: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0; let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
    if (size >= max) { truncated = true; await reader.cancel().catch(() => undefined); break; }
  }
  return { body: Buffer.concat(chunks).subarray(0, max), truncated };
}

export const httpFetch = defineTool({
  name: 'http.fetch',
  description: 'Fetch a public URL and return its text (HTML converted to plain text). Respects robots.txt and per-host rate limits; never reaches private networks.',
  schema: { url: z.string().url(), raw: z.boolean().default(false).describe('return raw body instead of extracted text') },
  async handler({ url, raw }, ctx) {
    const cfg = ctx.config.http_fetch;
    let u: URL;
    try { u = new URL(url); } catch { return { ok: false, text: 'invalid URL' }; }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, text: 'only http(s) URLs are allowed' };
    const wait = (lastHit.get(u.host) ?? 0) + cfg.per_host_interval_ms - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastHit.set(u.host, Date.now());
    try {
      let current = u;
      for (let hop = 0; hop <= 5; hop++) {
        const bad = await assertPublicHost(current.hostname, ctx.env);
        if (bad) { ctx.events.emit({ type: 'guardrail.blocked', agent: ctx.roleId, job: ctx.jobId, payload: { tool: 'http.fetch', url: current.href, reason: bad } }); return { ok: false, text: `blocked: ${bad}` }; }
        const rules = await disallowedPaths(current.origin, cfg.user_agent, cfg.timeout_ms);
        if (rules.some((r) => current.pathname.startsWith(r))) return { ok: false, text: `robots.txt disallows ${current.pathname} on ${current.host}` };
        const res = await fetch(current.href, { signal: AbortSignal.timeout(cfg.timeout_ms), headers: { 'user-agent': cfg.user_agent, accept: 'text/html,application/json,text/plain,*/*' }, redirect: 'manual' });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          await res.body?.cancel().catch(() => undefined);
          current = new URL(res.headers.get('location')!, current);
          if (!/^https?:$/.test(current.protocol)) return { ok: false, text: 'redirect to a non-http URL refused' };
          continue;
        }
        const { body: buf, truncated } = await readCapped(res, cfg.max_bytes);
        const body = buf.toString('utf8');
        const type = res.headers.get('content-type') ?? '';
        const text = raw || !/html/i.test(type) ? body : htmlToText(body);
        return { ok: res.ok, text: `HTTP ${res.status} ${type}${current.href !== u.href ? ` (redirected to ${current.href})` : ''}\n\n${text}${truncated ? `\n…[truncated at ${cfg.max_bytes} bytes]` : ''}`, data: { status: res.status, contentType: type, length: buf.length, url: current.href } };
      }
      return { ok: false, text: 'too many redirects' };
    } catch (err) {
      return { ok: false, text: `fetch failed: ${(err as Error).message}` };
    }
  },
});
