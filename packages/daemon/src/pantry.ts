import {
  type Vault, type Org, type JobFrontmatter,
  listJobs, readJob, createJob, updateJob, jobPath, loadOrg, teamOf, idFromKey, nowIso, HOUSE,
  PANTRY_DIR, PANTRY_MAX_TURNS, pantryIdea, pantryNote, pantryNotePath, filePantryIdea, type PantryTurn,
} from '@cubicle/core';
import { withCycleBudget, type HeartbeatDeps } from './heartbeat.js';
import { hasIdea } from './first-run.js';

/**
 * The pantry chat. A worker-pool branch, like the heartbeat, not a harness job (Decision 9): six alternating
 * turns between two specific people with no tools is not what `runJob` does, and expressed as a harness job it
 * would be one agent spending a step budget on `colleague.message`.
 *
 * Two things make it free. Every turn routes as `roleId: 'pantry'`, which `divisionOfRole` resolves to the house
 * because it is not a role — so a coffee break can never eat the quota a division needs for its work. And the
 * idea extraction is arithmetic over the transcript (`pantryIdea`, `pantryIdeaIsNew`), so the whole feature costs
 * the heartbeat's own model budget exactly zero calls per cycle.
 */

/** Who the turns are charged to. Not a role, so `divisionOfRole` sends it to the house (SP4 §4). */
export const PANTRY_ROLE_ID = 'pantry';
/** Two sentences. A turn that runs long is a meeting, and the office cannot show it. */
export const PANTRY_TURN_TOKENS = 140;
/** How much of a speaker's charter is folded into the prompt. A coffee break does not need the whole thing. */
export const PANTRY_CHARTER_CHARS = 800;
/** The tick's own floor: the pantry opens once the company has had at least one cycle (Decision 20). */
export const PANTRY_FIRST_CYCLE = 1;

const OPEN = ['queued', 'running', 'blocked', 'in_review'] as const;

/**
 * What one person has open, this chat aside. Idleness is the pantry's whole premise and it is a live condition:
 * the chat is `priority: 5`, so it waits behind everything else queued for whoever it is assigned to, and by the
 * time it comes up either of the pair may have work. `exceptJob` is the chat itself, which is queued to `a`.
 */
export function openJobsOf(vault: Vault, role: string, exceptJob: string): JobFrontmatter[] {
  return listJobs(vault, { assigned: role, status: [...OPEN] }).filter((j) => j.id !== exceptJob);
}

/**
 * Everyone with nothing to do: an active charter, no open job, and not one of the board's advisors — three
 * people who are idle by design would otherwise be the only ones ever in the pantry. Sorted, so the pair is a
 * function of the cycle and nothing else.
 */
export function idleRoles(org: Org, open: JobFrontmatter[]): string[] {
  const busy = new Set(open.map((j) => j.assigned));
  const board = org.teams.board;                    // a team id, not a role id: the board room, whoever staffs it
  const advisors = new Set(board ? [board.lead, ...board.members] : []);
  return Object.keys(org.roles).filter((r) => org.roles[r].active && !busy.has(r) && !advisors.has(r)).sort();
}

/**
 * When each person was last in the pantry, as the path of the last note they appear in. Read from the notes
 * themselves rather than from the event log, because the note is the company's record of the conversation and
 * survives a log trim; the file names begin with the date, so sorting them is sorting by when.
 */
export function lastPantryChat(vault: Vault): Record<string, string> {
  const seen: Record<string, string> = {};
  for (const rel of vault.list(PANTRY_DIR, { ext: '.md' }).sort()) {
    if (rel.endsWith('_about.md')) continue;
    const note = vault.readNoteOrNull<{ participants?: unknown }>(rel);
    const parts = Array.isArray(note?.data.participants) ? note!.data.participants.map(String) : [];
    for (const p of parts) seen[p] = rel;          // sorted oldest-first, so the last write is the most recent
  }
  return seen;
}

/** Longest-since-a-coffee first; among the people who have never had one, the cycle decides who goes. */
function nextUp(order: string[], seen: Record<string, string>, cycle: number): string {
  const never = order.filter((r) => !seen[r]);
  return never.length ? never[cycle % never.length] : order[0];
}

/**
 * The pair: the two idle people who were in the pantry longest ago, and preferably from two different rooms —
 * the pantry is where people meet people they do not work with.
 *
 * Both seats rotate (review M1). Sorting by the last note each person attended is what does it once the company
 * has a history; before it has one, every rank is equal and the cycle number picks, so a brand-new company does
 * not send the same alphabetically-first two people every time either.
 */
export function pantryPair(idle: string[], cycle: number, teamFor: (role: string) => string | undefined, seen: Record<string, string> = {}): [string, string] | null {
  if (idle.length < 2) return null;
  const since = (r: string) => seen[r] ?? '';      // never been: sorts first, which is what "longest ago" means
  const order = [...idle].sort((x, y) => since(x).localeCompare(since(y)));
  const a = nextUp(order, seen, cycle);
  const rest = order.filter((r) => r !== a);
  const elsewhere = rest.filter((r) => teamFor(r) !== teamFor(a));
  const b = nextUp(elsewhere.length ? elsewhere : rest, seen, cycle);
  return [a, b];
}

/** One chat per cycle, re-found rather than re-filed after a restart or a replayed log. */
export function pantryJobId(cycle: number): string { return idFromKey('job', `pantry-${cycle}`); }

/** How far back `pantryCycleOf` looks for the cycle a job id was minted for. A chat waits behind work, never behind this much of it. */
export const PANTRY_CYCLE_LOOKBACK = 50;

/**
 * The cycle this chat was enqueued for. The id is `idFromKey` over the cycle number, so it is *recovered* by
 * matching rather than decoded: `now` is the count at run time, and the enqueue count can only be the same or
 * lower. Falls back to `now` for an id minted some other way (a test's own job, or a chat older than the
 * lookback).
 *
 * It matters because a chat waits at `priority: 5` behind everything else: one that starts after the next
 * heartbeat completes would otherwise write a later cycle number into its note than the id it was filed under
 * (review minor 11).
 */
export function pantryCycleOf(jobId: string, now: number): number {
  for (let c = now; c >= 0 && c > now - PANTRY_CYCLE_LOOKBACK; c--) if (pantryJobId(c) === jobId) return c;
  return now;
}

export const PANTRY_GOAL = 'A coffee in the pantry. Nothing is decided here and nothing leaves the room: six turns at most, two sentences each, and one closing IDEA line if anything came of it.';

/**
 * Enqueue at most one pantry chat, from the daemon tick rather than from a heartbeat step (Decision 7): idleness
 * is a live condition, and the heartbeat runs when the company is at its busiest and would see nobody idle.
 *
 * A dormancy check that throws reads as "not dormant", as everywhere else in SP4: the failure mode of money must
 * be a company that keeps working, never one that silently stops.
 */
export function maybeEnqueuePantryChat(vault: Vault, opts: { dormant?: () => boolean } = {}): string | null {
  let dormant = false;
  try { dormant = opts.dormant?.() ?? false; } catch { dormant = false; }
  if (dormant) return null;
  const cycle = vault.events.count('heartbeat.completed');
  if (cycle < PANTRY_FIRST_CYCLE) return null;
  // …and the owner has said what the company is (Decision 20, as refined by review I3). A completed cycle alone
  // is not enough: the daemon's first tick on a brand-new vault requests a heartbeat (`since = Infinity`), that
  // cycle completes before the owner has typed a word, and the next tick would then file the first note in
  // `Pantry/` as two people with nothing whatever to talk about — possibly with an `Ideas/` card out of it. The
  // same test the first-run card uses, so the office and the pantry agree on when the company started.
  if (!hasIdea(vault)) return null;
  const id = pantryJobId(cycle);
  if (vault.exists(jobPath(id))) return null;
  const open = listJobs(vault, { status: [...OPEN] });
  if (open.some((j) => j.type === 'pantry.chat')) return null;
  const org = loadOrg(vault);
  // `lastPantryChat` parses every note in `Pantry/` — a directory that gains a note per cycle for ever — so it is
  // read only once there is somebody to send. Evaluated as an argument it ran on every tick of a busy company,
  // which is exactly the company that never has two idle people (review minor 4).
  const idle = idleRoles(org, open);
  if (idle.length < 2) return null;
  const pair = pantryPair(idle, cycle, (r) => teamOf(org, r)?.id, lastPantryChat(vault));
  if (!pair) return null;
  const [a, b] = pair;
  return createJob(vault, {
    id, type: 'pantry.chat', title: `Pantry: ${displayOf(org, a)} and ${displayOf(org, b)}`,
    assigned: a, pantry_with: b, priority: 5, model_tier: 'cheap', goal: PANTRY_GOAL,
    // No team, so no WIP limit can hold it (Decision 10): a coffee break is not work, and letting a full
    // in_progress lane block a chat between two idle people would be the limit doing the opposite of its job.
  }, 'daemon');
}

function displayOf(org: Org, role: string): string {
  return org.roles[role]?.display || role;
}

const charterOf = (vault: Vault, role: string): string => (vault.readNoteOrNull(`Roles/${role}.md`)?.body ?? '').slice(0, PANTRY_CHARTER_CHARS);

/** What a speaker is asked. The closing turn — and only it — asks for the one IDEA line the rule reads. */
export function pantryPrompt(o: { speaker: string; speakerName: string; otherName: string; turns: PantryTurn[]; last: boolean }): string {
  const soFar = o.turns.length ? o.turns.map((t) => `${t.name}: ${t.text}`).join('\n') : '(nobody has said anything yet)';
  return [
    `You are ${o.speakerName}, having a coffee in the pantry with ${o.otherName}. Nothing is decided here.`,
    '',
    'So far:',
    soFar,
    '',
    o.last
      ? 'Say your last two sentences, then end with exactly one line: `IDEA: <one sentence>` if something genuinely new came out of this, or `IDEA: none` if it did not. Do not invent one to be helpful — "none" is the usual answer.'
      : 'Say at most two sentences. Be specific about the work, not chatty.',
  ].join('\n');
}

/** One tool-less turn on the cheapest model there is. Null on any failure: a company with no model still gets its coffee. */
async function say(deps: HeartbeatDeps, speaker: string, user: string): Promise<string | null> {
  try {
    const budget = deps.modelBudget?.() ?? undefined;
    const r = await deps.llm.chat(
      // `roleId` is the house's, not the speaker's: the charter decides how they talk, the budget is the house's.
      // And the call is *stamped* with the house too (`budget_division` on `router.call`, SP4 §4), so the bank
      // screen counts a coffee break against the reserve rather than inferring a pool from the speaker's room.
      { tier: 'cheap', needsTools: false, roleId: PANTRY_ROLE_ID, budget, budgetDivision: budget ? HOUSE : undefined },
      { messages: [{ role: 'system', content: `${charterOf(deps.vault, speaker)}\n\nTwo sentences at most. No preamble, no lists.` }, { role: 'user', content: user }], maxTokens: PANTRY_TURN_TOKENS },
    );
    return r.content.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The note this job wrote, or null. The write carried the job id, and the event log is append-only, so this is
 * the one record a resume can trust — `pantryNotePath` would answer "the next free name", which after a kill is
 * a second note for one conversation.
 */
export function pantryNoteFor(vault: Vault, jobId: string): string | null {
  const w = vault.events.query({ types: ['vault.wrote'], job: jobId }).find((e) => String(e.payload.path ?? '').startsWith(`${PANTRY_DIR}/`));
  return w ? String(w.payload.path) : null;
}

/** Done, or called off because one of the two had work by the time the coffee came up. */
export type PantryOutcome = { status: 'done' } | { status: 'cancelled'; skipped: string };

/** Run one pantry chat to its note. It never fails: a chat nobody could hold is a chat with no turns. */
export async function runPantryChat(deps: HeartbeatDeps, jobId: string): Promise<PantryOutcome> {
  const vault = deps.vault;
  const now = deps.now?.() ?? new Date();
  const note = readJob(vault, jobId);
  if (!note) return { status: 'done' };
  const job = note.data;
  const org = loadOrg(vault);
  const a = job.assigned;
  const b = String(job.pantry_with ?? '');
  // The cycle this chat was *filed* for, not the count at the moment it runs: it waits at `priority: 5` behind
  // everything else, and one that starts after the next heartbeat completes would write a number its own job id
  // disagrees with (review minor 11).
  const cycle = pantryCycleOf(jobId, vault.events.count('heartbeat.completed'));
  const names: Record<string, string> = { [a]: displayOf(org, a), [b]: displayOf(org, b) };
  const pair = [a, b].filter(Boolean);
  const meetingId = idFromKey('meet', `pantry:${jobId}`);

  // A kill between the note write and the `done` update leaves this job queued again with its conversation
  // already on disk (review M2). Finish pointing at it: re-running the turns would spend six more cheap calls to
  // say different things about the same coffee, and would file a second `-2` note for it.
  const written = pantryNoteFor(vault, jobId);
  if (written) {
    const held = Number(vault.readNoteOrNull<{ turns?: unknown }>(written)?.data.turns ?? 0);
    const summary = `${held} turn${held === 1 ? '' : 's'} in the pantry; the note was already written`;
    updateJob(vault, jobId, { status: 'done', checkpoint_step: held }, 'daemon', `- ${nowIso()}: resumed after ${written} was written; nothing more to say`);
    vault.events.emit({ type: 'job.done', agent: a, job: jobId, payload: { type: job.type, status: 'done', summary, artifacts: [written] } });
    return { status: 'done' };
  }

  // Both were idle when the tick picked them, which may have been minutes ago: the chat is `priority: 5`, so it
  // waits behind everything else queued for `a`. "Two people with nothing to do" (§6) is a live condition, so it
  // is re-checked here, at the moment the coffee would actually happen. If either has work the break is called
  // off quietly — no turns, no note, no sprite sent to the counter — rather than showing somebody in two places
  // at once and spending three turns of their attention on small talk (review I1).
  const busy = pair.find((r) => openJobsOf(vault, r, jobId).length > 0);
  if (busy) {
    updateJob(vault, jobId, { status: 'cancelled' }, 'daemon', `- ${nowIso()}: skipped: ${displayOf(org, busy)} picked up work before the coffee`);
    // Announced by the daemon, not by `a`: `a` may be the one who is busy, and the office's `job.cancelled`
    // reducer sends the named agent back to an idle desk — which would take their real job off the screen.
    vault.events.emit({ type: 'job.cancelled', agent: 'daemon', job: jobId, payload: { at_step: 0, reason: 'skipped', type: job.type, by: busy } });
    return { status: 'cancelled', skipped: busy };
  }

  // One reading of the house budget for the whole chat, as the harness reads one per job (SP4 §4, and the comment
  // on `withCycleBudget`): the gauge it reads walks the ledger, which only grows, and a chat whose turns straddle
  // a quota crossing would change model halfway through one conversation (review I2).
  const d = withCycleBudget(deps);

  updateJob(vault, jobId, { status: 'running' }, 'daemon', `- ${nowIso()}: pantry chat opened with ${b || 'nobody'}`);
  vault.events.emit({ type: 'job.started', agent: a, job: jobId, payload: { type: job.type, title: job.title, attempt: job.attempt, from_step: 0, resumed: false } });
  vault.events.emit({ type: 'meeting.opened', agent: a, job: jobId, payload: { id: meetingId, room: 'pantry', participants: pair, agenda: 'A coffee in the pantry' } });

  const turns: PantryTurn[] = [];
  /** What the *closing* turn said, and only it: the one turn whose prompt asked for an `IDEA:` line. */
  let closing = '';
  if (b && org.roles[b]) {
    for (let i = 0; i < PANTRY_MAX_TURNS; i++) {
      const speaker = i % 2 === 0 ? a : b;
      const other = speaker === a ? b : a;
      const last = i === PANTRY_MAX_TURNS - 1;
      const text = await say(d, speaker, pantryPrompt({ speaker, speakerName: names[speaker], otherName: names[other], turns, last }));
      // A turn with no model answer ends the chat early and the job still finishes done: a company with no model
      // available does not fail a coffee break.
      if (!text) break;
      if (last) closing = text;
      turns.push({ role: speaker, name: names[speaker], text });
      vault.events.emit({ type: 'meeting.turn', agent: speaker, job: jobId, payload: { id: meetingId, round: i + 1, text: text.slice(0, 280) } });
    }
  }

  // Read from the closing turn alone (review minor 8). Over the whole transcript, a speaker who writes "Idea: we
  // should call the nurseries" at turn three supplies the card whenever the closing turn omits its line — and a
  // chat that ended early was never asked for one at all.
  const idea = pantryIdea(closing);
  const rel = pantryNotePath(vault, now, pair);
  // The note is written before the card that cites it (review minor 3). The card's `evidence` names this note, and
  // a kill between the two used to leave an `Ideas/` card pointing at a `Pantry/` file that does not exist — with
  // the resume guard (`pantryNoteFor`, keyed on a `Pantry/` write) not firing, so the chat was re-run and its new
  // idea then refused as "already filed today". This way round, a kill costs the card, not the record.
  vault.writeText(rel, pantryNote({ date: now.toISOString().slice(0, 10), cycle, participants: pair, turns, idea, filed: null, why: '' }), 'daemon', { job: jobId });
  const filed = filePantryIdea(vault, { idea, note: rel, now, by: 'daemon' });
  // Rewritten only when there was an idea to report on: with none, the two notes are the same bytes.
  if (idea) vault.writeText(rel, pantryNote({ date: now.toISOString().slice(0, 10), cycle, participants: pair, turns, idea, filed: filed.slug, why: filed.why }), 'daemon', { job: jobId });

  const summary = `${turns.length} turn${turns.length === 1 ? '' : 's'} in the pantry; ${filed.slug ? `filed Ideas/${filed.slug}.md` : filed.why}`;
  vault.events.emit({ type: 'meeting.closed', agent: a, job: jobId, payload: { id: meetingId, room: 'pantry', path: rel, turns: turns.length, decision: filed.slug ? `IDEA: ${idea}` : idea ? `IDEA not filed: ${filed.why}` : 'no idea' } });
  updateJob(vault, jobId, { status: 'done', checkpoint_step: turns.length }, 'daemon', `- ${nowIso()}: ${summary}`);
  vault.events.emit({ type: 'job.done', agent: a, job: jobId, payload: { type: job.type, status: 'done', summary, artifacts: [rel, ...(filed.slug ? [`Ideas/${filed.slug}.md`] : [])] } });
  return { status: 'done' };
}
