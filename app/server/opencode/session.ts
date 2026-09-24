import { diffLine, type CoderAsk, type CoderEvent, type CoderLine, type CoderModels, type CoderPatch, type CoderState } from '../../shared/coder.ts';
import type { Attention } from '../../shared/model.ts';
import type { Answer } from '../approvals.ts';
import { translate, type RawEvent } from './events.ts';
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
};
type Held = {
  id: string; dir: string; name: string; session?: string; model?: string;
  state: CoderState; lines: CoderLine[]; permission?: CoderAsk;
  heard: number; prompted: number; seenBusy: boolean; reply: string; error?: string;
  done: Set<(how: 'done' | 'stopped') => void>;
};

const QUIET = 90_000;
const POLL = 5_000;
const KEPT = 500;
const SHOWN = 200;
const MONTH = 30 * 86_400_000;
const LOCAL: Record<string, string> = { ollama: 'http://127.0.0.1:11434/v1', 'ollama-bridge': 'http://127.0.0.1:11435/v1' };
const FREE = 'Free (OpenCode Zen)';
const KEYED = new Set(['groq', 'google', 'openrouter']);

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

  // The card as the stage has it now. A new folder is a new conversation: the old session stays in the database.
  function open(card: CoderCard): Held {
    let mine = cards.get(card.id);
    if (!mine) {
      mine = { id: card.id, dir: card.dir, name: card.name, session: card.session || undefined, model: card.model, state: 'idle', lines: [], heard: now(), prompted: 0, seenBusy: false, reply: '', done: new Set() };
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
    const said = await engine.call<{ providers: { id: string; name?: string; options?: { baseURL?: string }; models: Record<string, { id?: string; name?: string; cost?: { input?: number; output?: number } }> }[] }>('GET', '/config/providers');
    const groups = { free: [] as { id: string; name: string }[], keys: [] as { id: string; name: string }[], local: [] as { id: string; name: string }[] };
    for (const provider of said?.providers ?? []) {
      if (provider.options?.baseURL && provider.id in LOCAL) bases = { ...bases, [provider.id]: provider.options.baseURL };
      for (const [key, model] of Object.entries(provider.models ?? {})) {
        const one = { id: `${provider.id}/${key}`, name: model.name || key };
        const free = !model.cost?.input && !model.cost?.output;
        if (provider.id === 'opencode' && free) groups.free.push(one);
        else if (KEYED.has(provider.id) && (provider.id !== 'openrouter' || key.endsWith(':free'))) groups.keys.push(one);
        else if (provider.id in LOCAL) groups.local.push(one);
      }
    }
    const byName = (one: { name: string }, other: { name: string }) => one.name.localeCompare(other.name);
    groups.keys.sort(byName);
    known = {
      default: deps.env.STAGE_CODER_MODEL?.trim() || groups.free[0]?.id || null,
      groups: [{ name: FREE, models: groups.free }, { name: 'Your keys', models: groups.keys }, { name: 'Local', models: groups.local }],
    };
    return known;
  }

  async function prompt(card: CoderCard, text: string, { by }: { by?: string }) {
    const mine = open(card);
    if (busy(mine)) throw new Error('the coder is still on the last piece of work. Wait for it, or press Stop on the card');
    const model = mine.model || (known ?? await models()).default;
    if (!model) throw new Error('opencode offers no free model right now. The founder picks one on the card, or sets STAGE_CODER_MODEL in .env.');
    const [providerID, ...rest] = model.split('/');
    line(mine, { kind: 'ask', text: text.trim().slice(0, 4000), ...(by ? { by } : {}) });
    Object.assign(mine, { reply: '', error: undefined, seenBusy: false, prompted: now(), heard: now() });
    if (providerID in LOCAL && !(await reachable(bases[providerID]))) {
      const where = bases[providerID].replace(/^https?:\/\//, '').replace(/\/v1$/, '');
      mine.error = `the local model server at ${where} is not answering`;
      line(mine, { kind: 'error', text: `the local model server at ${where} is not answering. Start it, or pick another model.` });
      setState(mine, 'stopped');
      return;
    }
    setState(mine, 'working');
    const body = { model: { providerID, modelID: rest.join('/') }, parts: [{ type: 'text', text }] };
    try {
      const session = mine.session ?? await newSession(mine);
      await engine.call('POST', `/session/${session}/prompt_async`, { directory: mine.dir, body }).catch(async (error: Error) => {
        // A session the database no longer holds (a wiped workspace, a month gone) is started again, once.
        if (!/\b404\b/.test(error.message)) throw error;
        await engine.call('POST', `/session/${await newSession(mine)}/prompt_async`, { directory: mine.dir, body });
      });
    } catch (error) {
      mine.error = (error as Error).message;
      line(mine, { kind: 'error', text: `the coder could not start: ${mine.error}` });
      setState(mine, 'stopped');
      finish(mine, 'stopped');
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
    // A change made by a command rather than an edit is not in the session's own diff; the folder's is.
    return (await engine.call<CoderPatch[]>('GET', '/vcs/diff?mode=git', { directory: card.dir }).catch(() => [])) ?? [];
  }

  async function idle(card: Held) {
    if (card.state !== 'working') return;
    const files = await diff(card);
    const text = files.length ? diffLine(files) : '';
    if (card.state !== 'working') return;
    if (text && card.lines.findLast((one) => one.kind === 'diff' || one.kind === 'ask')?.text !== text) line(card, { kind: 'diff', text });
    setState(card, card.error ? 'stopped' : 'idle');
    finish(card, card.error ? 'stopped' : 'done');
  }

  // A question from the coder: on the card, in "Needs you", and held in the one book every approval waits in, so the
  // safety net's timeout and the founder's answer anywhere reach it the same way.
  async function asked(card: Held, ask: CoderAsk) {
    card.permission = ask;
    setState(card, 'waiting');
    tell(card, { permission: ask });
    const key = `coder:${ask.id}`;
    const question = `Allow the coder to ${verb(ask)}?`;
    await attention.raise({ id: key, kind: 'approval', title: question, at: now(), cardId: card.id, who: `The ${card.name} coder`, coder: ask, event: { id: key, name: 'coder_permission', args: { [ask.tool === 'bash' ? 'command' : 'file']: ask.what }, waiting: true, question } }).catch(() => {});
    const answer = await approvals.ask(key);
    if (card.permission?.id !== ask.id) return;
    const reply = !answer.ok ? 'reject' : answer.args?.reply === 'always' ? 'always' : 'once';
    const message = typeof answer.args?.message === 'string' ? answer.args.message.trim().slice(0, 500) : '';
    settled(card, ask, reply === 'reject' ? `said no · ${ask.tool} ${ask.what}${message ? ` — ${message}` : ''}` : reply === 'always' ? `allowed for good · ${ask.always.join(', ') || ask.what}` : `allowed · ${ask.tool} ${ask.what}`);
    await engine.call('POST', `/permission/${ask.id}/reply`, { directory: card.dir, body: { reply, ...(message && reply === 'reject' ? { message } : {}) } })
      .catch((error: Error) => line(card, { kind: 'error', text: `the answer did not reach the coder: ${error.message}` }));
  }
  function settled(card: Held, ask: CoderAsk, said: string) {
    card.permission = undefined;
    card.heard = now();
    line(card, { kind: 'note', text: said });
    tell(card, { permission: null });
    if (card.state === 'waiting') setState(card, 'working');
    void attention.clear(`coder:${ask.id}`).catch(() => {});
  }

  function hear(event: RawEvent) {
    if (event.type === GONE) {
      for (const card of cards.values()) {
        if (!busy(card)) continue;
        if (card.permission) { const ask = card.permission; settled(card, ask, `the question about ${ask.tool} ${ask.what} went with it`); approvals.answer(`coder:${ask.id}`, { ok: false }); }
        card.error = 'stopped';
        line(card, { kind: 'error', text: 'the coder\'s server stopped; the next task starts it again' });
        setState(card, 'stopped');
        finish(card, 'stopped');
      }
      return;
    }
    const cardId = bySession.get(String(event.properties?.sessionID ?? event.properties?.part?.sessionID ?? ''));
    const card = cardId ? cards.get(cardId) : undefined;
    if (!card) return;
    const heard = translate(event, card.dir);
    if (!heard) return;
    if (heard.progress) card.heard = now();
    if (heard.busy) { card.seenBusy = true; card.heard = now(); if (!busy(card)) setState(card, 'working'); }
    if (heard.line?.kind === 'reply') card.reply = heard.line.text;
    if (heard.line) line(card, heard.line);
    if (heard.permission) void asked(card, heard.permission);
    // Answered somewhere else (another window, opencode's own screen): the question goes, and nothing is sent twice.
    if (heard.replied && card.permission?.id === heard.replied) {
      const ask = card.permission;
      settled(card, ask, `answered elsewhere · ${ask.tool} ${ask.what}`);
      approvals.answer(`coder:${ask.id}`, { ok: false });
    }
    if (heard.error) {
      card.error = heard.error;
      if (busy(card)) { setState(card, 'stopped'); finish(card, 'stopped'); }
    }
    if (heard.idle) void idle(card);
  }
  engine.listen(hear);

  async function stop(cardId: string, why = 'by you') {
    const card = held(cardId);
    if (card.permission) { const ask = card.permission; settled(card, ask, `said no · ${ask.tool} ${ask.what} — stopped`); approvals.answer(`coder:${ask.id}`, { ok: false }); }
    // Said and settled before the abort goes out: opencode answers an abort with "idle", and that must not read as done.
    card.error = 'stopped';
    line(card, { kind: 'note', text: `stopped · ${why}` });
    setState(card, 'stopped');
    finish(card, 'stopped');
    if (card.session) await engine.call('POST', `/session/${card.session}/abort`, { directory: card.dir }).catch(() => {});
  }

  return {
    open, prompt, wait, models, hear, stop,
    patches: (cardId: string) => diff(held(cardId)),
    snapshot(cardId: string) {
      const card = cards.get(cardId);
      return { lines: card?.lines.slice(-SHOWN) ?? [], state: card?.state ?? 'idle' as CoderState, permission: card?.permission, session: card?.session, model: card?.model };
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
      return `State: ${card.state === 'waiting' ? 'waiting for the founder' : card.state}\n${log || '(nothing yet)'}\n\n${files.length ? `Changed so far: ${diffLine(files)}` : 'No files changed.'}`;
    },

    // The founder's answer from the card itself: the same book the needs list answers in.
    async answer(cardId: string, permissionId: string, reply: 'once' | 'always' | 'reject', message?: string) {
      const card = held(cardId);
      if (card.permission?.id !== permissionId) throw new Error('that question is not waiting any more');
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
      for (const card of cards.values()) if (card.state === 'working' && now() - card.heard > QUIET) await stop(card.id, 'no progress for 90 s (the free model went quiet)');
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
