import { timingSafeEqual } from 'node:crypto';

export type Asked = { path: string; method: string; headers: Record<string, string | string[] | undefined> };
// `ports`: where the app's own page can live (the api port, and Vite's port in development).
export type Own = { ports: number[]; token: string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function isOwn(origin: string, own: Own): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname) && own.ports.includes(Number(url.port || 80));
  } catch { return false; }
}

// The server listens only on this machine, but a browser on this machine will carry any web page's request to it.
// Returns why a request is refused, or null when it may pass. The api answers only the app's own page, or a script
// that holds the launch token; a page on another site, a sandboxed preview, another local app, a name that merely
// resolves here (DNS rebinding) and a server-side fetch bounced here by a redirect all get nothing.
export function guard(asked: Asked, own: Own): string | null {
  let host = '';
  try { host = new URL(`http://${one(asked.headers.host)}`).hostname; } catch { /* refused below */ }
  if (!LOOPBACK.has(host)) return 'this host name is not this machine';
  if (!asked.path.startsWith('/api/')) return null;

  const token = one(asked.headers['x-stage-token']);
  if (token) return same(token, own.token) ? null : 'wrong token';

  const origin = one(asked.headers.origin);
  if (origin && !isOwn(origin, own)) return 'requests from another site are refused';
  const site = one(asked.headers['sec-fetch-site']);
  if (site === 'same-origin') return null;
  // An address the founder typed or opened by hand: reading is fine, changing anything is not.
  if (site === 'none') return asked.method === 'GET' ? null : 'only the app\'s own page may change things';
  if (site) return 'requests from another site are refused';
  // An engine that sends no fetch metadata still names where the request came from.
  if (origin) return null;
  const referer = one(asked.headers.referer);
  if (referer && isOwn(new URL(referer, 'http://invalid').origin, own)) return null;
  return 'only the app\'s own page may use the api';
}
