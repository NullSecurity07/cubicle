import { diffLine, type CoderAsk, type CoderModel, type CoderEvent, type CoderLine, type CoderLive, type CoderModels, type CoderPatch, type CoderState } from '../../shared/coder.ts';
import type { Attention } from '../../shared/model.ts';
import { askFounder, type Answer } from '../approvals.ts';
import { KEYED as KEYS, MCP_NAME, type McpLocal } from './config.ts';
import { modelDown, translate, type RawEvent } from './events.ts';
import { GONE, needsRestart, type Engine } from './server.ts';

// Driving one card's coder: its lasting session in one folder, the log the founder watches, the questions it asks and
// the end of each piece of work. Everything the tools and the card need goes through here, so another engine would
// only have to be another one of these.
export type CoderCard = { id: string; dir: string; name: string; session?: string; model?: string };
type Deps = {
  engine: Engine;
  say(cardId: string, event: CoderEvent): void;
  approvals: { ask(id: string, signal?: AbortSignal): Promise<Answer>; answer(id: string, answer: Answer): boolean };
  attention: { raise(entry: Attention): Promise<void>; clear(id: string): Promise<void> };
  // Writes the card's session into the saved stage, so the same conversation carries on after a restart.
  remember(cardId: string, session: string): Promise<void>;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  // Whether a local model server answers. Only ever looked at, never started.
  reachable?: (url: string) => Promise<boolean>;
  // The folder's map, when it has one: the tool server that reads it and the one sentence that tells the coder so.
  map?: (dir: string) => Promise<{ mcp: McpLocal; hint: string } | null>;
};
type McpStatus = Record<string, { status?: string; error?: string }> | null;
type Held = {
  id: string; dir: string; name: string; session?: string; model?: string;
  state: CoderState; lines: CoderLine[];
  // Every question the coder is waiting on, in the order it asked them. A model that calls two tools in one step asks
  // two at once, and both must reach the founder: the first shows, the rest wait behind it.
  permissions: CoderAsk[];
  heard: number; prompted: number; seenBusy: boolean; reply: string; error?: string;
  // The ask being worked on and the model working on it. A free model that turns out to be down hands the same ask to
  // the next free one, once per ask (`switched`); while it does, the old model's last words (a refusal, the idle after
  // the abort) are not news (`switching`: 'aborting' until the ask has gone to the next model, 'sent' until it is busy).
  ask?: string; using?: string; switched?: boolean; switching?: 'aborting' | 'sent';
  // Counts the asks (and the hand-overs): an end that was being worked out for one of them never ends another.
  round: number;
  // Whether this piece of work changed the folder at all, as opencode reported it.
  changed: boolean;
  done: Set<(how: 'done' | 'stopped') => void>;
  // What the coder is doing this moment, for the card's live view (null once the work is over). `parts` remembers
  // which kind each part of the answer is, since opencode's deltas name only the part; `usage` holds the latest word
  // on each answer's tokens, so an answer said three times is counted once. `timer` holds back a burst of deltas.
  live: CoderLive | null; parts: Map<string, 'reasoning' | 'text'>; usage: Map<string, { tokens: CoderLive['tokens']; cost: number }>; timer?: ReturnType<typeof setTimeout>;
};

// How long a working coder may say nothing before it is stopped. A hosted model that has gone quiet is retrying in
// the background and will not come back; a model on this machine is often just reading the prompt on a slow CPU, and
// a 30B one takes minutes over it, so it gets ten.
const QUIET = 90_000;
const LOCAL_QUIET = 10 * 60_000;
const POLL = 5_000;
const KEPT = 500;
const SHOWN = 200;
const MONTH = 30 * 86_400_000;
// A reply streams many deltas a second; the card hears of them at most this often. Anything else is said at once.
const LIVE_EVERY = 80;
const LIVE_TEXT = 8000;
// The one local provider; its address comes from the config (the founder's bridge when it is up, Ollama itself otherwise).
const LOCAL: Record<string, string> = { ollama: 'http://127.0.0.1:11434/v1' };
const FREE = 'Free (OpenCode Zen)';
// The free models that answered with the real opencode on 2026-10-06, steadiest first (Big Pickle is opencode's own
// default). Zen's free list changes every few weeks: a model not named here comes after these, in Zen's own order.
const PREFERRED = ['big-pickle', 'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'mimo-v2.6-flash-free', 'ling-3.1-flash-free'];
// A free model whose provider said it is down is skipped for this long.
const DEAD_FOR = 60 * 60_000;
const KEYED = new Set(KEYS.map(({ id }) => id));
// Models a provider lists that are not for writing code: research agents, speech, pictures, video, guards, filters.
const NOT_A_CODER = /deep-research|tts|embedding|image|veo|imagen|guard|whisper|moderation|audio/i;

const lookedAt = async (url: string) => {
  try { return (await fetch(`${url}/models`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
};
const verb = (ask: CoderAsk) => (ask.tool === 'bash' ? `run ${ask.what}` : ask.tool === 'edit' || ask.tool === 'write' ? `change ${ask.what}` : `${ask.tool} ${ask.what}`.trim());

export function createCoder(deps: Deps) {
  const { engine, say, approvals, attention } = deps;
  const now = deps.now ?? Date.now;
  const reachable = deps.reachable ?? lookedAt;
  const cards = new Map<string, Held>();
  const bySession = new Map<string, string>();
  let swept = false;
  let known: CoderModels | null = null;
  let bases: Record<string, string> = { ...LOCAL };
  // Free models found down, until when. Kept in memory: a restart tries them all again.
  const dead = new Map<string, number>();
  const isDead = (id: string) => (dead.get(id) ?? 0) > now();
  const freeIds = () => known?.groups[0]?.models.map((one) => one.id) ?? [];
  const nextFree = (skip: string[] = []) => freeIds().find((id) => !isDead(id) && !skip.includes(id));
  const pickDefault = () => deps.env.STAGE_CODER_MODEL?.trim() || nextFree() || freeIds()[0] || null;
  // A model as the founder reads it on the card: its name without "Free", which the group already says.
  const nameOf = (id: string) => (known?.groups.flatMap((group) => group.models).find((one) => one.id === id)?.name ?? id.split('/').pop() ?? id).replace(/\s*\(?free\)?$/i, '').trim();

  const held = (cardId: string) => {
    const card = cards.get(cardId);
    if (!card) throw new Error('this coder card has not started yet');
    return card;
  };
  const tell = (card: Held, event: CoderEvent) => say(card.id, event);
  const line = (card: Held, one: Omit<CoderLine, 'at'>) => {
    const full = { ...one, at: now() };
    card.lines = [...card.lines.slice(-(KEPT - 1)), full];
    tell(card, { line: full });
  };
  const setState = (card: Held, state: CoderState) => { if (card.state !== state) { card.state = state; tell(card, { state }); } };
  const busy = (card: Held) => card.state === 'working' || card.state === 'waiting';
  const finish = (card: Held, how: 'done' | 'stopped') => { for (const done of [...card.done]) done(how); card.done.clear(); };

  // The live view, said to the card: at once for a change the founder should see now (a step, a tool, thinking), and
  // at most every LIVE_EVERY ms for the reply growing a few letters at a time.
  // Said as a copy: the card's own view goes on changing under it.
  const copyLive = (live: CoderLive | null) => (live ? { ...live, tools: [...live.tools], tokens: { ...live.tokens } } : null);
  const sayLive = (card: Held, now = false) => {
    if (now) {
      if (card.timer) { clearTimeout(card.timer); card.timer = undefined; }
      tell(card, { live: copyLive(card.live) });
      return;
    }
    if (card.timer) return;
    card.timer = setTimeout(() => { card.timer = undefined; tell(card, { live: copyLive(card.live) }); }, LIVE_EVERY);
  };
  // The work is over, however it ended: nothing is live any more.
  const endLive = (card: Held) => {
    if (card.timer) { clearTimeout(card.timer); card.timer = undefined; }
    card.parts.clear();
    card.usage.clear();
    if (card.live === null) return;
    card.live = null;
    tell(card, { live: null });
  };
  const freshLive = (): CoderLive => ({ since: now(), step: 0, thinking: false, text: '', tools: [], tokens: { input: 0, output: 0, reasoning: 0, cache: 0 }, cost: 0 });
  // One of opencode's words, applied to the live view.
  function hearLive(card: Held, heard: NonNullable<ReturnType<typeof translate>>) {
    const live = card.live;
    if (!live) return;
    let urgent = false;
    let changed = false;
    // opencode echoes the founder's own words as a text part before the coder's first step, and a step is where the
    // coder's answer begins: nothing said before it is the coder writing.
    if (heard.step) { live.step += 1; urgent = true; }
    const spoken = live.step > 0;
    if (heard.opened && spoken) {
      card.parts.set(heard.opened.id, heard.opened.kind);
      // Thinking begins with the part itself: some providers send it whole, with no letters in between.
      if (heard.opened.kind === 'reasoning' && !live.thinking) { live.thinking = true; urgent = true; }
      // A provider that sends the part whole rather than letter by letter: the text so far is in the part itself.
      if (heard.opened.kind === 'text' && heard.opened.text && heard.opened.text.length > live.text.length) { urgent = !live.text; live.text = heard.opened.text.slice(-LIVE_TEXT); changed = true; }
    }
    if (heard.delta && spoken) {
      const kind = card.parts.get(heard.delta.id);
      if (kind === 'reasoning' && !live.thinking) { live.thinking = true; urgent = true; }
      if (kind === 'text' && heard.delta.text) { urgent ||= !live.text; live.text = (live.text + heard.delta.text).slice(-LIVE_TEXT); changed = true; }
    }
    if (heard.closed && spoken) {
      card.parts.delete(heard.closed.id);
      if (heard.closed.kind === 'reasoning' && live.thinking) { live.thinking = false; urgent = true; }
      // The reply's own line lands in the log with this same word.
      if (heard.closed.kind === 'text' && live.text) { live.text = ''; urgent = true; }
    }
    if (heard.running) {
      const at = live.tools.findIndex((one) => one.id === heard.running!.id);
      live.tools = at < 0 ? [...live.tools, heard.running] : live.tools.map((one, index) => (index === at ? heard.running! : one));
      // Output growing under a running command is a stream like the reply's; a new tool is news.
      if (at < 0) urgent = true; else changed = true;
    }
    if (heard.finished && live.tools.some((one) => one.id === heard.finished)) { live.tools = live.tools.filter((one) => one.id !== heard.finished); urgent = true; }
    if (heard.usage) {
      card.usage.set(heard.usage.message, { tokens: heard.usage.tokens, cost: heard.usage.cost });
      const all = [...card.usage.values()];
      live.tokens = { input: 0, output: 0, reasoning: 0, cache: 0 };
      for (const one of all) for (const key of ['input', 'output', 'reasoning', 'cache'] as const) live.tokens[key] += one.tokens[key];
      live.cost = all.reduce((sum, one) => sum + one.cost, 0);
      urgent = true;
    }
    if (urgent) sayLive(card, true);
    else if (changed) sayLive(card);
  }

  // The card as the stage has it now. A new folder is a new conversation: the old session stays in the database.
  function open(card: CoderCard): Held {
    let mine = cards.get(card.id);
    if (!mine) {
      mine = { id: card.id, dir: card.dir, name: card.name, session: card.session || undefined, model: card.model, state: 'idle', lines: [], permissions: [], changed: false, heard: now(), prompted: 0, round: 0, seenBusy: false, reply: '', done: new Set(), live: null, parts: new Map(), usage: new Map() };
      cards.set(card.id, mine);
      if (mine.session) bySession.set(mine.session, card.id);
    }
    if (mine.dir !== card.dir) {
      if (mine.session) bySession.delete(mine.session);
      mine.session = undefined;
      mine.dir = card.dir;
    }
    mine.name = card.name;
    mine.model = card.model || undefined;
    return mine;
  }

  async function newSession(card: Held) {
    const made = await engine.call<{ id: string }>('POST', '/session', { directory: card.dir, body: {} });
    card.session = made.id;
    bySession.set(made.id, card.id);
    tell(card, { session: made.id });
    await deps.remember(card.id, made.id).catch(() => {});
    if (!swept) { swept = true; void sweep().catch(() => {}); }
    return made.id;
  }

  // Sessions nobody has touched in a month go, from the app's own database only.
  async function sweep() {
    const listed = await engine.call<any>('GET', '/experimental/session?limit=1000');
    const all: { id: string; directory?: string; time?: { updated?: number } }[] = Array.isArray(listed) ? listed : listed?.items ?? [];
    for (const one of all) {
      if ((one.time?.updated ?? now()) < now() - MONTH && !bySession.has(one.id)) await engine.call('DELETE', `/session/${one.id}`, { directory: one.directory }).catch(() => {});
    }
  }

  async function models(): Promise<CoderModels> {
    const said = await engine.call<{ providers: { id: string; name?: string; options?: { baseURL?: string }; models: Record<string, { id?: string; name?: string; status?: string; capabilities?: { toolcall?: boolean }; cost?: { input?: number; output?: number } }> }[] }>('GET', '/config/providers');
    const groups = { free: [] as CoderModel[], keys: [] as CoderModel[], local: [] as CoderModel[] };
    for (const provider of said?.providers ?? []) {
      if (provider.options?.baseURL && provider.id in LOCAL) bases = { ...bases, [provider.id]: provider.options.baseURL };
      for (const [key, model] of Object.entries(provider.models ?? {})) {
        // A coder works through tools: a model that cannot call one (speech, a guard model) is no use here.
        if (model.capabilities?.toolcall === false || model.status === 'deprecated') continue;
        if (KEYED.has(provider.id) && (NOT_A_CODER.test(key) || NOT_A_CODER.test(model.name ?? ''))) continue;
        const one: CoderModel = { id: `${provider.id}/${key}`, name: model.name || key };
        const free = !model.cost?.input && !model.cost?.output;
        if (provider.id === 'opencode' && free) groups.free.push(one);
        else if (KEYED.has(provider.id) && (provider.id !== 'openrouter' || key.endsWith(':free'))) groups.keys.push({ ...one, provider: provider.name || provider.id });
        else if (provider.id in LOCAL) groups.local.push(one);
      }
    }
    const rank = (id: string) => { const at = PREFERRED.indexOf(id.slice('opencode/'.length)); return at < 0 ? PREFERRED.length : at; };
    groups.free.sort((one, other) => rank(one.id) - rank(other.id));
    // The same model sold by several providers reads the same: they sit together, each saying whose it is.
    groups.keys.sort((one, other) => one.name.localeCompare(other.name) || (one.provider ?? '').localeCompare(other.provider ?? ''));
    // Two models of one provider with one name are two ids: the end of each id tells them apart.
    for (const list of [groups.keys, groups.local]) {
      const twins = list.filter((one) => list.some((other) => other !== one && other.name === one.name && other.provider === one.provider));
      for (const one of twins) one.name = `${one.name} (${one.id.split('/').slice(1).join('/')})`;
    }
    known = { default: null, groups: [{ name: FREE, models: groups.free }, { name: 'Your keys', models: groups.keys }, { name: 'Local', models: groups.local }] };
    known.default = pickDefault();
    return known;
  }

  async function prompt(card: CoderCard, text: string, { by }: { by?: string }) {
    const mine = open(card);
    if (busy(mine)) throw new Error('the coder is still on the last piece of work. Wait for it, or press Stop on the card');
    if (!mine.model && !known) await models();
    let model = mine.model || pickDefault();
    if (!model) throw new Error('opencode offers no free model right now. The founder picks one on the card, or sets STAGE_CODER_MODEL in .env.');
    line(mine, { kind: 'ask', text: text.trim().slice(0, 4000), ...(by ? { by } : {}) });
    Object.assign(mine, { reply: '', error: undefined, seenBusy: false, changed: false, prompted: now(), heard: now(), ask: text, switched: false, switching: undefined, round: mine.round + 1 });
    // The founder's own pick, found down a moment ago: the next free model takes this ask, and the card says so.
    const instead = isDead(model) ? nextFree([model]) : undefined;
    if (instead) { line(mine, { kind: 'note', text: `${nameOf(model)} was unavailable a moment ago, so ${nameOf(instead)} takes this one` }); model = instead; }
    const [providerID] = model.split('/');
    if (providerID in LOCAL && !(await reachable(bases[providerID]))) {
      const where = bases[providerID].replace(/^https?:\/\//, '').replace(/\/v1$/, '');
      mine.error = `the local model server at ${where} is not answering`;
      line(mine, { kind: 'error', text: `the local model server at ${where} is not answering. Start it, or pick another model.` });
      setState(mine, 'stopped');
      return;
    }
    setState(mine, 'working');
    endLive(mine);
    mine.live = freshLive();
    sayLive(mine, true);
    try {
      await post(mine, model, text);
    } catch (error) {
      couldNotStart(mine, error as Error);
    }
  }

  // One ask handed to one model, in the card's session (a new one when it has none).
  async function post(card: Held, model: string, text: string, sending?: () => void) {
    const [providerID, ...rest] = model.split('/');
    const hint = await withMap(card);
    const body = { model: { providerID, modelID: rest.join('/') }, parts: [{ type: 'text', text }], ...(hint ? { system: hint } : {}) };
    const session = card.session ?? await newSession(card);
    card.using = model;
    sending?.();
    await engine.call('POST', `/session/${session}/prompt_async`, { directory: card.dir, body }).catch(async (error: Error) => {
      // A session the database no longer holds (a wiped workspace, a month gone) is started again, once.
      if (!/\b404\b/.test(error.message)) throw error;
      await engine.call('POST', `/session/${await newSession(card)}/prompt_async`, { directory: card.dir, body });
    });
  }

  function couldNotStart(card: Held, error: Error) {
    card.switching = undefined;
    card.error = error.message;
    line(card, { kind: 'error', text: `the coder could not start: ${card.error}` });
    endLive(card);
    setState(card, 'stopped');
    finish(card, 'stopped');
  }

  // The model's provider says it is down. A free model is set aside for an hour and the same ask goes to the next free
  // one, once, with a line saying so; anything else (a keyed model, the second free model down too) ends the work now
  // in plain words, rather than after opencode's minute and more of retrying a model that will not answer.
  async function fallBack(card: Held, why: string) {
    const from = card.using!;
    card.switching = 'aborting';
    if (!known) await models().catch(() => null);
    const free = freeIds().includes(from);
    if (free) dead.set(from, now() + DEAD_FOR);
    const next = free && !card.switched ? nextFree([from]) : undefined;
    if (card.session) {
      await engine.call('POST', `/session/${card.session}/abort`, { directory: card.dir }).catch(() => {});
      // The old model's run is over only when opencode stops listing it as busy; its last words come before that, and
      // the next model's ask goes in after, so none of them is taken for the new one's.
      for (let tries = 0; tries < 30; tries += 1) {
        const status = await engine.call<Record<string, unknown>>('GET', '/session/status', { directory: card.dir }).catch(() => null);
        if (!status || !(card.session in status)) break;
        await new Promise((settle) => setTimeout(settle, 100));
      }
    }
    if (!busy(card)) { card.switching = undefined; return; }
    if (!next) {
      card.switching = undefined;
      card.error = `${nameOf(from)} is not answering right now: ${why.replace(/[.\s]*$/, '.')} Pick another model on the card.`;
      line(card, { kind: 'error', text: card.error });
      endLive(card);
      setState(card, 'stopped');
      finish(card, 'stopped');
      return;
    }
    card.switched = true;
    line(card, { kind: 'note', text: `${nameOf(from)} is unavailable, trying ${nameOf(next)}` });
    Object.assign(card, { reply: '', error: undefined, seenBusy: false, changed: false, prompted: now(), heard: now(), round: card.round + 1 });
    card.parts.clear();
    card.usage.clear();
    card.live = freshLive();
    sayLive(card, true);
    try {
      await post(card, next, card.ask ?? '', () => { card.switching = 'sent'; });
    } catch (error) {
      couldNotStart(card, error as Error);
    }
  }

  // A folder with a map: Graphify's tool server is added to the folder's own instance, once, and the coder is told.
  // Anything wrong with it is said on the card, and the work goes ahead without the map.
  async function withMap(card: Held): Promise<string | undefined> {
    const map = await deps.map?.(card.dir).catch(() => null);
    if (!map) return undefined;
    try {
      const now = await engine.call<McpStatus>('GET', '/mcp', { directory: card.dir });
      if (now?.[MCP_NAME]?.status !== 'connected') {
        const added = await engine.call<McpStatus>('POST', '/mcp', { directory: card.dir, body: { name: MCP_NAME, config: map.mcp } });
        if (added?.[MCP_NAME]?.status !== 'connected') throw new Error(added?.[MCP_NAME]?.error ?? 'it did not start');
      }
      return map.hint;
    } catch (error) {
      line(card, { kind: 'note', text: `the folder's map could not be handed to the coder (${(error as Error).message.slice(0, 160)}); it reads the files instead` });
      return undefined;
    }
  }

  // Until the work is over, the founder stops it, or the cap. The event stream says when it is over; a look at the
  // server's own list every few seconds covers a stream that dropped on the way.
  function wait(cardId: string, { cap = 10 * 60_000, signal }: { cap?: number; signal?: AbortSignal } = {}): Promise<'done' | 'stopped' | 'cap'> {
    const card = held(cardId);
    if (!busy(card)) return Promise.resolve(card.state === 'stopped' ? 'stopped' : 'done');
    return new Promise((settle) => {
      const end = (how: 'done' | 'stopped' | 'cap') => { clearTimeout(timer); clearInterval(poll); card.done.delete(end); signal?.removeEventListener('abort', aborted); settle(how); };
      const aborted = () => { void stop(cardId, 'by you').finally(() => end('stopped')); };
      const timer = setTimeout(() => end('cap'), cap);
      const poll = setInterval(() => { void look(card); }, POLL);
      card.done.add(end);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }

  async function look(card: Held) {
    if (card.state !== 'working' || !card.session || (!card.seenBusy && now() - card.prompted < 2 * POLL)) return;
    const status = await engine.call<Record<string, unknown>>('GET', '/session/status', { directory: card.dir }).catch(() => null);
    if (status && !(card.session in status)) await idle(card);
  }

  async function diff(card: Held): Promise<CoderPatch[]> {
    if (!card.session) return [];
    const own = await engine.call<CoderPatch[]>('GET', `/session/${card.session}/diff`, { directory: card.dir }).catch(() => []);
    if (own?.length) return own;
    // A change made by a command rather than an edit is not in the session's own diff; the folder's is. It is only
    // read when opencode said this work changed something: otherwise it is the founder's own uncommitted work.
    if (!card.changed) return [];
    return (await engine.call<CoderPatch[]>('GET', '/vcs/diff?mode=git', { directory: card.dir }).catch(() => [])) ?? [];
  }

  async function idle(card: Held) {
    if (card.state !== 'working' || card.switching === 'aborting') return;
    card.switching = undefined;
    const round = card.round;
    const files = await diff(card);
    const text = files.length ? diffLine(files) : '';
    // opencode says idle twice, so two of these can be on their way: the first ends the ask, and the second, coming
    // back from its diff after the next ask went in, must not end that one too.
    if (card.state !== 'working' || card.round !== round) return;
    if (text && card.lines.findLast((one) => one.kind === 'diff' || one.kind === 'ask')?.text !== text) line(card, { kind: 'diff', text });
    endLive(card);
    setState(card, card.error ? 'stopped' : 'idle');
    finish(card, card.error ? 'stopped' : 'done');
  }

  // What the card shows of its questions: the first one, and how many wait behind it.
  const shown = (card: Held): CoderEvent => ({ permission: card.permissions[0] ?? null, waiting: Math.max(0, card.permissions.length - 1) });

  // A question from the coder: on the card, in "Needs you", and held in the one book every approval waits in, so the
  // safety net's timeout and the founder's answer anywhere reach it the same way. Each one is its own entry, raised
  // the moment it arrives, however many are already waiting.
  async function asked(card: Held, ask: CoderAsk) {
    card.permissions = [...card.permissions, ask];
    setState(card, 'waiting');
    tell(card, shown(card));
    const key = `coder:${ask.id}`;
    const question = `Allow the coder to ${verb(ask)}?`;
    // A "Needs you" list that cannot be written to is no reason to stop: the question is on the card as well.
    const book = { raise: (entry: Attention) => attention.raise(entry).catch(() => {}), clear: (id: string) => attention.clear(id).catch(() => {}) };
    const answer = await askFounder(book, approvals, { id: key, kind: 'approval', title: question, at: now(), cardId: card.id, who: `The ${card.name} coder`, coder: ask, event: { id: key, name: 'coder_permission', args: { [ask.tool === 'bash' ? 'command' : 'file']: ask.what }, waiting: true, question } });
    if (!card.permissions.some((one) => one.id === ask.id)) return;
    const reply = !answer.ok ? 'reject' : answer.args?.reply === 'always' ? 'always' : 'once';
    const message = typeof answer.args?.message === 'string' ? answer.args.message.trim().slice(0, 500) : '';
    settled(card, ask, reply === 'reject' ? `said no · ${ask.tool} ${ask.what}${message ? ` — ${message}` : ''}` : reply === 'always' ? `allowed for good · ${ask.always.join(', ') || ask.what}` : `allowed · ${ask.tool} ${ask.what}`);
    await engine.call('POST', `/permission/${ask.id}/reply`, { directory: card.dir, body: { reply, ...(message && reply === 'reject' ? { message } : {}) } })
      .catch((error: Error) => line(card, { kind: 'error', text: `the answer did not reach the coder: ${error.message}` }));
  }
  // One question answered, by its own id. The card goes back to working only once none is left, and the watchdog
  // counts from here: time spent waiting for the founder is never the coder going quiet.
  function settled(card: Held, ask: CoderAsk, said: string) {
    card.permissions = card.permissions.filter((one) => one.id !== ask.id);
    card.heard = now();
    line(card, { kind: 'note', text: said });
    tell(card, shown(card));
    if (card.state === 'waiting' && !card.permissions.length) setState(card, 'working');
    void attention.clear(`coder:${ask.id}`).catch(() => {});
  }
  // Every question still waiting, answered no in one go (Stop, the server gone): each settled by its own id and let
  // out of the book, so nothing is left for anybody to answer.
  function refuseAll(card: Held, said: (ask: CoderAsk) => string) {
    for (const ask of [...card.permissions]) { settled(card, ask, said(ask)); approvals.answer(`coder:${ask.id}`, { ok: false }); }
  }

  function hear(event: RawEvent) {
    if (event.type === GONE) {
      for (const card of cards.values()) {
        if (!busy(card)) continue;
        refuseAll(card, (ask) => `the question about ${ask.tool} ${ask.what} went with it`);
        card.error = 'stopped';
        line(card, { kind: 'error', text: 'the coder\'s server stopped; the next task starts it again' });
        endLive(card);
        setState(card, 'stopped');
        finish(card, 'stopped');
      }
      return;
    }
    const cardId = bySession.get(String(event.properties?.sessionID ?? event.properties?.part?.sessionID ?? event.properties?.info?.sessionID ?? ''));
    const card = cardId ? cards.get(cardId) : undefined;
    if (!card) return;
    const heard = translate(event, card.dir);
    if (!heard) return;
    // A model being left behind: its refusals and the idle after the abort are not news. The next model being busy is.
    if (card.switching === 'aborting' && (heard.idle || heard.error || heard.retry)) return;
    if (card.switching === 'sent') {
      if (heard.idle) return;
      if (heard.busy) card.switching = undefined;
    }
    // A model that is down: said at opencode's first retry, a second or two in, rather than after all of them.
    const trouble = heard.retry ?? heard.error;
    if (trouble && busy(card) && card.using && !card.switching && modelDown(trouble)) { void fallBack(card, trouble); return; }
    if (heard.progress) card.heard = now();
    if (heard.changed) card.changed = true;
    // Busy only counts while the card is waiting on it: opencode says busy once more after an error or a stop, and
    // that must not bring back a spinner for work that is over.
    if (heard.busy) { card.seenBusy = true; card.heard = now(); }
    if (heard.line?.kind === 'reply') card.reply = heard.line.text;
    // A diff only means something while work is on: opencode says one after an undo too, and that would sit under
    // "undone" claiming the change is still there.
    if (heard.line && (heard.line.kind !== 'diff' || busy(card))) line(card, heard.line);
    if (busy(card)) hearLive(card, heard);
    if (heard.permission) void asked(card, heard.permission);
    // Answered without a word from here: opencode refuses every other question in a session when one is refused, and
    // lets through the ones an "always" now covers; or somebody answered on opencode's own screen. The question goes,
    // by its id, and nothing is sent twice.
    const replied = heard.replied ? card.permissions.find((one) => one.id === heard.replied) : undefined;
    if (replied) {
      settled(card, replied, heard.reply === 'reject' ? `said no · ${replied.tool} ${replied.what}` : `allowed · ${replied.tool} ${replied.what}`);
      approvals.answer(`coder:${replied.id}`, { ok: false });
    }
    // An error ends the work: opencode would otherwise go on retrying a request that cannot succeed (too large for a
    // free tier, a key refused) while the card and the person wait for nothing.
    if (heard.error) {
      card.error = heard.error;
      if (busy(card)) {
        endLive(card);
        setState(card, 'stopped');
        finish(card, 'stopped');
        if (card.session) void engine.call('POST', `/session/${card.session}/abort`, { directory: card.dir }).catch(() => {});
      }
    }
    // opencode says idle twice at the end of a run (its status, then the event of its own), and the second can land
    // on the next ask, sent the moment the first one ended. Idle counts once this ask has been busy; a stream that
    // dropped the busy is covered by the look at the server's list.
    if (heard.idle && card.seenBusy) void idle(card);
  }
  engine.listen(hear);

  // One line for whoever asks how the work goes: the step running now, or the thinking, or the reply being written.
  function nowDoing(card: Held) {
    const live = card.live;
    if (!live || !busy(card)) return '';
    const tool = live.tools.at(-1);
    if (tool) return `Now: running ${`${tool.tool} ${tool.what}`.trim()} (${Math.max(0, Math.round((now() - tool.since) / 1000))} s)`;
    if (live.thinking) return 'Now: thinking';
    if (live.text) return 'Now: writing its reply';
    return '';
  }

  async function stop(cardId: string, why = 'by you') {
    const card = held(cardId);
    refuseAll(card, (ask) => `said no · ${ask.tool} ${ask.what} — stopped`);
    // Said and settled before the abort goes out: opencode answers an abort with "idle", and that must not read as done.
    card.error = 'stopped';
    card.switching = undefined;
    line(card, { kind: 'note', text: `stopped · ${why}` });
    endLive(card);
    setState(card, 'stopped');
    finish(card, 'stopped');
    if (card.session) await engine.call('POST', `/session/${card.session}/abort`, { directory: card.dir }).catch(() => {});
  }

  return {
    open, prompt, wait, models, hear, stop,
    // A line the app itself writes on a card's log: a map being made, for one.
    note(card: CoderCard, one: Omit<CoderLine, 'at'>) { line(open(card), one); },
    patches: (cardId: string) => diff(held(cardId)),
    snapshot(cardId: string) {
      const card = cards.get(cardId);
      return { lines: card?.lines.slice(-SHOWN) ?? [], state: card?.state ?? 'idle' as CoderState, permission: card?.permissions[0], waiting: Math.max(0, (card?.permissions.length ?? 0) - 1), session: card?.session, model: card?.model, live: copyLive(card?.live ?? null) };
    },
    cards: () => [...cards.values()].map((card) => ({ id: card.id, dir: card.dir })),

    // What a person reads when the work is over: the coder's last words and what changed in the folder.
    async result(cardId: string) {
      const card = held(cardId);
      const files = await diff(card);
      const changed = files.length ? `Changed: ${diffLine(files)} (${files.slice(0, 20).map((one) => one.file).join(', ')})` : 'No files changed.';
      return `${card.reply || 'The coder finished without a closing note.'}\n\n${changed}`;
    },
    async status(cardId: string) {
      const card = cards.get(cardId);
      if (!card) return 'The coder has not been asked anything yet.';
      const files = await diff(card);
      const log = card.lines.slice(-20).map((one) => `${one.kind === 'reply' ? '»' : one.kind === 'ask' ? '→' : '·'} ${one.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
      const doing = nowDoing(card);
      return `State: ${card.state === 'waiting' ? 'waiting for the founder' : card.state}${doing ? `\n${doing}` : ''}\n${log || '(nothing yet)'}\n\n${files.length ? `Changed so far: ${diffLine(files)}` : 'No files changed.'}`;
    },

    // The founder's answer from the card itself: the same book the needs list answers in.
    async answer(cardId: string, permissionId: string, reply: 'once' | 'always' | 'reject', message?: string) {
      const card = held(cardId);
      if (!card.permissions.some((one) => one.id === permissionId)) throw new Error('that question is not waiting any more');
      approvals.answer(`coder:${permissionId}`, { ok: reply !== 'reject', args: { reply, ...(message ? { message } : {}) } });
      await new Promise((settle) => setImmediate(settle));
    },

    // Undo last: the coder's own snapshot puts the folder back to before the last thing it was asked.
    async undo(cardId: string) {
      const card = held(cardId);
      if (busy(card)) throw new Error('the coder is still working. Stop it first');
      if (!card.session) throw new Error('there is nothing to undo yet');
      const [info, messages] = await Promise.all([
        engine.call<{ revert?: { messageID?: string } }>('GET', `/session/${card.session}`, { directory: card.dir }),
        engine.call<{ info: { id: string; role: string }; parts: { type: string; text?: string }[] }[]>('GET', `/session/${card.session}/message`, { directory: card.dir }),
      ]);
      const upTo = info?.revert?.messageID ? messages.findIndex((one) => one.info.id === info.revert!.messageID) : messages.length;
      const last = messages.slice(0, upTo < 0 ? messages.length : upTo).findLast((one) => one.info.role === 'user');
      if (!last) throw new Error('there is nothing left to undo');
      await engine.call('POST', `/session/${card.session}/revert`, { directory: card.dir, body: { messageID: last.info.id } });
      const said = last.parts.find((one) => one.type === 'text')?.text?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? '';
      line(card, { kind: 'note', text: `undone · "${said}"` });
      endLive(card);
      setState(card, 'idle');
    },

    // A clean slate. The old conversation stays in the coder's database; the card simply stops pointing at it.
    async fresh(cardId: string) {
      const card = held(cardId);
      if (busy(card)) throw new Error('the coder is still working. Stop it first');
      if (card.session) bySession.delete(card.session);
      card.session = undefined;
      tell(card, { session: '' });
      await deps.remember(card.id, '').catch(() => {});
      line(card, { kind: 'note', text: 'new session · the coder starts from a clean slate' });
      setState(card, 'idle');
    },

    // The half-minute look: a session gone quiet is stopped, and a server grown too big is started afresh when idle.
    async tick() {
      for (const card of cards.values()) {
        if (card.state !== 'working') continue;
        const local = (card.model ?? '').split('/')[0] in LOCAL;
        if (now() - card.heard > (local ? LOCAL_QUIET : QUIET)) await stop(card.id, local ? 'no progress for 10 minutes (the local model is stuck, or too slow for this machine)' : 'no progress for 90 s (the model went quiet)');
      }
      const health = engine.health();
      if (health.running && health.rss && needsRestart(health.rss, [...cards.values()].some(busy))) await engine.restart();
    },

    // A card taken off the stage lets its folder go in the coder too.
    async forget(keep: Set<string>) {
      for (const card of [...cards.values()]) {
        if (keep.has(card.id)) continue;
        if (busy(card)) await stop(card.id, 'the card was removed').catch(() => {});
        cards.delete(card.id);
        if (card.session) bySession.delete(card.session);
        if (engine.health().running && ![...cards.values()].some((other) => other.dir === card.dir)) await engine.call('POST', '/instance/dispose', { directory: card.dir }).catch(() => {});
      }
    },
  };
}
export type Coder = ReturnType<typeof createCoder>;
