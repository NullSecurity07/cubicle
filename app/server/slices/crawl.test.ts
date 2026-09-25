import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage } from '../../shared/model.ts';
import { createAttention } from '../attention.ts';
import { createStore } from '../store.ts';
import type { Store } from '../store.ts';
import type { ToolContext } from '../tools/registry.ts';
import { UNTRUSTED } from '../tools/web.ts';
import {
  checkOne, crawlFile, startWatch, crawlSite, crawlTools, createWatches, diffOf, disallowed, fakeSite, hashOf, OUT_CHARS, readPage, without, robotsRules, showCrawl,
  WATCH_EVERY, WATCHES_ROOM, watchAttention, type CrawlOptions, type Crawled,
} from './crawl.ts';

const FIXTURES = join(import.meta.dirname, 'crawl.fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
// Thursday 24 September 2026, noon UTC.
const NOW = Date.UTC(2026, 8, 24, 12);
const html = (body: string) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const small = (title: string, words: string) => html(`<html><head><title>${title}</title></head><body><main><p>${words}</p></main></body></html>`);

// A fetch that answers from a table of paths on one site and writes down every address asked.
function site(table: Record<string, () => Response>, host = 'https://acme.test') {
  const asked: string[] = [];
  const http = (async (url: string) => {
    asked.push(String(url));
    const { pathname, search } = new URL(String(url));
    const answer = table[pathname + search] ?? table[pathname];
    return answer ? answer() : new Response('not here', { status: 404, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  return { http, asked, host };
}
const acme = () => site({
  '/robots.txt': () => new Response(fixture('robots.txt'), { status: 200, headers: { 'content-type': 'text/plain' } }),
  '/': html(fixture('home.html')),
  '/pricing': html(fixture('pricing.html')),
  '/docs/': html(fixture('docs.html')),
  '/careers': small('Careers — Acme', 'We are hiring a designer and two engineers in Lisbon.'),
  '/changelog': small('Changelog — Acme', 'September: shared weeks. August: calendar sync for Outlook.'),
  '/old-pricing': () => new Response(null, { status: 301, headers: { location: '/pricing' } }),
  '/pricing/enterprise': small('Enterprise — Acme', 'Single sign-on, audit log, a named person to call.'),
  '/docs/api': small('API — Acme', 'A REST API with one key per team.'),
  '/docs/start': small('Start — Acme', 'Five minutes from sign-up to a planned week.'),
});
const options = (http: typeof fetch, extra: Partial<CrawlOptions> = {}): CrawlOptions => ({ workspace: tmpdir(), http, resolveHost: async () => ['93.184.216.34'], now: () => NOW, gap: 0, ...extra });

describe('robots.txt', () => {
  it('keeps only the lines written for every crawler', () => {
    expect(robotsRules(fixture('robots.txt'))).toEqual(['/private/', '/*.json$']);
    expect(robotsRules('User-agent: *\nDisallow:\n')).toEqual([]);
  });
  it('reads * as anything and $ as the end', () => {
    const rules = ['/private/', '/*.json$'];
    expect(disallowed('/private/admin', rules)).toBe(true);
    expect(disallowed('/api/data.json', rules)).toBe(true);
    expect(disallowed('/api/data.json?x=1', rules)).toBe(false);
    expect(disallowed('/pricing', rules)).toBe(false);
  });
});

describe('one page', () => {
  it('keeps the main text and every link worth following, without menus, scripts or footers', () => {
    const page = readPage(fixture('home.html'), 'https://acme.test/');
    expect(page.title).toBe('Acme — plan your week');
    expect(page.text).toContain('lays out a calm week');
    expect(page.text).not.toMatch(/tracking|Every page says this|Careers/);
    expect(page.links).toContain('https://acme.test/pricing#plans');
    expect(page.links.some((link) => /^(mailto|tel|javascript):/.test(link))).toBe(false);
    expect(page.links).not.toContain('https://acme.test/#top');
  });
  it('takes out a menu inside a menu, and reads the one article inside main', () => {
    const page = readPage('<main><nav>Guides <nav>Install</nav> Concepts</nav><article><h1>Installing</h1><p>Run the installer.</p></article><aside>On this page</aside></main>', 'https://docs.test/');
    expect(page.text).toBe('Installing\nRun the installer.');
    expect(without('<p>a</p><header>top<p>b</p>', 'header')).toBe('<p>a</p> top<p>b</p>');
  });
});

describe('crawl_site', () => {
  it('reads the site breadth first, asks robots.txt once, and skips what is closed, not a page, elsewhere or seen', async () => {
    const { http, asked } = acme();
    const crawl = await crawlSite({ url: 'https://acme.test/', max: 15, depth: 2 }, options(http));
    const urls = crawl.pages.map((page) => new URL(page.url).pathname);
    expect(urls[0]).toBe('/');
    expect(new Set(urls)).toEqual(new Set(['/', '/pricing', '/docs/', '/careers', '/changelog', '/pricing/enterprise', '/docs/api', '/docs/start']));
    expect(asked.filter((url) => url.endsWith('/robots.txt'))).toHaveLength(1);
    expect(asked.some((url) => /private|\.pdf|\.png|twitter|#/.test(url))).toBe(false);
    // `/pricing?ref=home` is the pricing page again; `/old-pricing` redirects to it and is not counted twice.
    expect(asked.filter((url) => url.includes('/pricing?'))).toHaveLength(0);
    expect(urls.filter((path) => path === '/pricing')).toHaveLength(1);
    expect(crawl.robots).toBe('read');
    expect(crawl.closed).toBe(1);
    expect(crawl.skipped).toBeGreaterThanOrEqual(2);
  });

  it('keeps to the depth, the page count and the path it was given', async () => {
    const one = await crawlSite({ url: 'https://acme.test/', depth: 1 }, options(acme().http));
    expect(one.pages.map((page) => new URL(page.url).pathname)).not.toContain('/docs/api');
    const three = await crawlSite({ url: 'https://acme.test/', max: 3 }, options(acme().http));
    expect(three.pages).toHaveLength(3);
    const docs = await crawlSite({ url: 'https://acme.test/docs/', match: 'docs' }, options(acme().http));
    expect(docs.pages.every((page) => new URL(page.url).pathname.startsWith('/docs'))).toBe(true);
    expect(docs.pages).toHaveLength(3);
  });

  it('never goes more than two at a time', async () => {
    let open = 0;
    let most = 0;
    const { http: base } = acme();
    const http = (async (url: string) => { open += 1; most = Math.max(most, open); await new Promise((done) => { setTimeout(done, 5); }); open -= 1; return base(url); }) as typeof fetch;
    await crawlSite({ url: 'https://acme.test/' }, options(http));
    expect(most).toBe(2);
  });

  it('stops when the site refuses and says what was read', async () => {
    let served = 0;
    const { http: base } = acme();
    const http = (async (url: string) => (String(url).endsWith('robots.txt') || (served += 1) <= 3 ? base(url) : new Response('slow down', { status: 429 }))) as typeof fetch;
    const [tool] = crawlTools(options(http, { save: async () => {} }), createWatches(await mkdtemp(join(tmpdir(), 'crawl-'))));
    const { text } = await tool.run({ url: 'https://acme.test/' }, { stage: seedStage, roomId: 'marketing', store: {} as Store, granted: new Map() });
    expect(text).toContain('The site refused after 3 pages (429); here is what was read.');
  });

  it('answers the founder\'s question with the best pages, dated, marked as the web, and saves the whole crawl', async () => {
    const saved: Record<string, string> = {};
    const [tool] = crawlTools(options(acme().http, { save: async (name, text) => { saved[name] = text; } }), createWatches(await mkdtemp(join(tmpdir(), 'crawl-'))));
    const context: ToolContext = { stage: seedStage, roomId: 'marketing', store: {} as Store, granted: new Map(), query: 'How much does Acme cost per seat, and is there an enterprise plan?' };
    const { text } = await tool.run({ url: 'acme.test' }, context);
    expect(text.startsWith(UNTRUSTED)).toBe(true);
    expect(text).toContain('Site: acme.test, read 2026-09-24 (today). 8 pages read');
    expect(text).toContain('robots.txt was read once; it closes 1 of the links found');
    expect(text).toMatch(/1\. Acme — plan your week — https:\/\/acme\.test\/\n {3}Acme plans your week/);
    const best = text.split('best match')[1];
    expect(best.indexOf('Pricing — Acme')).toBeGreaterThan(-1);
    expect(best).toContain('12 dollars a month per seat');
    expect(text).toContain('saved as crawls/acme.test-2026-09-24.md');
    expect(saved['crawls/acme.test-2026-09-24.md']).toContain('## Docs — Acme\nhttps://acme.test/docs/\n\nGetting started');
  });

  it('keeps what it says under the cap and says what was cut', () => {
    const pages = Array.from({ length: 40 }, (_, index) => ({ url: `https://big.test/p${index}`, title: `Page ${index} ${'long title '.repeat(6)}`, text: 'word '.repeat(400), links: [] }));
    const crawl: Crawled = { host: 'big.test', pages, seconds: 3, robots: 'none', closed: 0, skipped: 0, failed: [], refused: null, truncated: false, file: 'crawls/big.test-2026-09-24.md' };
    const text = showCrawl(crawl, { url: 'https://big.test/', query: 'word' }, NOW);
    expect(text.length).toBeLessThanOrEqual(OUT_CHARS);
    expect(text).toMatch(/Cut to fit: \d+ map lines and 5 quotes did not fit here/);
    expect(crawlFile({ ...crawl, pages: pages.map((page) => ({ ...page, text: 'x'.repeat(50_000) })) }, { url: 'https://big.test/' }, NOW)).toMatch(/Cut at 400 KB: \d+ more pages/);
  });

  it('says so when robots.txt closes the start, and refuses this machine', async () => {
    const closed = site({ '/robots.txt': () => new Response('User-agent: *\nDisallow: /', { status: 200, headers: { 'content-type': 'text/plain' } }) });
    const [tool] = crawlTools(options(closed.http), createWatches(await mkdtemp(join(tmpdir(), 'crawl-'))));
    const context: ToolContext = { stage: seedStage, roomId: 'marketing', store: {} as Store, granted: new Map() };
    expect((await tool.run({ url: 'https://acme.test/' }, context)).text).toContain("robots.txt asks crawlers to keep out");
    expect(closed.asked).toHaveLength(1);
    expect((await tool.run({ url: 'http://localhost:7420/' }, context)).text).toMatch(/^The site could not be read: addresses on this machine/);
  });
});

describe('watching a page', () => {
  it('counts a change in words, not in numbers or spacing', () => {
    expect(hashOf('Team: 12 a month\n\n  per seat')).toBe(hashOf('Team: 15 a month\nper   seat'));
    expect(hashOf('Team: 12 a month')).not.toBe(hashOf('Team: 12 a year'));
    expect(diffOf('Free\nTeam: 12 a month\nContact us', 'Free\nTeam: 14 a year\nContact us\nNew: Enterprise')).toBe('+ Team: 14 a year\n+ New: Enterprise\n− Team: 12 a month');
  });

  async function setup(http: typeof fetch, fake = false) {
    const workspace = await mkdtemp(join(tmpdir(), 'watch-'));
    const store = createStore(workspace);
    const attention = createAttention(workspace, () => clock.now);
    const watches = createWatches(join(workspace, 'watch'));
    const clock = { now: NOW };
    const told: string[] = [];
    const opts = options(http, { now: () => clock.now });
    attention.source(watchAttention(watches, { store }, () => clock.now));
    const deps = { store, attention, notify: (title: string) => { told.push(title); }, busy: new Set<string>(), fake };
    const tools = crawlTools(opts, watches);
    const tool = (name: string) => tools.find((one) => one.name === name)!;
    const context = async (): Promise<ToolContext> => ({ stage: await store.loadStage(), roomId: 'marketing', store, granted: new Map() });
    return { workspace, store, attention, watches, clock, told, deps, opts, tool, context };
  }

  it('asks first, reads once, and tells the room and Needs you when the page changes', async () => {
    let body = fixture('pricing.html');
    const { http } = site({ '/pricing': () => html(body)() });
    const { workspace, store, attention, watches, clock, told, deps, opts, tool, context } = await setup(http);
    const watch = tool('watch_page');
    expect(await (watch.approval as (args: Record<string, unknown>, context: ToolContext) => Promise<string>)({ url: 'https://acme.test/pricing' }, await context()))
      .toBe('Watch https://acme.test/pricing for changes? It is read once every 6 hours while the app is open.');
    expect(watch.description).toContain('Checks only while app open.');
    expect((await watch.run({ url: 'https://acme.test/pricing', what: 'price changes' }, await context())).text).toMatch(/^Watching Pricing — Acme/);
    expect((await watch.run({ url: 'https://acme.test/pricing/' }, await context())).text).toMatch(/already watched/);
    const [saved] = await watches.read('marketing');
    expect(saved).toMatchObject({ url: 'https://acme.test/pricing', what: 'price changes', roomId: 'marketing', title: 'Pricing — Acme', addedAt: NOW, checkedAt: NOW });
    expect(JSON.parse(await readFile(join(workspace, 'watch', 'marketing.json'), 'utf8'))).toHaveLength(1);

    // Not yet six hours: nothing is read.
    clock.now = NOW + WATCH_EVERY - 1;
    expect(await checkOne(watches, deps, opts)).toBeNull();
    // Six hours on, and only a number changed: read, but no change.
    clock.now = NOW + WATCH_EVERY;
    body = body.replace('12 dollars', '13 dollars');
    expect((await checkOne(watches, deps, opts))?.changedAt).toBeUndefined();
    // Six more hours, and the words changed.
    clock.now = NOW + 2 * WATCH_EVERY;
    body = body.replace('billed yearly', 'billed monthly. A new Starter plan is free for two');
    const changed = await checkOne(watches, deps, opts);
    expect(changed?.changedAt).toBe(clock.now);
    const chat = await store.readChat('marketing');
    expect(chat.at(-1)).toMatchObject({ role: 'assistant', provider: 'Page watch', model: 'acme.test' });
    expect(chat.at(-1)!.text).toMatch(/^The page Pricing — Acme changed since 2026-09-24: https:\/\/acme\.test\/pricing\n\+ .*billed monthly/);
    expect(chat.at(-1)!.text).toContain('(You asked to watch it for: price changes.)');
    const needs = (await attention.list()).find((one) => one.kind === 'page-changed')!;
    expect(needs).toMatchObject({ title: 'The page Pricing — Acme changed', roomId: 'marketing' });
    expect(needs.detail).toContain('billed monthly');
    expect(told).toEqual(['Pricing — Acme changed']);
    // The founder can wave it away.
    await attention.dismiss(needs.id);
    expect((await attention.list()).some((one) => one.kind === 'page-changed')).toBe(false);
  });

  it('says three failures in a row once, and keeps trying', async () => {
    let up = true;
    const { http } = site({ '/pricing': () => (up ? html(fixture('pricing.html'))() : new Response('down', { status: 500, headers: { 'content-type': 'text/html' } })) });
    const { store, watches, clock, deps, opts, tool, context } = await setup(http);
    await tool('watch_page').run({ url: 'https://acme.test/pricing' }, await context());
    up = false;
    for (let turn = 1; turn <= 4; turn += 1) { clock.now = NOW + turn * WATCH_EVERY; await checkOne(watches, deps, opts); }
    const said = (await store.readChat('marketing')).map((message) => message.text);
    expect(said).toEqual(['The page Pricing — Acme (https://acme.test/pricing) could not be read 3 times in a row: the site answered 500. I will keep trying every 6 hours.']);
    expect((await watches.read('marketing'))[0].fails).toBe(4);
    up = true;
    clock.now = NOW + 5 * WATCH_EVERY;
    expect((await checkOne(watches, deps, opts))?.fails).toBe(0);
  });

  it('keeps every change, and a watch the founder started from a card is said in Needs you only', async () => {
    let body = fixture('pricing.html');
    const { http } = site({ '/pricing': () => html(body)() });
    const { store, attention, watches, clock, deps, opts } = await setup(http);
    expect((await startWatch(watches, opts, { roomId: 'founder', url: 'https://acme.test/pricing', cardId: 'competitor-1' })).ok).toBe(true);
    // A change from before the history began is kept as the first entry.
    await watches.change('founder', (list) => { list[0].changedAt = NOW - 1; list[0].diff = '+ older'; });
    clock.now = NOW + WATCH_EVERY;
    body = body.replace('billed yearly', 'billed monthly. A new Starter plan is free for two');
    await checkOne(watches, deps, opts);
    clock.now = NOW + 2 * WATCH_EVERY;
    body = body.replace('free for two', 'gone again, and so is the old line');
    await checkOne(watches, deps, opts);
    const [saved] = await watches.read('founder');
    expect(saved.history?.map((one) => one.at)).toEqual([NOW - 1, NOW + WATCH_EVERY, NOW + 2 * WATCH_EVERY]);
    expect(await store.readChat('founder')).toEqual([]);
    const needs = (await attention.list()).find((one) => one.kind === 'page-changed')!;
    expect(needs).toMatchObject({ cardId: 'competitor-1' });
    expect(needs.roomId).toBeUndefined();
  });

  it('never reads in fake mode, and keeps to its limits', async () => {
    let asked = 0;
    const http = (async (url: string) => { asked += 1; return fakeSite(url); }) as typeof fetch;
    const { watches, clock, deps, opts, tool, context } = await setup(http, true);
    for (let index = 0; index < WATCHES_ROOM; index += 1) await tool('watch_page').run({ url: `https://acme.test/p${index}` }, await context());
    expect((await tool('watch_page').run({ url: 'https://acme.test/one-more' }, await context())).text).toMatch(/already watch 10 pages/);
    asked = 0;
    clock.now = NOW + 10 * WATCH_EVERY;
    expect(await checkOne(watches, deps, opts)).toBeNull();
    expect(asked).toBe(0);
    expect((await tool('list_watches').run({}, await context())).text).toMatch(/^You watch 10 pages:/);
    expect((await tool('stop_watching').run({ url: 'acme.test/p3' }, await context())).text).toBe('Stopped watching https://acme.test/p3.');
    expect(await watches.read('marketing')).toHaveLength(9);
  });
});

describe('crawl_site, asked twice', () => {
  it('crawls a site once in fifteen minutes for the same question, and says when it was read', async () => {
    let fetched = 0;
    const { http: base } = acme();
    const http = (async (url: string) => { fetched += 1; return base(url); }) as typeof fetch;
    const workspace = await mkdtemp(join(tmpdir(), 'crawl-cache-'));
    const [tool] = crawlTools(options(http, { workspace, cache: true, save: async () => {} }), createWatches(await mkdtemp(join(tmpdir(), 'crawl-'))));
    const context: ToolContext = { stage: seedStage, roomId: 'marketing', store: {} as Store, granted: new Map(), query: 'pricing' };
    const first = await tool.run({ url: 'https://acme.test/' }, context);
    const once = fetched;
    const second = await tool.run({ url: 'https://acme.test/' }, context);
    expect(fetched).toBe(once);
    expect(second.text).toBe(`(Read ${new Date(NOW).toISOString().slice(0, 16).replace('T', ' ')} UTC, just now, and kept: the same read within 15 minutes comes from here.)\n${first.text}`);
    // Another question is another crawl: the best pages depend on it.
    await tool.run({ url: 'https://acme.test/' }, { ...context, query: 'careers' });
    expect(fetched).toBeGreaterThan(once);
  });
});

describe('the watch table', () => {
  it('reads a file again only when it changed on disk, keeps every change on disk, and hands out copies', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'watch-table-')), 'watch');
    await mkdir(dir, { recursive: true });
    const one = { id: 'w1', url: 'https://a.test/', what: '', roomId: 'ana', title: 'A', hash: 'h', text: 't', addedAt: 1, checkedAt: 1, readAt: 1 };
    await writeFile(join(dir, 'ana.json'), JSON.stringify([one]));
    const watches = createWatches(dir);
    expect(await watches.all()).toEqual([one]);
    // Written behind its back with a newer modification time (a check in another process, the founder by hand): seen
    // on the next read. The same content at the same time is not read again.
    await writeFile(join(dir, 'ana.json'), JSON.stringify([{ ...one, title: 'B' }]));
    await utimes(join(dir, 'ana.json'), new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    expect((await watches.read('ana'))[0].title).toBe('B');
    await writeFile(join(dir, 'ana.json'), JSON.stringify([{ ...one, title: 'A' }]));
    await utimes(join(dir, 'ana.json'), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    expect((await watches.read('ana'))[0].title).toBe('A');
    (await watches.read('ana'))[0].title = 'changed by a caller';
    expect((await watches.read('ana'))[0].title).toBe('A');
    await watches.change('bo', (list) => { list.push({ ...one, id: 'w2', roomId: 'bo' }); });
    expect((await watches.all()).map((watch) => watch.id).sort()).toEqual(['w1', 'w2']);
    expect(JSON.parse(await readFile(join(dir, 'bo.json'), 'utf8'))).toHaveLength(1);
  });
});
