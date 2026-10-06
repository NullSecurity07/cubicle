import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lapsed } from '../shared/lapsed.ts';
import type { Attention, AttentionKind, Decision, ToolEvent } from '../shared/model.ts';
import { planTaskTitle, stepText, type Bet, type PlanProposal } from '../shared/partner.ts';
import type { Boards } from './boards.ts';
import type { Damage, Store } from './store.ts';
import { localDay, now as clockNow } from './clock.ts';
import { PROVIDERS } from './keys-file/catalogue.ts';
import { ENTRIES } from './providers.ts';
import type { KeyEvent, UsageBook } from './usage.ts';
import { PLANLESS, UNPAID } from './breaker.ts';
import { readBook } from './rescue.ts';

export type AttentionBook = ReturnType<typeof createAttention>;
type Source = () => Promise<Attention[]>;
// Which of the rows on the list are already done where they live, by id, so they are left off it.
type Settle = (list: Attention[]) => Promise<Set<string>>;
// What the founder may wave away. A proposal or an approval is answered where it lives, never dismissed here.
const DISMISSABLE = new Set<AttentionKind>(['run-failed', 'missed', 'review-due', 'page-changed']);
// What is raised here only to tell the founder something, with no answer to wait for: they may wave it away once read.
const SAID = new Set<AttentionKind>(['key-rejected', 'file-damaged', 'backup-failed', 'mail-draft']);
const A_DAY = 86_400_000;
// Argument names whose value is nobody's to keep, not even for a line the founder reads.
const PRIVATE = /key|token|secret|password/i;

// The call an approval was cut off from, in a few plain words: the tool as the founder would say it, then its first
// couple of arguments, each cut short. Enough to know what was asked, small enough to keep once the turn is gone.
const about = (event: ToolEvent) => [event.name.replace(/_/g, ' '), ...Object.entries(event.args ?? {})
  .filter(([key, value]) => !PRIVATE.test(key) && (typeof value === 'string' || typeof value === 'number'))
  .slice(0, 2)
  .map(([key, value]) => `${key} ${String(value).replace(/\s+/g, ' ').slice(0, 60)}`)].join(', ');

// Everything that waits for the founder, as one list. Most of it is read fresh from where it lives (boards, decisions)
// through `source`, so the list cannot drift from the truth. Only two things are kept here: approvals in flight, so
// that one cut off by the app closing is still shown (as lapsed), and what the founder dismissed.
export function createAttention(dir: string, now: () => number = clockNow) {
  const path = join(dir, 'attention.json');
  const sources: Source[] = [];
  const settles: Settle[] = [];
  const watchers = new Set<(list: Attention[]) => void>();
  let queue: Promise<unknown> = Promise.resolve();
  let state: { open: Lapsed[]; dismissed: string[] } | null = null;

  // Read once, however many ask at the same moment: two first readers each making their own copy meant whatever was
  // raised into the first copy was gone when the second one replaced it.
  let reading: Promise<{ open: Lapsed[]; dismissed: string[] }> | null = null;
  const load = () => (reading ??= read());
  async function read() {
    let saved: { open?: Lapsed[]; dismissed?: string[] } = {};
    // No file is nothing waiting; a damaged one is rescued, never read as nothing and saved over.
    try { saved = (await readBook<typeof saved>(path, dir, { empty: { open: [], dismissed: [] }, what: { thing: 'The Needs you file', again: 'Needs you started again', first: 'what you had dismissed may show again' } })) ?? {}; } catch { /* unreadable: nothing waited */ }
    // Whatever was waiting when the app last closed belonged to a turn that no longer exists. The event goes, but what
    // it was for stays, so the app can say what the founder was asked and know it when the same thing is done again.
    // (A task run that was waiting is reported by its board as cut off; keeping it here too would show it twice. A
    // refused key goes too: keys are read on a start, so this start has not yet been refused by anyone.)
    // A damaged file is no turn's: it stays as it was until the founder dismisses it. So is a drafted email, which
    // waits in Gmail whatever the app does, until the founder opens it or waves it away.
    // A failed backup goes too: the next start tries again within the minute and says so again if it fails.
    state = { open: (saved.open ?? []).filter((entry) => entry.kind !== 'run-approval' && entry.kind !== 'key-rejected' && entry.kind !== 'backup-failed').map(({ event, ...entry }) => (entry.kind === 'file-damaged' || entry.kind === 'mail-draft' ? entry : { ...entry, ...(event ? { tool: event.name, about: about(event) } : {}), lapsed: true })), dismissed: saved.dismissed ?? [] };
    return state;
  }
  async function list(): Promise<Attention[]> {
    const { open, dismissed } = await load();
    // Nothing waits for ever. An approval that lapsed a day ago is about a turn the founder has long walked past, so
    // reading the list is also where it is let go, and the file is written again without it.
    const held = open.filter((entry) => !entry.lapsed || now() - entry.at < A_DAY);
    if (held.length !== open.length) { state!.open = held; await changed(); }
    const reported = (await Promise.all(sources.map((source) => source().catch(() => [])))).flat().filter((entry) => !dismissed.includes(entry.id));
    // A question whose answer is already given somewhere else (the tasks on the board, the bet taken, the decision on
    // record) is not asked again: every reader of this list, the partner's advice included, sees it gone at once.
    const done = new Set((await Promise.all(settles.map((settle) => settle(reported).catch(() => new Set<string>())))).flatMap((ids) => [...ids]));
    return [...reported.filter((entry) => !done.has(entry.id)), ...held].sort((a, b) => b.at - a.at);
  }
  async function changed() {
    const { open, dismissed } = await load();
    const text = JSON.stringify({ open, dismissed: dismissed.slice(-500) }, null, 2);
    queue = queue.then(async () => { await mkdir(dir, { recursive: true }); await writeFile(`${path}.tmp`, text); await rename(`${path}.tmp`, path); }).catch(() => {});
    const now = await list();
    for (const tell of watchers) tell(now);
  }

  return {
    list,
    settled: () => queue,
    source(source: Source) { sources.push(source); },
    settle(settle: Settle) { settles.push(settle); },
    // Something a source reports has changed (a board, a decision): tell whoever watches.
    async refresh() { const now = await list(); for (const tell of watchers) tell(now); },
    async raise(entry: Attention) { const { open } = await load(); state!.open = [...open.filter((one) => one.id !== entry.id), entry]; await changed(); },
    async clear(id: string) { const { open } = await load(); if (!open.some((one) => one.id === id)) return; state!.open = open.filter((one) => one.id !== id); await changed(); },
    async dismiss(id: string) {
      const { open, dismissed } = await load();
      const held = open.find((one) => one.id === id);
      // A refused key waits on nothing but the founder, who may have seen it and moved on; it comes back only if the
      // key is refused again after answering once.
      if (held) { if (!held.lapsed && !SAID.has(held.kind)) throw new Error('this is still waiting for an answer'); state!.open = open.filter((one) => one.id !== id); return changed(); }
      const reported = (await list()).find((one) => one.id === id);
      if (!reported || !DISMISSABLE.has(reported.kind)) throw new Error('this cannot be dismissed; answer it where it lives');
      state!.dismissed = [...dismissed, id];
      await changed();
    },
    watch(tell: (list: Attention[]) => void) { watchers.add(tell); return () => { watchers.delete(tell); }; },
  };
}

const CUT_OFF = 'stopped: the app was closed';

// What the boards hold for the founder: proposals to accept or decline, runs that failed or were cut off, repeats that were missed.
export const boardAttention = (store: Store, boards: Boards) => async (): Promise<Attention[]> => {
  const stage = await store.loadStage();
  const nameOf = (roomId?: string) => stage.rooms.find((room) => room.id === roomId)?.name;
  const found: Attention[] = [];
  for (const card of stage.cards ?? []) {
    if (card.kind !== 'board') continue;
    for (const task of await boards.list(card.id)) {
      const where = { cardId: card.id, taskId: task.id, title: task.title };
      if (task.column === 'proposed') found.push({ ...where, id: `proposed:${card.id}:${task.id}`, kind: 'proposed-task', at: task.createdAt, who: task.proposedBy, detail: task.detail.slice(0, 240) || undefined });
      const last = task.run?.log.at(-1) ?? '';
      // A task that could not even start (no such person, a skill switched off, a script that does not parse) waits for
      // the founder as surely as one that failed halfway; a repeat that stays blocked unseen is work that quietly stopped.
      if (task.run?.state === 'blocked') found.push({ ...where, id: `run-failed:${task.id}:${task.run.startedAt}`, kind: 'run-failed', at: task.run.startedAt, who: nameOf(task.assignee), detail: (task.run.result ?? last).replace(/^did not start: /, '') });
      if (task.run?.state === 'failed') found.push({ ...where, id: `run-failed:${task.id}:${task.run.startedAt}`, kind: 'run-failed', at: task.run.finishedAt ?? task.run.startedAt, who: nameOf(task.assignee), detail: last.replace(/^failed: /, '') });
      else if (task.run?.state === 'stopped' && last === CUT_OFF) found.push({ ...where, id: `run-failed:${task.id}:${task.run.startedAt}`, kind: 'run-failed', at: task.run.finishedAt ?? task.run.startedAt, who: nameOf(task.assignee), detail: 'The app closed while this was running. Run it again when you want it.' });
      if (task.missed) found.push({ ...where, id: `missed:${task.id}:${task.nextRun ?? 0}`, kind: 'missed', at: task.createdAt, who: nameOf(task.assignee), detail: 'A repeat fell due while the app was closed. It was not run late.' });
    }
  }
  return found;
};

// A key refused for having no plan, in words the founder can act on: where to turn the free plan on.
export const planlessWords = (keyEnv: string) => `${PLANLESS}: turn on the free plan${PROVIDERS[keyEnv]?.where ? ` at ${PROVIDERS[keyEnv].where}` : ''}`;

// A key the provider refused (401, 403) is one item for the founder, raised once and kept until the key answers again:
// no turn can fix it, only a new key in Keys can. One item a key: one Groq key serves groq, groq-small and groq-qwen,
// so the item is named by the key's variable and number, and any model on that key answering clears it.
// A key the usage book kept as refused across a restart is told again here, so its item is back at once.
export function keyAttention(usage: Pick<UsageBook, 'onKey'> & Partial<Pick<UsageBook, 'refusals'>>, attention: AttentionBook, now: () => number = Date.now) {
  const open = new Set<string>();
  const stop = usage.onKey(hear);
  for (const event of usage.refusals?.() ?? []) hear(event);
  return stop;
  function hear({ name, dead, status, planless, unpaid }: KeyEvent) {
    const [model, number = '1'] = name.split('#');
    const entry = ENTRIES.find((one) => one.name === model);
    const keyEnv = entry?.keyEnv ?? model;
    const id = `key-rejected:${keyEnv}:${number}`;
    if (dead === open.has(id)) return;
    // Named the way the Keys panel names it (NVIDIA_API_KEY is NVIDIA), or after the first model on the key.
    const first = ENTRIES.find((one) => one.keyEnv === keyEnv)?.name ?? model;
    const said = PROVIDERS[keyEnv]?.label ?? first[0].toUpperCase() + first.slice(1);
    const which = number === '1' ? keyEnv : `${keyEnv}_${number}`;
    if (dead) open.add(id); else open.delete(id);
    const where = PROVIDERS[keyEnv]?.where ? ` at ${PROVIDERS[keyEnv].where}` : ' in its console';
    const title = planless ? `${said}'s free plan is not on; turn it on${where}` : unpaid ? `${said} needs a card on file; add one${where} or leave it off` : `${said} key rejected; fix it in Keys`;
    const why = planless ? planlessWords(keyEnv) : unpaid ? `${UNPAID}${where}` : 'the key is wrong, revoked or out of credit';
    void (dead
      ? attention.raise({ id, kind: 'key-rejected', at: now(), title, detail: `${which} was refused (${status ?? 'no status'}): ${why}. Other models answer meanwhile; this goes away the next time it answers.` })
      : attention.clear(id)).catch(() => {});
  }
}

// A file the store could not read and rescued (see `recover` in store.ts), said the way the founder knows it: the
// canvas, a conversation, a person's memory. Where the damaged copy is, so nothing in it is out of reach.
export function damageAttention(damage: Damage, now: number = Date.now()): Attention {
  const room = /^rooms\/(.+?)(\.memory)?\.json$/.exec(damage.file);
  // A side book says how the founder knows it; the stage and a conversation are named here.
  const what = damage.what ?? (!room ? { thing: 'The canvas file', again: 'the canvas started again', first: 'the canvas starts from the first stage; your docs and conversations are untouched' }
    : room[2] ? { thing: 'A person\'s memory file', again: 'their memory started again', first: 'their memory starts empty; the conversation itself is untouched' }
    : { thing: 'A conversation file', again: 'that conversation started again', first: 'that conversation starts empty' });
  const from = damage.from;
  return {
    id: `file-damaged:${damage.file}:${now}`, kind: 'file-damaged', at: now, ...(room ? { roomId: room[1] } : {}),
    title: `${what.thing} was damaged, and ${from ? 'was put back from a backup' : what.again}`,
    detail: from
      ? `${damage.file} could not be read, so it was put back as it was in the backup ${from.file}. Anything changed since then is only in the damaged copy, moved aside to ${damage.aside}, which a text editor can open.`
      : `${damage.file} could not be read and no backup held it, so ${what.first}. The damaged copy was moved aside to ${damage.aside}, which a text editor can open.`,
  };
}

// The daily backup that failed (the drive unplugged, the disk full) is one item for the founder, with the error, raised
// once however many hourly tries fail after it, and cleared by the next backup that is made. Before this, a failure was
// one line in a log nobody reads until the Health row turned red a day later.
export function backupAttention(attention: Pick<AttentionBook, 'raise' | 'clear'>, now: () => number = Date.now) {
  let open = false;
  return async (result: { made?: unknown; problem?: string; where?: string } | null) => {
    if (result?.problem && !open) {
      open = true;
      await attention.raise({ id: 'backup-failed', kind: 'backup-failed', at: now(), title: 'The daily backup failed', detail: `A backup to ${result.where ?? 'the backup folder'} could not be made: ${result.problem}. It is tried again every hour; this goes away when one is made. Check that the drive is plugged in and has room, or choose another folder with "Back up to…" in Health.` });
    } else if (result?.made && open) {
      open = false;
      await attention.clear('backup-failed');
    }
  };
}

// ---------------------------------------------------------------- what is already done

// The same words however they were typed: case, spacing and a closing stop do not make two things different.
const same = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?\u2026\s]+$/, '');
// A question that asks which bet to make, not one about a bet already made ("Kill the retention bet?").
const CHOOSE_BET = /\b(?:choose|pick|which|select|decide on)\b.*\bbets?\b/i;
const SAME_TURN = 5 * 60_000;
const readJson = async <T>(path: string, fallback: T): Promise<T> => { try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return fallback; } };

// A proposal is done when what it asks for is already so, however it got there, and done since it was asked: a plan
// whose every step is a task made on a board since it was offered (by a first yes, or by hand), a bet open under the
// same words, a decision on record under the same title decided since it was asked, or a question to choose a bet
// answered by an open bet taken after it. Read fresh on every look, so the row goes on the next tick and on the action
// that did it, and never lingers to be advised on. What was done before the ask ("Raise the price?" decided last
// month, last week's tasks of a weekly plan, a bet already closed) answers nothing: asking again is asking again.
export function doneAttention(deps: { workspace: string; store: Pick<Store, 'loadStage'>; boards: Pick<Boards, 'list'>; decisions: { list(): Promise<Decision[]> } }): Settle {
  return async (list) => {
    const done = new Set<string>();
    const wanted = (kind: AttentionKind) => list.some((entry) => entry.kind === kind);
    if (wanted('proposed-plan')) {
      const { plans } = await readJson<{ plans?: PlanProposal[] }>(join(deps.workspace, 'partner.json'), {});
      const stage = await deps.store.loadStage();
      const tasks: { title: string; at: number }[] = [];
      for (const card of (stage.cards ?? []).filter((one) => one.kind === 'board')) for (const task of await deps.boards.list(card.id)) if (task.column !== 'proposed') tasks.push({ title: same(task.title), at: task.createdAt });
      for (const plan of Array.isArray(plans) ? plans : []) {
        // A few minutes before the offer still count: a person may put a step on the board in the turn that offers the plan.
        const titles = new Set(tasks.filter((task) => task.at >= plan.at - SAME_TURN).map((task) => task.title));
        const onBoard = plan.steps.length > 0 && plan.steps.every((step) => titles.has(same(planTaskTitle(step))) || titles.has(same(stepText(step))));
        if (onBoard) done.add(`proposed-plan:${plan.id}`);
      }
    }
    const bets = wanted('proposed-bet') || wanted('proposed-decision') ? (await readJson<{ bets?: Bet[] }>(join(deps.workspace, 'bets.json'), {})).bets ?? [] : [];
    const taken = bets.filter((bet) => bet.status === 'open');
    for (const bet of bets) {
      if (bet.status !== 'proposed') continue;
      const twin = taken.some((one) => same(one.what) === same(bet.what) || (one.metric === bet.metric && one.target === bet.target && one.checkDate === bet.checkDate));
      if (twin) done.add(`proposed-bet:${bet.id}`);
    }
    if (wanted('proposed-decision')) {
      const all = await deps.decisions.list();
      const decided = all.filter((one) => one.status === 'decided');
      for (const decision of all) {
        if (decision.status !== 'proposed') continue;
        const twin = decided.some((one) => same(one.title) === same(decision.title) && (one.decidedAt ?? one.at) >= decision.at);
        // "Choose a 2-week validation bet": an open bet taken after it was asked is its answer. Taken after is proposed
        // after, or taken on a later day (the ledger keeps the day a bet was taken, not the hour).
        const aboutBet = CHOOSE_BET.test(decision.title) && taken.some((bet) => bet.at >= decision.at || bet.made > localDay(decision.at));
        if (twin || aboutBet) done.add(`proposed-decision:${decision.id}`);
      }
    }
    return done;
  };
}
