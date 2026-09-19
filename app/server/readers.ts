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

const get = (http: typeof fetch, url: string, headers: Record<string, string> = {}) => http(url, { headers: { 'user-agent': 'cubicle/1.0 (desktop app; reads one page for its owner)', ...headers }, signal: AbortSignal.timeout(25_000) }).then((response) => (response.ok ? response : null), () => null);

// Reddit walls browsers but serves every listing, search and thread as an Atom feed.
export function redditFeed(http: typeof fetch = fetch): Reader {
  return async (raw) => {
    const url = new URL(raw);
    if (!/(^|\.)reddit\.com$/.test(url.hostname) || /\.(rss|json)$/.test(url.pathname)) return null;
    const response = await get(http, `https://www.reddit.com${url.pathname.replace(/\/+$/, '')}/.rss${url.search}`);
    if (!response) return null;
    const feed = await response.text();
    const pick = (block: string, tag: string) => decode(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block)?.[1] ?? '');
    const entries = [...feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, 25).map(([, entry]) => {
      const link = /<link[^>]*href="([^"]+)"/.exec(entry)?.[1] ?? '';
      return `### ${pick(entry, 'title')}\n${pick(entry, 'name')} · ${pick(entry, 'updated').slice(0, 10)} · ${decode(link)}\n${htmlToText(pick(entry, 'content')).replace(/\s*submitted by[\s\S]*$/, '').slice(0, 1200)}`;
    });
    return entries.length ? { title: pick(feed.split('<entry>')[0], 'title') || 'Reddit', text: entries.join('\n\n') } : null;
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
