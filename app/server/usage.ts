import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CheckOutcome, KeyCheck, ModelInfo, Usage } from '../shared/model.ts';
import { createBreaker, limitWords, planless, refused, unpaid } from './breaker.ts';
import { fromCache, onCache } from './cache.ts';
import { neuronPoolOf, PICTURE_POOL, poolOf, providerOf, type ModelClient, type Quota } from './providers.ts';
import { writeAtomic } from './fsx.ts';
import { localDay, now as clockNow } from './clock.ts';

// What one key check with a model came to, from how its one word failed: a refusal says which kind, a 404 that the
// model is gone, a 5xx that the provider is down, an abort at the cap that it is slow; anything else simply failed.
export function outcomeOf(error: unknown, timedOut = false): CheckOutcome {
  if (timedOut) return 'slow';
  if (planless(error)) return 'plan';
  if (unpaid(error)) return 'card';
  if (refused(error)) return 'refused';
  const status = (error as { status?: number })?.status;
  if (status === 404) return 'not-found';
  if (typeof status === 'number' && status >= 500) return 'down';
  return 'failed';
}

// `neurons`: what Cloudflare said this key's answers cost from its free daily pool.
type Count = { requests: number; input: number; output: number; neurons?: number };
// What a call was for. A turn is a person answering; the rest are the calls around it.
type CallKind = 'turn' | 'side' | 'eval' | 'retain' | 'reflect' | 'compaction';
// Per tool: how many results went into a prompt, and how many characters they came to before and after shrinking.
type ToolCount = { results: number; before: number; after: number };
type CacheCount = { hits: number; misses: number; tokensSaved: number };
// `kinds`, `tools` and `cache` came later: a day written before them still reads, as a day without them.
// `pictures`: by neuron pool, the pictures drawn on it today and the neurons they cost.
// `month`: requests by key this calendar month, kept across days for a model with a monthly cap (`rpmo`).
type State = { day: string; month?: { at: string; requests: Record<string, number> }; providers: Record<string, Count>; kinds?: Record<string, Count>; tools?: Record<string, ToolCount>; cache?: Record<string, CacheCount>; pictures?: Record<string, { drawn: number; neurons: number }>;
  // Models a turn's own 429 said were out of today's free requests: spent until the day rolls over, whatever the count says.
  outToday?: string[] };
type Seen = { at: number; tokens: number };
// A key refused (`dead`) or answering again. `planless`: refused because its plan allows no requests at all yet;
// `unpaid`: refused until the account has a card or payment method on file.
export type KeyEvent = { name: string; dead: boolean; status?: number; planless?: boolean; unpaid?: boolean };
// What the rail's dots are drawn from, kept beside the day's counts so a restart does not forget it: a refusal and
// until when it holds, when a key last answered, and whether a check found it answering. A refusal kept here is put
// back on start, so the dot, the Needs-you item and the route all know it before the key is asked again.
// `key` is a short hash of the key that was refused: a new key pasted while the app was off starts clean.
// `check`: how the last key check with it went and when, so a check that timed out or found no such model is said as that
// after a restart, never as a key that passed. `checked: true` is how a file written before outcomes said a check passed.
type KeyMemory = { deadUntil?: number; status?: number; why?: 'plan' | 'card' | 'key'; key?: string; answeredAt?: number; check?: KeyCheck; checked?: boolean };
// A key's short hash, never the key: enough to tell a new key from the one that was refused.
export const keyPrint = (key?: string | null) => (key ? createHash('sha256').update(key).digest('hex').slice(0, 12) : undefined);

export type UsageBook = ReturnType<typeof createUsage>;

const WINDOW = 60_000;
// Of Cloudflare's 10,000 free neurons a day, what the turns may spend; the rest is the pictures'.
export const NEURONS_FOR_TURNS = 9000;
const today = (now: number) => new Date(now).toISOString().slice(0, 10);
const thisMonth = (now: number) => new Date(now).toISOString().slice(0, 7);

// A picture drawn on Cloudflare spends the same day's neurons the turns do, so every usage book with a workspace hears
// of it and counts it into that pool: the turns then stop at 9,000 with the pictures in, not beside them.
type PictureListener = (pool: string, neurons: number) => void;
const pictureListeners = new Set<PictureListener>();
export function onPictureNeurons(listen: PictureListener) { pictureListeners.add(listen); return () => { pictureListeners.delete(listen); }; }
export function pictureDrawn(neurons: number, pool = PICTURE_POOL) { for (const listen of pictureListeners) { try { listen(pool, neurons); } catch { /* counting never costs a picture */ } } }
const share = (used: number, limit?: number) => (limit ? Math.max(0, 1 - used / limit) : 1);

// Keeps count of what each free provider has been asked today, so a person can move on before a limit bites.
// Published limits are a guide; a provider's own headers and its 429s are the truth and override them.
export function createUsage(path: string | null, now: () => number = Date.now) {
  let state: State = { day: today(now()), providers: {} };
  const recent: Record<string, Seen[]> = {};
  const quotas: Record<string, { at: number; quota: Quota }> = {};
  const cooling: Record<string, number> = {};
  // When each key last answered, and the keys a check found answering: kept past midnight, while the server runs, so a
  // model that has answered or passed a check is never "untested" again only because the day's count went to zero.
  const answeredAt: Record<string, number> = {};
  const checks: Record<string, KeyCheck> = {};
  let saving: Promise<unknown> = Promise.resolve();
  const breaker = createBreaker(now);
  // Keys last refused because their plan allows no requests. Only true while the refusal itself still holds.
  const planlessKeys = new Set<string>();
  const planOff = (name: string) => planlessKeys.has(name) && breaker.dead(name);
  // Keys last refused because the account wants a card on file. Only true while the refusal itself still holds.
  const unpaidKeys = new Set<string>();
  const needsCard = (name: string) => unpaidKeys.has(name) && breaker.dead(name);
  const refusalStatus: Record<string, number | undefined> = {};
  // Every refusal (401, 403) and, while anyone listens, every answer: whoever listens decides what is news.
  const keyWatchers = new Set<(event: KeyEvent) => void>();
  const tellKey = (event: KeyEvent) => { for (const tell of keyWatchers) { try { tell(event); } catch { /* a listener never costs a call */ } } };
  const folder = path ? dirname(path) : null;
  const keysPath = folder ? `${folder}/model-dots.json` : null;
  let keysSaving: Promise<unknown> = Promise.resolve();
  let prints: Record<string, string | undefined> = {};
  const saveKeys = () => {
    if (!keysPath) return;
    const keys: Record<string, KeyMemory> = {};
    for (const name of new Set([...Object.keys(answeredAt), ...Object.keys(checks), ...planlessKeys, ...unpaidKeys, ...Object.keys(refusalStatus)])) {
      const until = breaker.dead(name) ? breaker.deadUntil(name) : undefined;
      const one: KeyMemory = {
        ...(until ? { deadUntil: until, status: refusalStatus[name], why: planlessKeys.has(name) ? 'plan' : unpaidKeys.has(name) ? 'card' : 'key', ...(prints[name] ? { key: prints[name] } : {}) } : {}),
        ...(answeredAt[name] ? { answeredAt: answeredAt[name] } : {}), ...(checks[name] ? { check: checks[name] } : {}),
      };
      if (Object.keys(one).length) keys[name] = one;
    }
    const text = JSON.stringify({ keys }, null, 2);
    keysSaving = keysSaving.then(() => writeAtomic(keysPath, text, { mkdir: true })).catch(() => {});
  };
  // A key is news to the dots when it is refused, answers for the first time since start or since a refusal, or passes a
  // check: not every answer, which would write the file on every call.
  const forget = (name: string) => {
    const was = name in refusalStatus || planlessKeys.has(name) || unpaidKeys.has(name);
    planlessKeys.delete(name); unpaidKeys.delete(name); delete refusalStatus[name];
    return was;
  };

  // A new day starts the day's counts again; the month's go on until the month ends.
  const monthOf = (month?: State['month']) => (month?.at === thisMonth(now()) ? { month } : {});
  const roll = () => { if (state.day !== today(now())) state = { day: today(now()), providers: {}, ...monthOf(state.month) }; };
  const monthly = (name: string) => (state.month?.at === thisMonth(now()) ? state.month.requests[name] ?? 0 : 0);
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

  // Today's neurons on one pool: every model's answers on it, and the pictures drawn on it.
  const poolNeurons = (pool: string) => Object.entries(state.providers).reduce((sum, [one, used]) => sum + ((neuronPoolOf(one) ?? providerOf(one)) === pool ? used.neurons ?? 0 : 0), 0)
    + (state.pictures?.[pool]?.neurons ?? 0);
  const neuronPool = (client: ModelClient) => (client.sharedPool ? neuronPoolOf(client.name) ?? providerOf(client.name) : undefined);

  function left(client: ModelClient) {
    roll();
    const used = count(client.name);
    const header = quotas[client.name];
    const fromHeader = header && today(header.at) === state.day && header.quota.limitRequests && header.quota.remainingRequests !== undefined
      ? header.quota.remainingRequests / header.quota.limitRequests : 1;
    const pool = neuronPool(client);
    const fromNeurons = pool ? share(poolNeurons(pool), NEURONS_FOR_TURNS) : 1;
    if (state.outToday?.includes(client.name)) return 0;
    return Math.min(share(pooled(client.name), client.limits.rpd), share(used.input + used.output, client.limits.tpd), fromHeader, fromNeurons, share(monthly(client.name), client.limits.rpmo));
  }

  if (folder) {
    onPictureNeurons((pool, neurons) => {
      roll();
      const one = ((state.pictures ??= {})[pool] ??= { drawn: 0, neurons: 0 });
      one.drawn += 1;
      one.neurons += neurons;
      save();
    });
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
        else state = { ...state, ...monthOf(saved.month) };
      } catch { /* first run, or a damaged file: start the day at zero */ }
      if (!keysPath) return;
      try {
        const saved = JSON.parse(await readFile(keysPath, 'utf8')) as { keys?: Record<string, KeyMemory> };
        for (const [name, one] of Object.entries(saved.keys ?? {})) {
          if (typeof one.answeredAt === 'number') answeredAt[name] = one.answeredAt;
          const check = one.check;
          if (check && typeof check.at === 'number' && typeof check.outcome === 'string') checks[name] = { outcome: check.outcome, at: check.at, ...(typeof check.status === 'number' ? { status: check.status } : {}) };
          else if (one.checked) checks[name] = { outcome: 'ok', at: one.answeredAt ?? 0 };
          if (typeof one.deadUntil !== 'number' || one.deadUntil <= now() || one.key !== prints[name]) continue;
          breaker.refuse(name, one.deadUntil);
          refusalStatus[name] = one.status;
          if (one.why === 'plan') planlessKeys.add(name);
          if (one.why === 'card') unpaidKeys.add(name);
        }
      } catch { /* first run, or a damaged file: the dots start untested */ }
    },
    // The keys refused right now, as the events that said so: told again to whoever starts listening after a restart,
    // so the founder's Needs-you item is back before the key is asked again.
    refusals(): KeyEvent[] {
      return Object.keys(refusalStatus).filter((name) => breaker.dead(name)).map((name) => ({
        name, dead: true, status: refusalStatus[name], ...(planlessKeys.has(name) ? { planless: true } : {}), ...(unpaidKeys.has(name) ? { unpaid: true } : {}),
      }));
    },
    settled: () => saving,
    // Each client's key as a short hash, told before `load`: a refusal kept from the last run comes back only for the
    // very key that was refused.
    fingerprints(next: Record<string, string | undefined>) { prints = next; },
    record(name: string, usage?: Usage, quota?: Quota, kind: CallKind = 'turn') {
      // Answered from the cache: nothing was asked of the provider, and the cache counted it already.
      if (usage && fromCache.has(usage)) return;
      roll();
      breaker.ok(name);
      const news = forget(name) || !answeredAt[name];
      answeredAt[name] = now();
      if (news) saveKeys();
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
      if (state.month?.at !== thisMonth(now())) state.month = { at: thisMonth(now()), requests: {} };
      state.month.requests[name] = (state.month.requests[name] ?? 0) + 1;
      window(name).push({ at: now(), tokens: (usage?.input ?? 0) + (usage?.output ?? 0) });
      if (quota) quotas[name] = { at: now(), quota };
      save();
    },
    // A provider said "not now": leave it alone for as long as it asked, or a minute.
    cool(name: string, milliseconds = WINDOW) { cooling[name] = now() + milliseconds; },
    // A request that failed: a 429 rests the key (as long as it asked, or three seconds doubling), five 5xx or
    // timeouts in a row open its breaker, a 401 or 403 rests it six hours as dead. See breaker.ts.
    // Journey 14: Gemini Flash's ring said "100% left" all day while every partner turn said its daily limit was reached:
    // the count is ours and the provider's day is not, so a 429 that says the day is used marks it spent until tomorrow.
    failed(name: string, error: unknown) {
      const rest = breaker.failed(name, error);
      if ((error as { status?: number })?.status === 429 && !planless(error) && limitWords(error) === "today's free limit reached") {
        roll();
        if (!state.outToday?.includes(name)) { state.outToday = [...state.outToday ?? [], name]; save(); }
      }
      if (refused(error)) {
        const status = (error as { status?: number })?.status;
        forget(name);
        refusalStatus[name] = status;
        if (planless(error)) planlessKeys.add(name);
        if (unpaid(error)) unpaidKeys.add(name);
        saveKeys();
        tellKey({ name, dead: true, status, ...(planless(error) ? { planless: true } : {}), ...(unpaid(error) ? { unpaid: true } : {}) });
      }
      return rest;
    },
    // Hears a key the provider refused, and the same key answering again.
    onKey(tell: (event: KeyEvent) => void) { keyWatchers.add(tell); return () => { keyWatchers.delete(tell); }; },
    // Right before a request goes out: false while the key's breaker is open, or half open with its one try out.
    admit: (name: string) => breaker.admit(name),
    breaker: (name: string) => breaker.state(name),
    // True while the provider's refusal of this key (401, 403) is fresh.
    dead: (name: string) => breaker.dead(name),
    // True while this key is refused because its free plan is not on (Mistral's 429 with a limit of 0).
    planOff,
    // True while this key is refused until its account has a card or payment method on file (SambaNova, Vercel).
    needsCard,
    // Written once whatever the dots are drawn from has settled (tests wait on it).
    keysSettled: () => keysSaving,
    // A key a check found answering: whatever its breaker held against it (a refusal's six hours, say, after the founder
    // turned a plan on) is forgotten, and whoever heard of the refusal hears it answer.
    // The check that found it answering is remembered, so its dot says so.
    revive(name: string) { breaker.ok(name); forget(name); checks[name] = { outcome: 'ok', at: now() }; saveKeys(); if (keyWatchers.size) tellKey({ name, dead: false }); },
    // A key check that did not pass, kept as what it came to: slow, no such model, refused, a card or a plan wanted.
    checkFailed(name: string, outcome: Exclude<CheckOutcome, 'ok'>, status?: number) { checks[name] = { outcome, at: now(), ...(status ? { status } : {}) }; saveKeys(); },
    // The last check with each key, as kept: what the Keys panel says after a restart.
    checks: (): Record<string, KeyCheck> => ({ ...checks }),
    // When this key last answered, kept across a restart.
    answeredAt: (name: string): number | undefined => answeredAt[name],
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
    // A key with a monthly cap (`rpmo`) is spent once the month's requests reach it, whatever the day.
    // A key on Cloudflare's neuron pool is also spent once the answers on that pool have cost 9,000 neurons today,
    // whichever model asked: the rest of the 10,000 stays with the pictures.
    spent(client: ModelClient) {
      roll();
      if (state.outToday?.includes(client.name)) return true;
      if (client.limits.rpd && pooled(client.name) >= client.limits.rpd) return true;
      if (client.limits.rpmo && monthly(client.name) >= client.limits.rpmo) return true;
      const pool = neuronPool(client);
      return !!pool && poolNeurons(pool) >= NEURONS_FOR_TURNS;
    },
    // The neurons this key's pool has spent today, of the 9,000 the turns may, and how many of them went on pictures.
    // Undefined for a key that is on no such pool.
    neurons(client: ModelClient) {
      roll();
      const pool = neuronPool(client);
      if (!pool) return undefined;
      const pictures = state.pictures?.[pool];
      return { used: poolNeurons(pool), of: NEURONS_FOR_TURNS, pictures: pictures?.neurons ?? 0, drawn: pictures?.drawn ?? 0 };
    },
    // True while this key cannot answer at all: refused (a 401, a plan that is off) or its breaker open. Only looks. A
    // slow or 429-resting key is not blocked: it may still answer, so it still counts as a model behind another.
    blocked: (name: string) => breaker.dead(name) || breaker.state(name) === 'open',
    // True while this model rests after giving no first word twice in a row (breaker.ts): at the back, not dead.
    slow: (name: string) => breaker.slow(name),
    // True while this key rests after a 429, an open breaker, a refused key or two silences. Only looks.
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
    // The side model is no one's to pin, so the picker never lists it; the insights ask for it with `withSide`. A
    // partner-only model is listed only when asked for with `withPartner` (the rail's rings), and marked, so no picker
    // offers it to a colleague it would never answer.
    info(clients: ModelClient[], withSide = false, withPartner = withSide): ModelInfo[] {
      roll();
      const rows = new Map<string, { info: ModelInfo; keys: number; off: number; card: number; slow: number }>();
      for (const client of clients.filter((one) => withSide || (!one.side && (withPartner || !one.partnerOnly)))) {
        const name = providerOf(client.name);
        const used = count(client.name);
        const row = rows.get(name) ?? { info: { name, model: client.model, ready: true, left: 0, requests: 0, tokens: 0, ...(client.partnerOnly ? { partnerOnly: true } : {}) }, keys: 0, off: 0, card: 0, slow: 0 };
        const last = Math.max(row.info.lastAnswerAt ?? 0, answeredAt[client.name] ?? 0);
        // One key that passed is the provider passing; with none, the latest check that did not pass is what is said.
        const mine = checks[client.name];
        const was = row.info.check;
        const check = !mine ? was : !was ? mine : (was.outcome === 'ok') !== (mine.outcome === 'ok') ? (was.outcome === 'ok' ? was : mine) : (mine.at > was.at ? mine : was);
        rows.set(name, {
          keys: row.keys + 1, off: row.off + (planOff(client.name) ? 1 : 0), card: row.card + (needsCard(client.name) ? 1 : 0), slow: row.slow + (breaker.slow(client.name) ? 1 : 0),
          info: {
            ...row.info, left: row.info.left + left(client), requests: row.info.requests + used.requests, tokens: row.info.tokens + used.input + used.output,
            ...(last ? { lastAnswerAt: last } : {}), ...(check ? { check, ...(check.outcome === 'ok' ? { checked: true } : {}) } : {}),
          },
        });
      }
      // A provider none of whose keys has a plan on answers nobody: said as that, not as a full ring. One whose every key
      // rests slow is slow; one slow key of two is not, its sibling still serves.
      // One that needs a card on file is said the same way.
      return [...rows.values()].map(({ info, keys, off, card, slow }) => ({ ...info, left: info.left / keys, ...(off === keys ? { planOff: true } : {}), ...(card === keys ? { needsCard: true } : {}), ...(slow === keys ? { slow: true } : {}) }));
    },
  };
}

// Work nobody asked for (a watch that fired, a review of a team doc, a refresh) spends the same free day the founder's
// own turns do. It gets a budget of its own, so the asked turns still have room by evening: so many model turns a day,
// counted from the founder's midnight, kept in a file so a restart does not hand the day back.
// It never runs on a partner-only model (Gemini Flash's 20 a day are the partner's), nor on a model with under a
// quarter of its day left: what is left of a nearly spent model is the founder's.
export const UNASKED_CAP = 12;
export const UNASKED_FLOOR = 0.25;
export type UnaskedTurn = { reason: string; at: number };
// What `take` came to. `models`: the clients an unasked turn may use, best left first; route with `unasked: true` and it
// is the same set. `release`: the turn never ran, so it does not count. Calling it twice, or after midnight, is harmless.
export type UnaskedTake = { ok: boolean; left: number; why: string; models: string[]; release: () => void };
type UnaskedDay = { day: string; used: (UnaskedTurn & { id: number })[] };

// True when an unasked turn may go to this model at all.
export const unaskedAllowed = (client: ModelClient, usage: Pick<UsageBook, 'left' | 'spent' | 'blocked'>) =>
  !client.partnerOnly && !client.side && !usage.spent(client) && !usage.blocked(client.name) && usage.left(client) >= UNASKED_FLOOR;

export function createUnasked(options: { path: string | null; usage: Pick<UsageBook, 'left' | 'spent' | 'blocked'>; clients: () => ModelClient[]; cap?: number; now?: () => number }) {
  // The founder's clock (clock.ts), so a day moved on in a check is a new day for the budget too (journey 20 had four
  // test days share one budget dated by the machine's clock).
  const now = options.now ?? clockNow;
  const cap = Math.max(0, Math.floor(options.cap ?? UNASKED_CAP));
  let book: UnaskedDay = { day: localDay(now()), used: [] };
  let next = 1;
  let saving: Promise<unknown> = Promise.resolve();
  const roll = () => { if (book.day !== localDay(now())) book = { day: localDay(now()), used: [] }; };
  const save = () => {
    if (!options.path) return;
    const text = JSON.stringify({ day: book.day, used: book.used.map(({ reason, at }) => ({ reason, at })) }, null, 2);
    const path = options.path;
    saving = saving.then(() => writeAtomic(path, text, { mkdir: true })).catch(() => {});
  };
  const left = () => { roll(); return Math.max(0, cap - book.used.length); };

  return {
    cap,
    async load() {
      if (!options.path) return;
      try {
        const saved = JSON.parse(await readFile(options.path, 'utf8')) as { day?: string; used?: UnaskedTurn[] };
        if (saved.day === localDay(now()) && Array.isArray(saved.used)) {
          book = { day: saved.day, used: saved.used.filter((one) => typeof one?.reason === 'string' && typeof one.at === 'number').map((one) => ({ reason: one.reason, at: one.at, id: next++ })) };
        }
      } catch { /* first run, or a damaged file: the day starts at zero */ }
    },
    settled: () => saving,
    left,
    // Today's unasked turns, the oldest first.
    used(): UnaskedTurn[] { roll(); return book.used.map(({ reason, at }) => ({ reason, at })); },
    // One unasked turn, counted the moment it is taken so a crash halfway still counts it. Refused once the day's cap
    // is used, or when no model may take it.
    take(reason: string): UnaskedTake {
      roll();
      const none = { models: [] as string[], release: () => {} };
      if (book.used.length >= cap) return { ok: false, left: 0, why: `budget used today: ${book.used.length} of ${cap} unasked turns`, ...none };
      const models = options.clients().filter((client) => unaskedAllowed(client, options.usage))
        .sort((a, b) => options.usage.left(b) - options.usage.left(a)).map((client) => client.name);
      if (!models.length) return { ok: false, left: left(), why: 'no model has a quarter of its day left, and the partner\'s own model is kept for the founder', ...none };
      const id = next++;
      const day = book.day;
      book.used.push({ reason: reason.trim().slice(0, 120) || 'unasked work', at: now(), id });
      save();
      return {
        ok: true, left: left(), why: '', models,
        release: () => {
          roll();
          if (book.day !== day) return;
          const at = book.used.findIndex((one) => one.id === id);
          if (at < 0) return;
          book.used.splice(at, 1);
          save();
        },
      };
    },
  };
}
export type Unasked = ReturnType<typeof createUnasked>;
