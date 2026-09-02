import { z } from 'zod';
import { defineTool } from '../registry.js';

const lastHit = new Map<string, number>();
const robotsCache = new Map<string, string[]>();

/** Minimal robots.txt: collect Disallow rules for User-agent: * (and our UA). */
async function disallowedPaths(origin: string, ua: string, timeoutMs: number): Promise<string[]> {
  if (robotsCache.has(origin)) return robotsCache.get(origin)!;
  let rules: string[] = [];
  try {
    const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': ua } });
    if (res.ok) {
      const text = await res.text();
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
  robotsCache.set(origin, rules);
  return rules;
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

export const httpFetch = defineTool({
  name: 'http.fetch',
  description: 'Fetch a public URL and return its text (HTML converted to plain text). Respects robots.txt and per-host rate limits.',
  schema: { url: z.string().url(), raw: z.boolean().default(false).describe('return raw body instead of extracted text') },
  async handler({ url, raw }, ctx) {
    const cfg = ctx.config.http_fetch;
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return { ok: false, text: 'only http(s) URLs are allowed' };
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0)/.test(u.hostname) && !ctx.env.CUBICLE_ALLOW_LOCAL_FETCH) return { ok: false, text: 'refusing to fetch a local/private address' };
    const rules = await disallowedPaths(u.origin, cfg.user_agent, cfg.timeout_ms);
    if (rules.some((r) => u.pathname.startsWith(r))) return { ok: false, text: `robots.txt disallows ${u.pathname} on ${u.host}` };
    const wait = (lastHit.get(u.host) ?? 0) + cfg.per_host_interval_ms - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastHit.set(u.host, Date.now());
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(cfg.timeout_ms), headers: { 'user-agent': cfg.user_agent, accept: 'text/html,application/json,text/plain,*/*' }, redirect: 'follow' });
      const buf = Buffer.from(await res.arrayBuffer());
      const body = buf.subarray(0, cfg.max_bytes).toString('utf8');
      const type = res.headers.get('content-type') ?? '';
      const text = raw || !/html/i.test(type) ? body : htmlToText(body);
      const truncated = buf.length > cfg.max_bytes ? `\n…[truncated at ${cfg.max_bytes} bytes]` : '';
      return { ok: res.ok, text: `HTTP ${res.status} ${type}\n\n${text}${truncated}`, data: { status: res.status, contentType: type, length: buf.length } };
    } catch (err) {
      return { ok: false, text: `fetch failed: ${(err as Error).message}` };
    }
  },
});
