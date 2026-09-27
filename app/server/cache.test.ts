import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage } from '../shared/model.ts';
import type { Browser } from './browser.ts';
import { diskCache, readFailed, SIDE_TTL, WEB_TTL, webCache, worthKeeping } from './cache.ts';
import type { ModelMessage } from './prompt.ts';
import { complete, type ModelClient } from './providers.ts';
import { route } from './router.ts';
import type { Store } from './store.ts';
import { splitSearch, webTools } from './tools/web.ts';
import { createUsage } from './usage.ts';

const T0 = Date.parse('2026-09-24T10:00:00Z');
const client = (name: string, extra: Partial<ModelClient> = {}, said: { count: number } = { count: 0 }): ModelClient => ({
  name, model: `${name}-1`, maxPromptChars: 18_000, tools: true, limits: {},
  async step(_messages, { onToken }) { said.count += 1; onToken(`${name} wrote this`); return { text: '', calls: [], usage: { input: 300, output: 40 } }; },
  ...extra,
});
const ask: ModelMessage[] = [{ role: 'system', content: 'Summarise.' }, { role: 'user', content: 'What was said today.' }];
const book = async (now: () => number) => {
  const workspace = await mkdtemp(join(tmpdir(), 'cache-'));
  return { workspace, usage: createUsage(join(workspace, 'usage.json'), now) };
};

describe('the small side model', () => {
  it('answers side calls first, and never a turn', () => {
    const usage = createUsage(null);
    const clients = [client('groq'), client('groq-small', { tools: false, side: true, maxPromptChars: 16_000 }), client('gemini')];
    // A turn goes in the one shared order (router.ts), Gemini before Groq; a side call keeps the order it was given.
    expect(route(clients, usage, { promptChars: 10, tools: true }).order.map((one) => one.name)).toEqual(['gemini', 'groq']);
    // A turn without tools (a consult) still never lands on it, not even as the last net.
    expect(route(clients, usage, { promptChars: 10, tools: false }).order.map((one) => one.name)).toEqual(['gemini', 'groq']);
    expect(route(clients, usage, { promptChars: 10, tools: false, kind: 'side' }).order.map((one) => one.name)).toEqual(['groq-small', 'groq', 'gemini']);
    // Too big for it, or out of room: the rest answer as they always did.
    expect(route(clients, usage, { promptChars: 17_000, tools: false, kind: 'side' }).order.map((one) => one.name)).toEqual(['groq', 'gemini']);
    usage.cool('groq-small', 60_000);
    expect(route(clients, usage, { promptChars: 10, tools: false, kind: 'side' }).order.map((one) => one.name)).toEqual(['groq', 'gemini', 'groq-small']);
  });

  it('falls through to the next model when it fails, and the failure is written against its key', async () => {
    const usage = createUsage(null);
    const broken = client('groq-small', { tools: false, side: true, step: async () => { throw Object.assign(new Error('down'), { status: 503 }); } });
    const { order } = route([broken, client('groq')], usage, { promptChars: 10, tools: false, kind: 'side' });
    for (let at = 0; at < 5; at += 1) await complete(ask, { onToken: () => {} }, order);
    expect(usage.breaker('groq-small')).toBe('open');
    expect((await complete(ask, { onToken: () => {} }, order)).client.name).toBe('groq');
  });
});

describe('the side-call cache', () => {
  it('answers the same prompt to the same model from disk for six hours, and counts what it saved', async () => {
    let now = T0;
    const { usage } = await book(() => now);
    const said = { count: 0 };
    const small = client('groq-small', { tools: false, side: true }, said);
    const call = async () => {
      const { order } = route([small], usage, { promptChars: 10, tools: false, kind: 'side' });
      const reply = await complete(ask, { onToken: () => {} }, order);
      usage.record(reply.client.name, reply.usage, reply.quota, 'compaction');
      return reply.text;
    };
    expect(await call()).toBe('groq-small wrote this');
    // The same words with other spacing are the same prompt.
    ask[1] = { role: 'user', content: 'What was  said today.  ' };
    expect(await call()).toBe('groq-small wrote this');
    expect(said.count).toBe(1);
    // The provider was asked once, and the book says so; the cache counted one miss and one hit worth 340 tokens.
    expect(usage.carried('groq-small').requests).toBe(1);
    expect(usage.today().kinds.compaction).toEqual({ requests: 1, input: 300, output: 40 });
    expect(usage.today().cache.side).toEqual({ hits: 1, misses: 1, tokensSaved: 340 });
    now += SIDE_TTL;
    await call();
    expect(said.count).toBe(2);
  });

  it('never keeps a call that offers tools, a reply cut short, or anything at all for a turn', async () => {
    const { usage } = await book(() => T0);
    const said = { count: 0 };
    const cut = client('groq', { step: async (_m, { onToken }) => { said.count += 1; onToken('half a'); return { text: '', calls: [], cut: true }; } });
    for (let at = 0; at < 2; at += 1) await complete(ask, { onToken: () => {} }, route([cut], usage, { promptChars: 10, tools: false, kind: 'side' }).order);
    expect(said.count).toBe(2);
    const tools = [{ name: 'x', description: '', parameters: {} }];
    for (let at = 0; at < 2; at += 1) await complete(ask, { onToken: () => {}, tools }, route([cut], usage, { promptChars: 10, tools: true, kind: 'side' }).order);
    expect(said.count).toBe(4);
    const plain = client('gemini', {}, said);
    for (let at = 0; at < 2; at += 1) await complete(ask, { onToken: () => {} }, route([plain], usage, { promptChars: 10, tools: false }).order);
    expect(said.count).toBe(6);
  });
});

describe('the web cache', () => {
  it('keeps a read fifteen minutes and says when it was read', async () => {
    let now = T0;
    const workspace = await mkdtemp(join(tmpdir(), 'web-'));
    const cache = webCache(workspace, () => now);
    let reads = 0;
    const read = async () => { reads += 1; return `## A page\nhttps://acme.test/\n\n${'Words worth reading. '.repeat(20)}`; };
    await cache.one(['read', 'https://acme.test/'], read);
    now += 6 * 60_000;
    const again = await cache.one(['read', 'https://acme.test/'], read);
    expect(reads).toBe(1);
    expect(again.split('\n')[0]).toBe('(Read 2026-09-24 10:00 UTC, 6 minutes ago, and kept: the same read within 15 minutes comes from here.)');
    now += WEB_TTL;
    await cache.one(['read', 'https://acme.test/'], read);
    expect(reads).toBe(2);
    // A read that failed is asked again next time, never remembered.
    await cache.one(['read', 'https://down.test/'], async () => { reads += 1; return '## https://down.test/\nFailed: the page did not load'; });
    await cache.one(['read', 'https://down.test/'], async () => { reads += 1; return 'x'; });
    expect(reads).toBe(4);
  });

  it('reads pages once each through web_fetch and queries once each through web_search, per workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'web-'));
    const page = (url: string) => `## ${url}\n${url}\n\n${'Body text of the page. '.repeat(20)}`;
    const asked: string[][] = [];
    const searched: string[][] = [];
    const browser = {
      read: async (urls: string[]) => { asked.push(urls); return urls.map(page).join('\n\n---\n\n'); },
      search: async (queries: string[]) => { searched.push(queries); return queries.map((query) => `## ${query}\n1. A result\n   https://r.test/\n   snippet`).join('\n\n'); },
    } as unknown as Browser;
    const tools = webTools(browser, undefined, () => T0);
    const context = { stage: seedStage, roomId: 'marketing', store: { filesDir: join(workspace, 'files') } as Store, granted: new Map<string, string>(), query: '' };
    const fetch = tools.find((one) => one.name === 'web_fetch')!;
    const search = tools.find((one) => one.name === 'web_search')!;
    await fetch.run({ urls: ['https://a.test/', 'https://b.test/'] }, context);
    const second = await fetch.run({ urls: ['https://b.test/', 'https://c.test/'] }, context);
    expect(asked).toEqual([['https://a.test/', 'https://b.test/'], ['https://c.test/']]);
    expect(second.text).toContain('(Read 2026-09-24 10:00 UTC, just now, and kept');
    expect(second.text.indexOf('https://b.test/')).toBeLessThan(second.text.indexOf('https://c.test/'));
    await search.run({ queries: ['crm pricing', 'crm reviews'] }, context);
    const again = await search.run({ queries: ['crm reviews', 'crm market'] }, context);
    expect(searched).toEqual([['crm pricing', 'crm reviews'], ['crm market']]);
    expect(again.text).toContain('## crm reviews');
    expect(again.text).toContain('## crm market');
  });

  it('splits a search answer back into one block a query, or says it cannot', () => {
    expect(splitSearch('## a\n1. x\n\n## b\n1. y', ['a', 'b'])).toEqual(['## a\n1. x', '## b\n1. y']);
    expect(splitSearch('## b\n1. y', ['a', 'b'])).toBeNull();
  });
});

describe('sweeping a cache folder', () => {
  it('sweeps a folder once an hour however many caches are made on it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cache-sweep-'));
    let now = Date.now();
    await diskCache<number>(dir, 1000, () => now).put('one', 1);
    // Out of date now, but a new cache on the same folder does not sweep again within the hour.
    now += 5000;
    await diskCache<number>(dir, 1000, () => now).put('two', 2);
    expect((await readdir(dir)).sort()).toEqual(['one.json', 'two.json']);
    now += 3600_000 + 1;
    await diskCache<number>(dir, 1000, () => now).put('three', 3);
    expect(await readdir(dir)).not.toContain('one.json');
  });
});

describe('what counts as a failed read', () => {
  it('tells a failure from a short real page', () => {
    expect(readFailed('## https://x.test\nFailed: the page did not load')).toBe(true);
    expect(readFailed('(could not be read: timeout)')).toBe(true);
    expect(readFailed('   ')).toBe(true);
    expect(readFailed('We make shoes for runners.')).toBe(false);
    // Short pages are real but not worth a web cache entry; a link card still keeps them.
    expect(worthKeeping('We make shoes for runners.')).toBe(false);
  });
});
