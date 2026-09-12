import {
  type Vault, type Org, type JobFrontmatter,
  listJobs, readJob, createJob, updateJob, jobPath, loadOrg, teamOf, idFromKey, nowIso, HOUSE,
  PANTRY_MAX_TURNS, pantryIdea, pantryNote, pantryNotePath, filePantryIdea, type PantryTurn,
} from '@cubicle/core';
import type { HeartbeatDeps } from './heartbeat.js';

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
 * The pair. `a` rotates with the cycle so the same two people are not always the ones talking, and `b` is the
 * first idle person from another room — the pantry is where people meet people they do not work with.
 */
export function pantryPair(idle: string[], cycle: number, teamFor: (role: string) => string | undefined): [string, string] | null {
  if (idle.length < 2) return null;
  const a = idle[cycle % idle.length];
  const rest = idle.filter((r) => r !== a);
  const b = rest.find((r) => teamFor(r) !== teamFor(a)) ?? rest[cycle % rest.length];
  return [a, b];
}

/** One chat per cycle, re-found rather than re-filed after a restart or a replayed log. */
export function pantryJobId(cycle: number): string { return idFromKey('job', `pantry-${cycle}`); }

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
  const id = pantryJobId(cycle);
  if (vault.exists(jobPath(id))) return null;
  const open = listJobs(vault, { status: [...OPEN] });
  if (open.some((j) => j.type === 'pantry.chat')) return null;
  const org = loadOrg(vault);
  const pair = pantryPair(idleRoles(org, open), cycle, (r) => teamOf(org, r)?.id);
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

export type PantryOutcome = { status: 'done' };

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
  const cycle = vault.events.count('heartbeat.completed');
  const names: Record<string, string> = { [a]: displayOf(org, a), [b]: displayOf(org, b) };
  const pair = [a, b].filter(Boolean);
  const meetingId = idFromKey('meet', `pantry:${jobId}`);

  updateJob(vault, jobId, { status: 'running' }, 'daemon', `- ${nowIso()}: pantry chat opened with ${b || 'nobody'}`);
  vault.events.emit({ type: 'job.started', agent: a, job: jobId, payload: { type: job.type, title: job.title, attempt: job.attempt, from_step: 0, resumed: false } });
  vault.events.emit({ type: 'meeting.opened', agent: a, job: jobId, payload: { id: meetingId, room: 'pantry', participants: pair, agenda: 'A coffee in the pantry' } });

  const turns: PantryTurn[] = [];
  if (b && org.roles[b]) {
    for (let i = 0; i < PANTRY_MAX_TURNS; i++) {
      const speaker = i % 2 === 0 ? a : b;
      const other = speaker === a ? b : a;
      const text = await say(deps, speaker, pantryPrompt({ speaker, speakerName: names[speaker], otherName: names[other], turns, last: i === PANTRY_MAX_TURNS - 1 }));
      // A turn with no model answer ends the chat early and the job still finishes done: a company with no model
      // available does not fail a coffee break.
      if (!text) break;
      turns.push({ role: speaker, name: names[speaker], text });
      vault.events.emit({ type: 'meeting.turn', agent: speaker, job: jobId, payload: { id: meetingId, round: i + 1, text: text.slice(0, 280) } });
    }
  }

  const transcript = turns.map((t) => `${t.name}: ${t.text}`).join('\n');
  const idea = pantryIdea(transcript);
  const rel = pantryNotePath(vault, now, pair);
  // Filed first, so the note can say which card it became; the card's evidence names this note, written next.
  const filed = filePantryIdea(vault, { idea, note: rel, now, by: 'daemon' });
  vault.writeText(rel, pantryNote({ date: now.toISOString().slice(0, 10), cycle, participants: pair, turns, idea, filed: filed.slug, why: filed.why }), 'daemon', { job: jobId });

  const summary = `${turns.length} turn${turns.length === 1 ? '' : 's'} in the pantry; ${filed.slug ? `filed Ideas/${filed.slug}.md` : filed.why}`;
  vault.events.emit({ type: 'meeting.closed', agent: a, job: jobId, payload: { id: meetingId, room: 'pantry', path: rel, turns: turns.length, decision: filed.slug ? `IDEA: ${idea}` : idea ? `IDEA not filed: ${filed.why}` : 'no idea' } });
  updateJob(vault, jobId, { status: 'done', checkpoint_step: turns.length }, 'daemon', `- ${nowIso()}: ${summary}`);
  vault.events.emit({ type: 'job.done', agent: a, job: jobId, payload: { type: job.type, status: 'done', summary, artifacts: [rel, ...(filed.slug ? [`Ideas/${filed.slug}.md`] : [])] } });
  return { status: 'done' };
}
