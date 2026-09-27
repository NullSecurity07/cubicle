import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ModelInfo, Usage } from '../shared/model.ts';
import { createBreaker, refused } from './breaker.ts';
import { fromCache, onCache } from './cache.ts';
import { neuronPoolOf, poolOf, providerOf, type ModelClient, type Quota } from './providers.ts';
import { writeAtomic } from './fsx.ts';

// `neurons`: what Cloudflare said this key's answers cost from its free daily pool.
type Count = { requests: number; input: number; output: number; neurons?: number };
// What a call was for. A turn is a person answering; the rest are the calls around it.
type CallKind = 'turn' | 'side' | 'eval' | 'retain' | 'reflect' | 'compaction';
// Per tool: how many results went into a prompt, and how many characters they came to before and after shrinking.
type ToolCount = { results: number; before: number; after: number };
type CacheCount = { hits: number; misses: number; tokensSaved: number };
// `kinds`, `tools` and `cache` came later: a day written before them still reads, as a day without them.
type State = { day: string; providers: Record<string, Count>; kinds?: Record<string, Count>; tools?: Record<string, ToolCount>; cache?: Record<string, CacheCount> };
type Seen = { at: number; tokens: number };

export type UsageBook = ReturnType<typeof createUsage>;

const WINDOW = 60_000;
// Of Cloudflare's 10,000 free neurons a day, what the turns may spend; the rest is the pictures'.
export const NEURONS_FOR_TURNS = 9000;
const today = (now: number) => new Date(now).toISOString().slice(0, 10);
const share = (used: number, limit?: number) => (limit ? Math.max(0, 1 - used / limit) : 1);

// Keeps count of what each free provider has been asked today, so a person can move on before a limit bites.
// Published limits are a guide; a provider's own headers and its 429s are the truth and override them.
export function createUsage(path: string | null, now: () => number = Date.now) {
  let state: State = { day: today(now()), providers: {} };
  const recent: Record<string, Seen[]> = {};
  const quotas: Record<string, { at: number; quota: Quota }> = {};
  const cooling: Record<string, number> = {};
  let saving: Promise<unknown> = Promise.resolve();
  const breaker = createBreaker(now);
  // Every refusal (401, 403) and, while anyone listens, every answer: whoever listens decides what is news.
  const keyWatchers = new Set<(event: { name: string; dead: boolean; status?: number }) => void>();
  const tellKey = (event: { name: string; dead: boolean; status?: number }) => { for (const tell of keyWatchers) { try { tell(event); } catch { /* a listener never costs a call */ } } };
  const folder = path ? dirname(path) : null;

  const roll = () => { if (state.day !== today(now())) state = { day: today(now()), providers: {} }; };
  const count = (name: string) => (state.providers[name] ??= { requests: 0, input: 0, output: 0 });
  const window = (name: string) => (recent[name] = (recent[name] ?? []).filter((seen) => now() - seen.at < WINDOW));
  const save = () => {
    if (!path) return;
    const text = JSON.stringify(state, null, 2);
    saving = saving.then(async () => {
      await writeAtomic(path, text, { mkdir: true });
    }).catch(() => {});
  };

  // Today's requests against the daily allowance this key shares with the other models on its account.
  const pooled = (name: string) => {
    const pool = poolOf(name);
    return Object.entries(state.providers).reduce((sum, [one, used]) => sum + (one === name || poolOf(one) === pool ? used.requests : 0), 0);
  };

  function left(client: ModelClient) {
    roll();
    const used = count(client.name);
    const header = quotas[client.name];
    const fromHeader = header && today(header.at) === state.day && header.quota.limitRequests && header.quota.remainingRequests !== undefined
      ? header.quota.remainingRequests / header.quota.limitRequests : 1;
    return Math.min(share(pooled(client.name), client.limits.rpd), share(used.input + used.output, client.limits.tpd), fromHeader);
  }

  // The cache's hits and misses for this workspace, counted into the day like everything else.
  if (folder) {
    onCache((event) => {
      if (event.folder !== folder) return;
      roll();
      const one = ((state.cache ??= {})[event.kind] ??= { hits: 0, misses: 0, tokensSaved: 0 });
      if (event.hit) { one.hits += 1; one.tokensSaved += event.tokens ?? 0; } else one.misses += 1;
      save();
    });
  }

  return {
    // The workspace this book belongs to: the side-call cache lives under it.
    folder,
    // The book's clock, so what is kept beside it ages the same way.
    clock: now,
    async load() {
      if (!path) return;
      try {
        const saved = JSON.parse(await readFile(path, 'utf8')) as State;
        if (saved.day === today(now())) state = saved;
      } catch { /* first run, or a damaged file: start the day at zero */ }
    },
    settled: () => saving,
    record(name: string, usage?: Usage, quota?: Quota, kind: CallKind = 'turn') {
      // Answered from the cache: nothing was asked of the provider, and the cache counted it already.
      if (usage && fromCache.has(usage)) return;
      roll();
      breaker.ok(name);
      if (keyWatchers.size) tellKey({ name, dead: false });
      const of = ((state.kinds ??= {})[kind] ??= { requests: 0, input: 0, output: 0 });
      of.requests += 1;
      of.input += usage?.input ?? 0;
      of.output += usage?.output ?? 0;
      const used = count(name);
      used.requests += 1;
      used.input += usage?.input ?? 0;
      used.output += usage?.output ?? 0;
      if (usage?.neurons) used.neurons = (used.neurons ?? 0) + usage.neurons;
      window(name).push({ at: now(), tokens: (usage?.input ?? 0) + (usage?.output ?? 0) });
      if (quota) quotas[name] = { at: now(), quota };
      save();
    },
    // A provider said "not now": leave it alone for as long as it asked, or a minute.
    cool(name: string, milliseconds = WINDOW) { cooling[name] = now() + milliseconds; },
    // A request that failed: a 429 rests the key (as long as it asked, or three seconds doubling), five 5xx or
    // timeouts in a row open its breaker, a 401 or 403 rests it six hours as dead. See breaker.ts.
    failed(name: string, error: unknown) {
      const rest = breaker.failed(name, error);
      if (refused(error)) tellKey({ name, dead: true, status: (error as { status?: number })?.status });
      return rest;
    },
    // Hears a key the provider refused, and the same key answering again.
    onKey(tell: (event: { name: string; dead: boolean; status?: number }) => void) { keyWatchers.add(tell); return () => { keyWatchers.delete(tell); }; },
    // Right before a request goes out: false while the key's breaker is open, or half open with its one try out.
    admit: (name: string) => breaker.admit(name),
    breaker: (name: string) => breaker.state(name),
    // True while the provider's refusal of this key (401, 403) is fresh.
    dead: (name: string) => breaker.dead(name),
    // How much one key has carried, the last minute first: what spreads a provider's keys evenly.
    carried(name: string) {
      roll();
      const seen = window(name);
      const used = state.providers[name];
      return { minute: seen.reduce((sum, one) => sum + one.tokens, 0), requests: seen.length, day: (used?.input ?? 0) + (used?.output ?? 0) };
    },
    // One tool result on its way into a prompt, before and after it was shrunk.
    shrunk(tool: string, before: number, after: number) {
      roll();
      const one = ((state.tools ??= {})[tool] ??= { results: 0, before: 0, after: 0 });
      one.results += 1;
      one.before += before;
      one.after += after;
      save();
    },
    // Today's counts by what the call was for, by tool and by cache, for the insights to put together.
    today() { roll(); return { kinds: { ...state.kinds }, tools: { ...state.tools }, cache: { ...state.cache } }; },
    left,
    // True once this key has made as many requests today as its published daily allowance: the day's free turns are used.
    // A key on Cloudflare's neuron pool is also spent once the answers on that pool have cost 9,000 neurons today,
    // whichever model asked: the rest of the 10,000 stays with the pictures.
    spent(client: ModelClient) {
      roll();
      if (client.limits.rpd && pooled(client.name) >= client.limits.rpd) return true;
      const pool = client.sharedPool ? neuronPoolOf(client.name) ?? providerOf(client.name) : undefined;
      if (!pool) return false;
      const neurons = Object.entries(state.providers).reduce((sum, [one, used]) => sum + ((neuronPoolOf(one) ?? one) === pool ? used.neurons ?? 0 : 0), 0);
      return neurons >= NEURONS_FOR_TURNS;
    },
    // True while this key rests after a 429, an open breaker or a refused key. Only looks.
    resting: (name: string) => breaker.resting(name),
    // True when one more request of this size would likely hit the per-minute wall.
    // A key that takes one request at a time and has one out counts as out of room until it is back.
    hot(client: ModelClient, promptChars: number) {
      if ((cooling[client.name] ?? 0) > now() || breaker.resting(client.name) || client.busy?.()) return true;
      const seen = window(client.name);
      const tokens = Math.ceil(promptChars / 4);
      if (client.limits.rpm && seen.length >= client.limits.rpm) return true;
      if (client.limits.tpm && seen.reduce((sum, one) => sum + one.tokens, 0) + tokens > client.limits.tpm) return true;
      const header = quotas[client.name];
      return !!header && now() - header.at < WINDOW && header.quota.remainingTokens !== undefined && header.quota.remainingTokens < tokens;
    },
    // Several keys for one provider are one provider to the founder: the rings show what they have done together and
    // what is left of the two days' worth between them. It is also the name a person is pinned to.
    // The side model is no one's to pin, so the picker never lists it; the insights ask for it with `withSide`.
    info(clients: ModelClient[], withSide = false): ModelInfo[] {
      roll();
      const rows = new Map<string, { info: ModelInfo; keys: number }>();
      for (const client of clients.filter((one) => withSide || !one.side)) {
        const name = providerOf(client.name);
        const used = count(client.name);
        const row = rows.get(name) ?? { info: { name, model: client.model, ready: true, left: 0, requests: 0, tokens: 0 }, keys: 0 };
        rows.set(name, {
          keys: row.keys + 1,
          info: { ...row.info, left: row.info.left + left(client), requests: row.info.requests + used.requests, tokens: row.info.tokens + used.input + used.output },
        });
      }
      return [...rows.values()].map(({ info, keys }) => ({ ...info, left: info.left / keys }));
    },
  };
}
