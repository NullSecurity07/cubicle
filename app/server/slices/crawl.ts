import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newMessageId, type Attention } from '../../shared/model.ts';
import { dnsResolve, publicUrl, unwrapRedirect, webUrl, type Resolve } from '../browser.ts';
import type { Deps, Slice } from '../install.ts';
import { attr, clip, createPace, decode, failure, getPublic as getPublicWeb, htmlToText, isoDay, oneLine, when, type Got } from '../readers.ts';
import type { Tool, ToolContext } from '../tools/registry.ts';
import { webCache } from '../cache.ts';
import { UNTRUSTED } from '../tools/web.ts';
import { newId } from '../slice-kit.ts';

// A competitor's whole site read in one go, and a page kept an eye on. Both are plain reads of public pages from this
// machine, the way a person with a browser would make them: robots.txt is obeyed, one site is asked gently, and a
// watched page is only ever read while the app is open.

export const DEPTH = 2;
export const DEPTH_MAX = 3;
export const PAGES = 15;
export const PAGES_MAX = 40;
export const PAGE_MS = 8000;
export const TOTAL_MS = 90_000;
export const IN_FLIGHT = 2;
export const HOST_GAP = 300;
export const MAP_LINE = 160;
export const QUOTE = 600;
export const BEST = 5;
export const OUT_CHARS = 9000;
export const FILE_BYTES = 400_000;
const BODY_BYTES = 3_000_000;
const AGENT = 'cubicle-reader/1.0 (desktop app; reads a public site for its owner, obeys robots.txt)';
// Addresses that are never a page: documents, pictures, archives, media and feeds.
const NOT_A_PAGE = /\.(pdf|png|jpe?g|gif|webp|svg|ico|bmp|tiff?|avif|zip|gz|tgz|bz2|xz|7z|rar|tar|dmg|exe|msi|pkg|deb|rpm|apk|mp3|mp4|m4a|wav|ogg|webm|mov|avi|css|js|mjs|json|xml|rss|atom|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf|otf|eot)$/i;

// ---------------------------------------------------------------- fetching

export type { Got };
const ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5';
// The crawl reads pages only, follows a link-tracker to where it really points, and keeps the body under 3 MB.
export const getPublic = (raw: string, http: typeof fetch, resolveHost: Resolve | undefined, signal: AbortSignal): Promise<Got> =>
  getPublicWeb(raw, { http, resolveHost, signal, agent: AGENT, accept: ACCEPT, htmlOnly: true, unwrap: true, bodyBytes: BODY_BYTES });

// ---------------------------------------------------------------- one page

export type Page = { url: string; title: string; text: string; links: string[] };

// Takes out every element of one kind, nested ones and all: a menu inside a menu closes twice.
export function without(html: string, tag: string): string {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const either = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi');
  let out = '';
  let from = 0;
  for (;;) {
    open.lastIndex = from;
    const start = open.exec(html);
    if (!start) return out + html.slice(from);
    out += `${html.slice(from, start.index)} `;
    either.lastIndex = start.index + start[0].length;
    let depth = 1;
    let found: RegExpExecArray | null;
    while (depth && (found = either.exec(html))) depth += found[0][1] === '/' ? -1 : 1;
    // Never closed: only the opening tag goes, so a sloppy page does not lose everything after it.
    if (depth) return out + html.slice(start.index + start[0].length);
    from = either.lastIndex;
  }
}

// What a reader would keep of a page: its title, and the text of its main part without the menus and footers that
// every page of a site repeats. The same text-from-HTML the app's other readers use.
export function readPage(html: string, url: string): Page {
  const title = oneLine(decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')) || oneLine(htmlToText(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? ''));
  const bare = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ');
  // One article is the page's own words (a docs page keeps its sidebars beside it, inside main); several are a list.
  const articles = bare.match(/<article\b/gi)?.length ?? 0;
  const main = (articles === 1 ? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(bare)?.[1] : undefined) ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(bare)?.[1]
    ?? /<body\b[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(bare)?.[1] ?? bare;
  const text = htmlToText(['nav', 'header', 'footer', 'aside'].reduce(without, main));
  const links: string[] = [];
  for (const [tag] of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(tag, 'href')?.trim();
    if (!href || /^(mailto|tel|javascript|data|sms|ftp):/i.test(href) || href.startsWith('#')) continue;
    try { links.push(unwrapRedirect(new URL(href, url).href)); } catch { /* a broken link leads nowhere */ }
  }
  return { url, title, text, links: [...new Set(links)] };
}

// ---------------------------------------------------------------- robots.txt

// The Disallow lines that speak to every crawler (`User-agent: *`). Allow lines and named crawlers are not ours.
export function robotsRules(body: string): string[] {
  const rules: string[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const found = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!found) continue;
    const [key, value] = [found[1].toLowerCase(), found[2].trim()];
    if (key === 'user-agent') { if (inRules) { agents = []; inRules = false; } agents.push(value); continue; }
    inRules = true;
    if (key === 'disallow' && value && agents.includes('*')) rules.push(value);
  }
  return rules;
}
// `*` stands for anything and a closing `$` for the end, as robots.txt has it.
export const disallowed = (path: string, rules: string[]) => rules.some((rule) => {
  const end = rule.endsWith('$');
  const body = (end ? rule.slice(0, -1) : rule).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${end ? '$' : ''}`).test(path);
});

// ---------------------------------------------------------------- the crawl

export type CrawlOptions = {
  workspace: string;
  http?: typeof fetch; resolveHost?: Resolve; now?: () => number;
  // Where the whole crawl is written, as a path inside the shared files folder.
  save?: (name: string, text: string) => Promise<unknown>;
  gap?: number; pageMs?: number; totalMs?: number;
  // Keep each crawl fifteen minutes under the workspace's cache folder. On in the app, off in fake mode and in tests.
  cache?: boolean;
};
export type CrawlAsk = { url: string; max?: number; depth?: number; match?: string; query?: string };
export type Crawled = { host: string; pages: Page[]; seconds: number; robots: 'read' | 'none' | 'failed'; closed: number; skipped: number; failed: string[]; refused: string | null; truncated: boolean; file: string | null };

// The page as one key: no fragment, no query, no closing slash. `?page=2` of a page already read is the same page.
const keyOf = (href: string) => { const url = new URL(href); return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '') || '/'}`.toLowerCase(); };
const bounded = (value: unknown, fallback: number, most: number) => { const asked = Math.floor(Number(value)); return Number.isFinite(asked) && asked >= 1 ? Math.min(most, asked) : fallback; };

export async function crawlSite(ask: CrawlAsk, options: CrawlOptions, signal?: AbortSignal): Promise<Crawled> {
  const { http = fetch, resolveHost = dnsResolve, now = Date.now } = options;
  const started = now();
  const max = bounded(ask.max, PAGES, PAGES_MAX);
  const depth = ask.depth === 0 ? 0 : bounded(ask.depth, DEPTH, DEPTH_MAX);
  const match = ask.match?.trim() ? `/${ask.match.trim().replace(/^\/+/, '')}` : '';
  const start = webUrl(ask.url.trim());
  let host = new URL(start).host;
  const pace = createPace(options.gap ?? HOST_GAP);
  const whole = AbortSignal.timeout(options.totalMs ?? TOTAL_MS);
  const stop = signal ? AbortSignal.any([signal, whole]) : whole;
  const get = async (url: string) => { await pace(); return getPublic(url, http, resolveHost, AbortSignal.any([stop, AbortSignal.timeout(options.pageMs ?? PAGE_MS)])); };

  // robots.txt once, before any page. A site without one has closed nothing.
  let rules: string[] = [];
  let robots: Crawled['robots'] = 'none';
  try {
    const got = await get(`${new URL(start).origin}/robots.txt`);
    if (got.status < 400 && got.body) { rules = robotsRules(got.body); robots = 'read'; }
  } catch { robots = 'failed'; }

  const pages: Page[] = [];
  const seen = new Set<string>();
  const read = new Set<string>();
  const queue: { url: string; level: number }[] = [{ url: start, level: 0 }];
  seen.add(keyOf(start));
  const failed: string[] = [];
  let closed = 0;
  let skipped = 0;
  let refused: string | null = null;
  let tries = 0;

  const follow = (href: string, level: number) => {
    let url: URL;
    try { url = new URL(href); } catch { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.host.toLowerCase() !== host.toLowerCase()) return;
    if (match && !url.pathname.startsWith(match)) return;
    const key = keyOf(url.href);
    if (seen.has(key)) return;
    seen.add(key);
    if (NOT_A_PAGE.test(url.pathname)) { skipped += 1; return; }
    if (disallowed(url.pathname + url.search, rules)) { closed += 1; return; }
    url.hash = '';
    queue.push({ url: url.href, level });
  };

  async function one(item: { url: string; level: number }) {
    tries += 1;
    let got: Got;
    try { got = await get(item.url); } catch (error) { if (!stop.aborted) failed.push(`${item.url} (${failure(error)})`); return; }
    if (got.status === 429 || got.status === 503) { refused ??= `${got.status}`; return; }
    if (got.status >= 400) { failed.push(`${item.url} (the site answered ${got.status})`); return; }
    if (!/html/i.test(got.type) && got.type) { skipped += 1; return; }
    // The first page may land on another name for the same site (example.com → www.example.com): that is the site.
    if (item.level === 0 && pages.length === 0) host = new URL(got.url).host;
    else if (new URL(got.url).host !== host) { skipped += 1; return; }
    // A link that redirects to a page already read (an old address, a short link) is that page, read once.
    if (read.has(keyOf(got.url))) return;
    if (pages.length >= max) return;
    read.add(keyOf(got.url));
    const page = readPage(got.body, got.url);
    pages.push(page);
    if (item.level < depth) for (const link of page.links) follow(link, item.level + 1);
  }

  if (disallowed(new URL(start).pathname + new URL(start).search, rules)) closed += 1;
  else {
    // Two at a time, breadth first: every page one link away before any page two links away.
    const running = new Set<Promise<void>>();
    while ((queue.length || running.size) && pages.length < max && !refused && !stop.aborted && tries < max * 3) {
      while (queue.length && running.size < IN_FLIGHT && pages.length + running.size < max) {
        const job: Promise<void> = one(queue.shift()!).finally(() => running.delete(job));
        running.add(job);
      }
      if (running.size) await Promise.race(running);
    }
    await Promise.allSettled(running);
  }
  return { host, pages: pages.slice(0, max), seconds: Math.round((now() - started) / 100) / 10, robots, closed, skipped, failed, refused, truncated: stop.aborted && !signal?.aborted, file: null };
}

// ---------------------------------------------------------------- what the person reads

const STOP = new Set('the and for with that this from what how does are you your our can who why when which about into have has was were will not but all any its their there them they than then also more most some such only just into over under very what where'.split(' '));
export const words = (query: string) => [...new Set(query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? [])].filter((one) => !STOP.has(one));

// How well a page answers the founder's question: how often its words turn up, in the title most of all.
export function score(page: Page, terms: string[]): number {
  const body = page.text.toLowerCase();
  const title = page.title.toLowerCase();
  return terms.reduce((sum, term) => sum + Math.min(10, body.split(term).length - 1) + (title.includes(term) ? 5 : 0), 0);
}
// The part of a page where the question's words first gather.
export function quote(page: Page, terms: string[], size = QUOTE): string {
  const text = oneLine(page.text);
  const lower = text.toLowerCase();
  const at = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const from = Math.max(0, at - 150);
  return `${from ? '…' : ''}${clip(text.slice(from), size)}`;
}

export function showCrawl(crawl: Crawled, ask: CrawlAsk, now: number): string {
  const head = [
    `Site: ${crawl.host}, read ${when(now, now)}. ${crawl.pages.length} page${crawl.pages.length === 1 ? '' : 's'} read in ${crawl.seconds} s${ask.match ? `, only under ${ask.match}` : ''}.`,
    crawl.robots === 'read' ? `robots.txt was read once${crawl.closed ? `; it closes ${crawl.closed} of the links found, and those were not opened` : ' and closes nothing that was found'}.` : crawl.robots === 'none' ? 'The site has no robots.txt.' : 'robots.txt could not be read, so only the pages it could not have closed were read.',
    ...(crawl.skipped ? [`${crawl.skipped} links were not pages (files, pictures, another site) and were skipped.`] : []),
    ...(crawl.refused ? [`The site refused after ${crawl.pages.length} pages (${crawl.refused}); here is what was read.`] : []),
    ...(crawl.truncated ? [`The crawl stopped at ${TOTAL_MS / 1000} seconds; here is what was read.`] : []),
    ...(crawl.failed.length ? [`${crawl.failed.length} could not be read: ${crawl.failed.slice(0, 3).join('; ')}${crawl.failed.length > 3 ? '; …' : ''}.`] : []),
  ];
  const map = crawl.pages.map((page, index) => `${index + 1}. ${clip(page.title || '(no title)', 90)} — ${page.url}\n   ${clip(oneLine(page.text), MAP_LINE) || '(no readable text)'}`);
  const terms = words(ask.query ?? '');
  const best = terms.length ? crawl.pages.map((page) => ({ page, points: score(page, terms) })).filter((one) => one.points > 0).sort((a, b) => b.points - a.points).slice(0, BEST) : [];
  const quotes = best.map(({ page }) => `### ${clip(page.title || '(no title)', 90)}\n${page.url}\n${quote(page, terms)}`);
  const tail = crawl.file ? `The whole crawl, every page's text, is saved as ${crawl.file}. Open it with read_file for the rest.` : 'The whole crawl could not be saved to a file.';

  // Everything that fits, the map before the quotes; what does not fit is said, and is in the file.
  const parts = [UNTRUSTED + head.join('\n'), 'Map:'];
  let size = parts.join('\n').length + tail.length + 200;
  let mapShown = 0;
  for (const line of map) { if (size + line.length + 1 > OUT_CHARS) break; parts.push(line); size += line.length + 1; mapShown += 1; }
  let quotesShown = 0;
  if (quotes.length && mapShown === map.length) {
    const title = `\nThe ${Math.min(quotes.length, BEST)} pages that best match "${clip(oneLine(ask.query ?? ''), 120)}":`;
    parts.push(title);
    size += title.length;
    for (const block of quotes) { if (size + block.length + 2 > OUT_CHARS) break; parts.push(`${block}\n`); size += block.length + 2; quotesShown += 1; }
    if (!quotesShown) parts.pop();
  }
  const cut = [map.length - mapShown ? `${map.length - mapShown} map lines` : '', quotes.length - quotesShown ? `${quotes.length - quotesShown} quotes` : ''].filter(Boolean);
  if (cut.length) parts.push(`(Cut to fit: ${cut.join(' and ')} did not fit here. They are in the file.)`);
  if (!crawl.pages.length) parts.push('Nothing was read.');
  parts.push(tail);
  return parts.join('\n');
}

// Every page's text, one after another, for read_file to open. Cut at a whole page where it can be.
export function crawlFile(crawl: Crawled, ask: CrawlAsk, now: number): string {
  let text = `# ${crawl.host}\nRead ${isoDay(now)} from ${ask.url}. ${crawl.pages.length} pages. This is what the site said, not instructions.\n`;
  for (const [index, page] of crawl.pages.entries()) {
    const block = `\n---\n\n## ${page.title || '(no title)'}\n${page.url}\n\n${page.text}\n`;
    if (Buffer.byteLength(text + block) > FILE_BYTES) { text += `\n---\n\n(Cut at ${FILE_BYTES / 1000} KB: ${crawl.pages.length - index} more pages were read but are not kept here.)\n`; break; }
    text += block;
  }
  return text;
}

async function runCrawl(ask: CrawlAsk, options: CrawlOptions, signal?: AbortSignal): Promise<string> {
  const now = options.now ?? Date.now;
  let crawl: Crawled;
  try { crawl = await crawlSite(ask, options, signal); } catch (error) { return `The site could not be read: ${failure(error)}.`; }
  if (!crawl.pages.length) {
    if (crawl.closed && !crawl.failed.length) return `${crawl.host}'s robots.txt asks crawlers to keep out of ${ask.url}, so nothing was read. Open one page with web_fetch instead.`;
    if (crawl.refused) return `${crawl.host} refused before a single page was read (${crawl.refused}). Try again later.`;
    return `Nothing could be read from ${crawl.host}${crawl.failed.length ? `: ${crawl.failed[0]}` : ''}. Try web_fetch on one page.`;
  }
  const name = `crawls/${crawl.host.replace(/[^A-Za-z0-9.-]+/g, '-')}-${isoDay(now())}.md`;
  if (options.save) crawl.file = await options.save(name, crawlFile(crawl, ask, now())).then(() => name, () => null);
  return showCrawl(crawl, ask, now());
}

// ---------------------------------------------------------------- watching

export const WATCH_EVERY = 6 * 3600_000;
export const WATCH_TEXT = 20_000;
export const WATCHES_ROOM = 10;
export const WATCHES_ALL = 40;
export const FAILS_TOLD = 3;
const SHOWN_FOR = 14 * 86_400_000;
export type Watch = {
  id: string; url: string; what: string; roomId: string; title: string; hash: string; text: string;
  addedAt: number; checkedAt: number; readAt?: number; changedAt?: number; diff?: string; fails?: number; lastFail?: string;
};

// The text as it is compared: spacing does not count, and neither do the numbers that change on every visit (a date,
// a counter, a "3 minutes ago"). A price that changes is caught by the lines around it only when they change too.
export const flat = (text: string) => text.split('\n').map((line) => oneLine(line)).filter(Boolean);
export const hashOf = (text: string) => createHash('sha1').update(flat(text).join('\n').replace(/\d+/g, '#')).digest('hex');

// What changed, as the first few lines that were added or taken out, numbers counted as the same.
export function diffOf(before: string, after: string, most = 3): string {
  const numb = (line: string) => line.replace(/\d+/g, '#');
  const old = flat(before);
  const now = flat(after);
  const had = new Set(old.map(numb));
  const has = new Set(now.map(numb));
  const lines = [...now.filter((line) => !had.has(numb(line))).map((line) => `+ ${clip(line, 200)}`), ...old.filter((line) => !has.has(numb(line))).map((line) => `− ${clip(line, 200)}`)];
  return lines.length ? `${lines.slice(0, most).join('\n')}${lines.length > most ? `\n(and ${lines.length - most} more changed lines)` : ''}` : 'The words moved around, but no line was added or taken out.';
}
const sameUrl = (one: string, other: string) => { try { return keyOf(webUrl(one)) === keyOf(webUrl(other)) && new URL(webUrl(one)).search === new URL(webUrl(other)).search; } catch { return one.trim() === other.trim(); } };

export function createWatches(dir: string) {
  const keyOf = (roomId: string) => roomId.replace(/[^\w-]/g, '_');
  const fileOf = (key: string) => join(dir, `${key}.json`);
  // Every watch, read from disk once and then kept here: the half-minute tick and the "needs you" list both ask for
  // all of them, and only this ever writes them. Callers are handed copies, so nothing changes the table but `change`.
  let table: Promise<Map<string, Watch[]>> | null = null;
  const load = () => (table ??= (async () => {
    const files = (await readdir(dir).catch(() => [] as string[])).filter((one) => one.endsWith('.json'));
    const read = await Promise.all(files.map(async (one) => [one.slice(0, -5), await readFile(join(dir, one), 'utf8').then((body) => JSON.parse(body) as Watch[], () => [])] as const));
    return new Map(read);
  })());
  const copy = (list: Watch[]) => list.map((one) => ({ ...one }));
  const read = async (roomId: string): Promise<Watch[]> => copy((await load()).get(keyOf(roomId)) ?? []);
  const write = async (key: string, list: Watch[]) => { await mkdir(dir, { recursive: true }); await writeFile(`${fileOf(key)}.tmp`, JSON.stringify(list, null, 2)); await rename(`${fileOf(key)}.tmp`, fileOf(key)); };
  let queue: Promise<unknown> = Promise.resolve();
  // One change at a time, so a tick and a tool never write over each other. The table changes only once the file has.
  const change = <T>(roomId: string, edit: (list: Watch[]) => T | Promise<T>): Promise<T> => {
    const job = queue.then(async () => {
      const key = keyOf(roomId);
      const list = await read(roomId);
      const out = await edit(list);
      await write(key, list);
      (await load()).set(key, copy(list));
      return out;
    });
    queue = job.catch(() => {});
    return job;
  };
  const all = async (): Promise<Watch[]> => [...(await load()).values()].flatMap(copy);
  return { read, all, change, settled: () => queue };
}
export type Watches = ReturnType<typeof createWatches>;

async function readWatched(url: string, options: CrawlOptions, signal?: AbortSignal): Promise<{ title: string; text: string; url: string }> {
  const got = await getPublic(url, options.http ?? fetch, options.resolveHost ?? dnsResolve, signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000));
  if (got.status >= 400) throw new Error(`the site answered ${got.status}`);
  if (!/html|text\/plain/i.test(got.type) && got.type) throw new Error(`it is not a page (${got.type.split(';')[0]})`);
  const page = /html/i.test(got.type) || !got.type ? readPage(got.body, got.url) : { title: '', text: got.body, url: got.url, links: [] };
  if (page.text.length < 50) throw new Error('it came back almost empty');
  return { title: page.title || new URL(got.url).host, text: page.text, url: got.url };
}

export type WatchDeps = Pick<Deps, 'store' | 'attention' | 'notify' | 'busy'> & { fake: boolean };

// One check: the watch that has waited longest, if it has waited six hours. A change is said in the room it was asked
// from, in Needs you and on the desktop; three failures in a row are said once, and the checks go on.
export async function checkOne(watches: Watches, deps: WatchDeps, options: CrawlOptions): Promise<Watch | null> {
  if (deps.fake) return null;
  const now = (options.now ?? Date.now)();
  const due = (await watches.all()).filter((one) => now - (one.checkedAt || 0) >= WATCH_EVERY && !deps.busy.has(one.roomId)).sort((a, b) => a.checkedAt - b.checkedAt)[0];
  if (!due) return null;
  let read: Awaited<ReturnType<typeof readWatched>> | null = null;
  let problem = '';
  try { read = await readWatched(due.url, options); } catch (error) { problem = failure(error); }
  const said: string[] = [];
  const updated = await watches.change(due.roomId, (list) => {
    const watch = list.find((one) => one.id === due.id);
    if (!watch) return null;
    watch.checkedAt = now;
    if (!read) {
      watch.fails = (watch.fails ?? 0) + 1;
      watch.lastFail = problem;
      if (watch.fails === FAILS_TOLD) said.push(`The page ${watch.title} (${watch.url}) could not be read ${FAILS_TOLD} times in a row: ${problem}. I will keep trying every 6 hours.`);
      return { ...watch };
    }
    const hash = hashOf(read.text);
    watch.fails = 0;
    if (hash !== watch.hash) {
      const since = watch.readAt ?? watch.addedAt;
      watch.diff = diffOf(watch.text, read.text);
      watch.changedAt = now;
      said.push(`The page ${read.title} changed since ${isoDay(since)}: ${watch.url}\n${watch.diff}${watch.what ? `\n(You asked to watch it for: ${watch.what}.)` : ''}`);
      watch.title = read.title;
    }
    watch.hash = hash;
    watch.text = read.text.slice(0, WATCH_TEXT);
    watch.readAt = now;
    return { ...watch };
  });
  if (updated && said.length) {
    await deps.store.appendChat(updated.roomId, { id: newMessageId(), role: 'assistant', text: said[0], at: now, provider: 'Page watch', model: new URL(updated.url).host });
    if (updated.changedAt === now) {
      await deps.attention.refresh();
      deps.notify(`${updated.title} changed`, said[0].split('\n')[1] ?? updated.url);
    }
  }
  return updated;
}

// A change waits in Needs you for two weeks, or until the founder dismisses it.
export const watchAttention = (watches: Watches, deps: Pick<Deps, 'store'>, now: () => number = Date.now) => async (): Promise<Attention[]> => {
  const changed = (await watches.all()).filter((one) => one.changedAt && now() - one.changedAt < SHOWN_FOR);
  if (!changed.length) return [];
  const stage = await deps.store.loadStage();
  return changed.map((one) => ({
    id: `page-changed:${one.id}:${one.changedAt}`, kind: 'page-changed' as const, title: `The page ${one.title} changed`, at: one.changedAt!,
    detail: `${one.url}\n${one.diff ?? ''}`.trim(), roomId: one.roomId, who: stage.rooms.find((room) => room.id === one.roomId)?.name,
  }));
};

// ---------------------------------------------------------------- the tools

export function crawlTools(options: CrawlOptions, watches: Watches): Tool[] {
  const str = (args: Record<string, unknown>, key: string) => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
  const now = options.now ?? Date.now;
  const cache = webCache(options.cache ? options.workspace : null, now);
  return [
    {
      name: 'crawl_site',
      perTurn: 1,
      description: 'Read a whole website at once, following its links on the same site: a competitor\'s product, pricing, docs, changelog and careers pages in one call. '
        + `Gives a map of the pages (title, address, first line) and, for the founder's question, the ${BEST} pages that answer it best, quoted. `
        + `Reads ${PAGES} pages two links deep unless you say ("max" up to ${PAGES_MAX}, "depth" up to ${DEPTH_MAX}); "match" keeps it to one part of the site, like "/docs". `
        + 'Obeys the site\'s robots.txt. The full text of every page is saved as a file to open with read_file. For one page, use web_fetch.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Where to start, usually the home page' },
          max: { type: 'number', description: `How many pages, ${PAGES} unless you say, at most ${PAGES_MAX}` },
          depth: { type: 'number', description: `How many links away from the start, ${DEPTH} unless you say, at most ${DEPTH_MAX}` },
          match: { type: 'string', description: 'Only follow addresses whose path starts with this, like /docs or /blog' },
        },
        required: ['url'],
      },
      async run(args, context: ToolContext) {
        if (!str(args, 'url')) return { text: 'Give the site\'s address in "url".' };
        const ask: CrawlAsk = { url: str(args, 'url'), max: Number(args.max) || undefined, depth: args.depth === undefined ? undefined : Number(args.depth), match: str(args, 'match'), query: context.query };
        // The same site, the same way, for the same question, within fifteen minutes: crawled once. The saved file is still there.
        return { text: await cache.one(['crawl', ask.url, ask.max ?? null, ask.depth ?? null, ask.match ?? '', ask.query ?? ''], () => runCrawl(ask, options, context.signal)) };
      },
    },
    {
      name: 'watch_page',
      perTurn: 2,
      description: 'Keep an eye on one page, such as a competitor\'s pricing, changelog or careers page, and hear when it changes. '
        + 'It is read now, then once every 6 hours; a change comes to this conversation and to the founder\'s Needs you with the lines that changed. '
        + `Checks only while app open. Asks the founder first. At most ${WATCHES_ROOM} pages per person.`,
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'The page to watch' }, what: { type: 'string', description: 'What to look out for on it, in a few words' } }, required: ['url'] },
      approval: async (args) => `Watch ${str(args, 'url')} for changes? It is read once every 6 hours while the app is open.`,
      async run(args, context) {
        let url: string;
        try { url = await publicUrl(str(args, 'url'), options.resolveHost ?? dnsResolve); } catch (error) { return { text: `That page cannot be watched: ${(error as Error).message}.` }; }
        const mine = await watches.read(context.roomId);
        const there = mine.find((one) => sameUrl(one.url, url));
        if (there) return { text: `${there.url} is already watched, since ${isoDay(there.addedAt)}.` };
        if (mine.length >= WATCHES_ROOM) return { text: `You already watch ${WATCHES_ROOM} pages, the most one person may. Stop one with stop_watching first.` };
        if ((await watches.all()).length >= WATCHES_ALL) return { text: `The app already watches ${WATCHES_ALL} pages, the most it keeps. Ask the founder which to stop.` };
        let page: Awaited<ReturnType<typeof readWatched>>;
        try { page = await readWatched(url, options, context.signal); } catch (error) { return { text: `The page could not be read, so it is not watched: ${failure(error)}.` }; }
        const at = now();
        const watch: Watch = { id: newId('w', 4, '', at), url, what: str(args, 'what').slice(0, 200), roomId: context.roomId, title: page.title, hash: hashOf(page.text), text: page.text.slice(0, WATCH_TEXT), addedAt: at, checkedAt: at, readAt: at };
        const added = await watches.change(context.roomId, (list) => {
          if (list.some((one) => sameUrl(one.url, url))) return false;
          list.push(watch);
          return true;
        });
        if (!added) return { text: `${url} is already watched.` };
        return { text: `Watching ${page.title} (${url}). It was read just now and will be read again every 6 hours while the app is open. A change comes to this conversation and to Needs you.` };
      },
    },
    {
      name: 'list_watches',
      perTurn: 2,
      description: 'List the pages you watch for changes: each address, when it was last read and when it last changed.',
      parameters: { type: 'object', properties: {} },
      async run(_args, context) {
        const mine = await watches.read(context.roomId);
        if (!mine.length) return { text: 'You watch no pages. Start with watch_page.' };
        const at = now();
        return { text: `You watch ${mine.length} page${mine.length === 1 ? '' : 's'}:\n${mine.map((one) => `- ${one.title} — ${one.url}${one.what ? ` (for: ${one.what})` : ''}\n  Last read ${one.readAt ? when(one.readAt, at) : 'never'}; ${one.changedAt ? `last changed ${when(one.changedAt, at)}` : 'no change seen yet'}${one.fails ? `; the last ${one.fails} reads failed (${one.lastFail})` : ''}.`).join('\n')}` };
      },
    },
    {
      name: 'stop_watching',
      perTurn: 2,
      description: 'Stop watching a page for changes. Give its address as list_watches shows it.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'The watched page' } }, required: ['url'] },
      async run(args, context) {
        const url = str(args, 'url');
        const gone = await watches.change(context.roomId, (list) => {
          const at = list.findIndex((one) => sameUrl(one.url, url));
          return at < 0 ? null : list.splice(at, 1)[0];
        });
        return { text: gone ? `Stopped watching ${gone.url}.` : `${url} is not watched. list_watches shows what is.` };
      },
    },
  ];
}

// ---------------------------------------------------------------- stand-in

// Fake mode never reaches the network: every address answers with the same small site of three pages.
export const fakeSite: typeof fetch = async (input) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
  const pages: Record<string, [string, string]> = {
    '/': ['Example — home', 'Example plans your week. <a href="/pricing">Pricing</a> <a href="/about">About</a>'],
    '/pricing': ['Pricing — Example', 'Free for one person. Team costs 12 a month per seat. <a href="/">Home</a>'],
    '/about': ['About — Example', 'A small team in Lisbon building calm planning software. <a href="/">Home</a>'],
  };
  const [title, body] = pages[url.pathname.replace(/\/+$/, '') || '/'] ?? ['Not found', 'No such page.'];
  return new Response(`<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p><p>${'This page is a stand-in used while the app runs without models. '.repeat(3)}</p></main></body></html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
};

export default {
  name: 'crawl',
  install(deps: Deps) {
    const watches = createWatches(join(deps.workspace, 'watch'));
    const options: CrawlOptions = {
      workspace: deps.workspace,
      cache: !deps.fake,
      ...(deps.fake ? { http: fakeSite, resolveHost: async () => [] } : {}),
      save: (name, text) => deps.store.writeFile(name, text),
    };
    // The attention book has no way to take a source off again (attention.ts), so a closed crawl reports nothing.
    let closed = false;
    const report = watchAttention(watches, deps);
    deps.attention.source(async () => (closed ? [] : report()));
    return {
      async close() { closed = true; },
      tools: crawlTools(options, watches),
      // Every half minute, at most one page read. Never in fake mode, and never while the app is closed.
      async tick() { await checkOne(watches, deps, options); },
      async route(req, res, path) {
        const found = /^\/api\/watch\/([\w-]{1,80})(\/stop)?$/.exec(path);
        if (!found) return false;
        const [, roomId, stop] = found;
        if (!stop && req.method === 'GET') {
          deps.json(res, 200, (await watches.read(roomId)).map(({ id, url, title, what, readAt, changedAt, fails }) => ({ id, url, title, what, readAt, changedAt, fails })));
          return true;
        }
        if (stop && req.method === 'POST') {
          const id = String((await deps.body(req))?.id ?? '');
          await watches.change(roomId, (list) => { const at = list.findIndex((one) => one.id === id); if (at >= 0) list.splice(at, 1); });
          deps.json(res, 200, { ok: true });
          return true;
        }
        return false;
      },
    };
  },
} satisfies Slice;
