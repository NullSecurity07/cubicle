import { publicUrl, unwrapRedirect, type Resolve } from './browser.ts';

// Ways to read a page without the local browser. Some sites refuse every automated browser but publish the same
// content through a feed or an official API; those are tried first. The public Internet Archive is the last resort.
export type Page = { title: string; text: string };
export type Reader = (url: string) => Promise<Page | null>;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/' };
export const decode = (text: string) => text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, name: string) => ENTITIES[name] ?? (name[0] === '#' ? String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : whole));
export const htmlToText = (html: string) => decode(html
  .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/pre)\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, ' '))
  .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

const READER_AGENT = 'cubicle/1.0 (desktop app; reads one page for its owner)';
const get = (http: typeof fetch, url: string, headers: Record<string, string> = {}) => http(url, { headers: { 'user-agent': READER_AGENT, ...headers }, signal: AbortSignal.timeout(25_000) }).then((response) => (response.ok ? response : null), () => null);

// Reddit walls browsers but serves every listing, search and thread as an Atom feed. It is asked at the same pace as
// read_reddit asks, and not at all for a minute after Reddit has told this machine to slow down, whichever of the two
// it told.
export function redditFeed(http: typeof fetch = fetch, pace: () => Promise<void> = reddit.pace): Reader {
  return async (raw) => {
    const url = new URL(raw);
    if (!/(^|\.)reddit\.com$/.test(url.hostname) || /\.(rss|json)$/.test(url.pathname)) return null;
    if (Date.now() < reddit.refusedUntil) return null;
    await pace();
    const response = await http(`https://www.reddit.com${url.pathname.replace(/\/+$/, '')}/.rss${url.search}`, { headers: { 'user-agent': READER_AGENT }, signal: AbortSignal.timeout(25_000) }).catch(() => null);
    if (response?.status === 429) reddit.refusedUntil = Date.now() + REDDIT_REST;
    if (!response?.ok) return null;
    const feed = await response.text();
    const entries = atomEntries(feed).slice(0, 25).map((entry) => `### ${entry.title}\n${entry.author} · ${entry.updated.slice(0, 10)} · ${entry.link}\n${htmlToText(entry.content).replace(/\s*submitted by[\s\S]*$/, '').slice(0, 1200)}`);
    return entries.length ? { title: plain(inner(feed.split(/<entry[\s>]/i)[0], ['title'])) || 'Reddit', text: entries.join('\n\n') } : null;
  };
}

// Stack Overflow and the Stack Exchange sites wall browsers but run a free official API (300 requests a day without a key).
export function stackExchange(http: typeof fetch = fetch): Reader {
  const siteOf = (host: string) => /^(?:www\.)?(stackoverflow|superuser|serverfault|askubuntu|mathoverflow)\.(?:com|net)$/.exec(host)?.[1] ?? /^([\w-]+)\.stackexchange\.com$/.exec(host)?.[1] ?? null;
  type Item = { title?: string; body?: string; score?: number; is_accepted?: boolean; link?: string; tags?: string[]; answer_count?: number; creation_date?: number };
  return async (raw) => {
    const url = new URL(raw);
    const site = siteOf(url.hostname);
    if (!site) return null;
    const api = async (path: string) => { const response = await get(http, `https://api.stackexchange.com/2.3${path}${path.includes('?') ? '&' : '?'}site=${site}`); return response ? ((await response.json()) as { items?: Item[] }).items ?? [] : null; };
    const question = /^\/(?:questions|q)\/(\d+)/.exec(url.pathname)?.[1];
    if (question) {
      const [asked] = (await api(`/questions/${question}?filter=withbody`)) ?? [];
      if (!asked) return null;
      const answers = (await api(`/questions/${question}/answers?filter=withbody&sort=votes&order=desc&pagesize=5`)) ?? [];
      const parts = [`Question (score ${asked.score}, tags ${asked.tags?.join(', ')}):\n${htmlToText(asked.body ?? '')}`, ...answers.map((answer) => `Answer (score ${answer.score}${answer.is_accepted ? ', accepted' : ''}):\n${htmlToText(answer.body ?? '')}`)];
      return { title: decode(asked.title ?? 'Question'), text: parts.join('\n\n---\n\n') };
    }
    const tag = /^\/questions\/tagged\/([^/]+)/.exec(url.pathname)?.[1];
    const query = url.pathname.startsWith('/search') ? url.searchParams.get('q') : null;
    const list = tag ? await api(`/questions?tagged=${encodeURIComponent(decodeURIComponent(tag))}&sort=votes&order=desc&pagesize=15`) : query ? await api(`/search/advanced?q=${encodeURIComponent(query)}&sort=relevance&pagesize=15`) : null;
    if (!list?.length) return null;
    return { title: tag ? `Top questions tagged ${decodeURIComponent(tag)}` : `Search: ${query}`, text: list.map((item) => `- ${decode(item.title ?? '')} (score ${item.score}, ${item.answer_count} answers)\n  ${item.link}`).join('\n') };
  };
}

// A public copy kept by the Internet Archive. It can be days or months old, so the text says from when.
export function archiveCopy(http: typeof fetch = fetch): Reader {
  return async (raw) => {
    const response = await get(http, `https://web.archive.org/web/2id_/${raw}`);
    if (!response) return null;
    const stamp = /\/web\/(\d{4})(\d{2})(\d{2})/.exec(response.url);
    const html = await response.text();
    const text = htmlToText(html);
    if (!text) return null;
    const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? raw);
    return { title, text: `[Archived copy${stamp ? ` from ${stamp[1]}-${stamp[2]}-${stamp[3]}` : ''}, kept by the Internet Archive: the live site refuses automated readers. Facts here may be out of date; say so.]\n\n${text}` };
  };
}

// ---------------------------------------------------------------- small words

const DAY = 86_400_000;
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
// A moment as a day, and how long ago that was. A small model reads "2024-03-02" as news unless told it is old.
export const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);
// Counted in calendar days, so last night is yesterday and not "today".
export function age(at: number, now: number): string {
  const days = Math.floor(now / DAY) - Math.floor(at / DAY);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 60 ? `${days} days ago` : days < 730 ? `${Math.floor(days / 30)} months ago` : `${Math.floor(days / 365)} years ago`;
}
export const when = (at: number, now: number) => `${isoDay(at)} (${age(at, now)})`;
// One attribute of one tag, quoted either way or not at all.
export const attr = (tag: string, name: string) => {
  const found = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return found ? decode(found[1] ?? found[2] ?? found[3] ?? '') : null;
};

// ---------------------------------------------------------------- fetching the open web

export type Got = { status: number; url: string; type: string; body: string };
export type PublicGet = {
  http: typeof fetch; resolveHost?: Resolve; agent: string; accept?: string; signal?: AbortSignal;
  // A time limit of its own, on top of `signal`. Left out when the caller's signal already carries one.
  timeoutMs?: number;
  // Only hosts this matches are followed: Reddit's reads stay on Reddit.
  only?: RegExp;
  // Anything that is not a page (or plain text) is let go unread, with an empty body.
  htmlOnly?: boolean;
  // A redirect through a known link-tracker is followed to where it really points.
  unwrap?: boolean;
  bodyBytes?: number;
};
const BODY_BYTES = 5_000_000;

// A read of the open web that can never be steered onto this machine: the address, and every address a redirect sends
// it on to, is checked the way the browser checks one. The crawl and the readers both read this way.
export async function getPublic(raw: string, options: PublicGet): Promise<Got> {
  const { signal: given, timeoutMs } = options;
  const signal = timeoutMs === undefined ? given : given ? AbortSignal.any([given, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let url = await publicUrl(raw, options.resolveHost);
  for (let hop = 0; hop < 5; hop += 1) {
    if (options.only && !options.only.test(new URL(url).hostname)) throw new Error(`it was sent on to ${new URL(url).hostname}, which this reader does not follow`);
    const response = await options.http(url, { headers: { 'user-agent': options.agent, accept: options.accept ?? '*/*' }, redirect: 'manual', credentials: 'omit', signal });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      const next = new URL(location, url).href;
      url = await publicUrl(options.unwrap ? unwrapRedirect(next) : next, options.resolveHost);
      continue;
    }
    const type = response.headers.get('content-type') ?? '';
    // Only a page is worth its bytes; anything else is let go unread.
    if (options.htmlOnly && type && !/html/i.test(type) && !/^text\/plain/i.test(type)) { await response.body?.cancel().catch(() => {}); return { status: response.status, url, type, body: '' }; }
    return { status: response.status, url, type, body: await capped(response, options.bodyBytes) };
  }
  throw new Error('it redirected too many times');
}
// The body, up to a size: a page that never ends is cut, not waited for.
export async function capped(response: Response, most = BODY_BYTES): Promise<string> {
  if (!response.body) return (await response.text()).slice(0, most);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < most) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}
// What went wrong, in a few words a person can pass on.
export const failure = (error: unknown) => {
  const message = (error as Error).message ?? String(error);
  return /timeout|aborted/i.test((error as Error).name ?? '') || /timeout|aborted/i.test(message) ? 'it took too long to answer' : message;
};

// ---------------------------------------------------------------- pace

// No more than one request every `gap` milliseconds, however many people ask at once.
export function createPace(gap: number, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => { setTimeout(done, ms); })) {
  let next = 0;
  return async () => {
    const at = Math.max(now(), next);
    next = at + gap;
    const wait = at - now();
    if (wait > 0) await sleep(wait);
  };
}

// Reddit asks for no more than one request a second from anyone without a login; one every two keeps well clear. One
// pace for the whole app, and one memory of being refused, because read_reddit and a web_fetch of a Reddit page both
// come from the same machine and Reddit counts them together.
export const REDDIT_GAP = 2000;
export const REDDIT_AGENT = 'cubicle-reader/1.0 (desktop app; reads public Reddit for its owner)';
// How long Reddit is left alone after it said to slow down.
export const REDDIT_REST = 60_000;
export const reddit = {
  pace: createPace(REDDIT_GAP),
  // Where Reddit has refused its data from this machine, its feed is asked first for a while instead.
  jsonRefusedUntil: 0,
  // Where Reddit has said to slow down (429), nothing asks it again for a minute.
  refusedUntil: 0,
};
export const resetReddit = () => { reddit.jsonRefusedUntil = 0; reddit.refusedUntil = 0; };

// ---------------------------------------------------------------- feeds

export type Item = { title: string; link: string; at: number | null; summary: string };
export type Feed = { title: string; kind: 'RSS' | 'Atom' | 'JSON Feed'; items: Item[] };

// A tolerant reader for the few tags a feed is made of. Feeds in the wild are too often broken XML for a strict parser
// to be the better choice: a regular expression over each item reads what is there and skips what is not.
const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function inner(block: string, names: string[]): string {
  for (const name of names) {
    const found = new RegExp(`<${escape(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escape(name)}>`, 'i').exec(block);
    if (found) return found[1];
  }
  return '';
}
// Text inside CDATA is already what it says; outside it, entities are still to be read.
export const cdata = (value: string) => (value.includes('<![CDATA[') ? [...value.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((one) => one[1]).join('') : decode(value));
export const plain = (value: string) => oneLine(htmlToText(cdata(value)));
export const dateOf = (value: string) => { const at = Date.parse(cdata(value).trim()); return Number.isFinite(at) ? at : null; };

// Every entry of an Atom feed, the one way both Reddit readers read one: `content` is the entry's HTML, entities read.
export function atomEntries(body: string) {
  return [...body.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map(([, entry]) => ({
    title: plain(inner(entry, ['title'])),
    author: plain(inner(entry, ['name'])),
    at: dateOf(inner(entry, ['published', 'updated'])),
    updated: plain(inner(entry, ['updated'])),
    link: attr(/<link\b[^>]*>/i.exec(entry)?.[0] ?? '', 'href') ?? '',
    content: cdata(inner(entry, ['content'])),
  }));
}

export function parseFeed(body: string): Feed | null {
  const text = body.replace(/^\uFEFF/, '').trim();
  if (text.startsWith('{')) {
    let data: { version?: string; title?: string; items?: Record<string, unknown>[] };
    try { data = JSON.parse(text); } catch { return null; }
    if (!Array.isArray(data.items) || !/jsonfeed/i.test(String(data.version ?? ''))) return null;
    const items = data.items.map((item) => {
      const html = typeof item.content_html === 'string' ? htmlToText(item.content_html) : '';
      const at = Date.parse(String(item.date_published ?? item.date_modified ?? ''));
      return { title: oneLine(String(item.title ?? '')), link: String(item.url ?? item.external_url ?? ''), at: Number.isFinite(at) ? at : null, summary: oneLine(String(item.summary ?? item.content_text ?? html)) };
    });
    return { title: oneLine(String(data.title ?? '')), kind: 'JSON Feed', items };
  }
  const head = text.replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/g, '').slice(0, 2000);
  if (/<(rss|rdf:RDF)[\s>]/i.test(head)) {
    const items = [...text.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(([, item]) => {
      const guid = /<guid(?![^>]*isPermaLink\s*=\s*["']false)[^>]*>([\s\S]*?)<\/guid>/i.exec(item)?.[1] ?? '';
      return {
        title: plain(inner(item, ['title'])),
        link: cdata(inner(item, ['link'])).trim() || cdata(guid).trim(),
        at: dateOf(inner(item, ['pubDate', 'dc:date', 'published', 'updated'])),
        summary: plain(inner(item, ['description', 'content:encoded', 'summary'])),
      };
    });
    return { title: plain(inner(text.split(/<item[\s>]/i)[0], ['title'])), kind: 'RSS', items };
  }
  if (/<feed[\s>]/i.test(head)) {
    const items = [...text.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map(([, entry]) => {
      const links = [...entry.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => ({ rel: attr(tag, 'rel') ?? 'alternate', href: attr(tag, 'href') ?? '' }));
      return {
        title: plain(inner(entry, ['title'])),
        link: (links.find((one) => one.rel === 'alternate') ?? links[0])?.href ?? '',
        at: dateOf(inner(entry, ['published', 'updated'])),
        summary: plain(inner(entry, ['summary', 'content'])),
      };
    });
    return { title: plain(inner(text.split(/<entry[\s>]/i)[0], ['title'])), kind: 'Atom', items };
  }
  return null;
}

