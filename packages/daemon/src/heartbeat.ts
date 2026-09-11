import {
  type Vault, type JobFrontmatter, type InboxFrontmatter, readJob, updateJob, createJob, listJobs, listInbox, findInboxById, nowIso, stampForFilename,
  autoCommit, parseNote, stringifyNote, setSection, createProposal, idFromKey, type CubicleEvent,
  loadOrg, expandProcess, childrenOf, resolveTeamSection, writeDecision, repoRoot, type TeamFrontmatter,
  officeHolder, roleWithTool, teamOf, researchLead, listStreams, type Org, type ModelTier,
  childTeams, subtreeRoles, divisionTeams, divisionOf,
  budgetLines, GATE_JOB_TYPES,
} from '@cubicle/core';
import type { Llm } from '@cubicle/harness';
import { renderQuotaMarkdown, type Router } from '@cubicle/router';
import { deployer, emailSender, analytics } from '@cubicle/tools';
import { writeQueueMd } from './queue-md.js';
import { collectOwnerFeedback, markFeedbackDelivered, preferenceFeedbackShas, gatheredCommentBaselines, markCommentsDelivered } from './evolution.js';
import { seedFirstJobs, seedFirstStream } from './first-run.js';

function collectOwnerFeedbackSafe(vault: Vault, since?: string) {
  try { return collectOwnerFeedback(vault, since); } catch { return []; }
}

export interface HeartbeatDeps {
  vault: Vault;
  llm: Llm;
  router?: Router;
  now?: () => Date;
  /** Adapters supplied by the daemon; tests inject fakes. */
  pollInbox?: () => Promise<string[]>;
  pullAnalytics?: () => Promise<string | null>;
  openMeeting?: (agenda: string) => Promise<string | null>;
  /** The outbound adapters (deploy/email/analytics) pick mock or live from this env; the brief says which. */
  env?: NodeJS.ProcessEnv;
  /** True when every cloud provider in the cascade lacks its API key (the daemon warned `provider_key` at start). */
  noCloudKeys?: () => boolean;
  /** See DaemonConfig.planMaxAgeDays; undefined disables the re-planning gate. */
  planMaxAgeDays?: number;
  log?: (msg: string) => void;
}

export type HeartbeatOutcome = { status: 'done' } | { status: 'blocked'; on: { kind: 'job'; id: string } } | { status: 'cancelled' } | { status: 'requeued'; attempt: number };

/**
 * The cycle, in order. Every step has a `case` in the loop below; a step with none would be walked through
 * without doing anything. `owner_verdict` files the `plan_verdict` note the owner rules on and reads the
 * ruling back (Task 5): only an approved plan reaches `division_plans`, while work an earlier plan already
 * queued keeps running throughout.
 */
export const HEARTBEAT_STEPS = ['gather', 'reconcile_brand', 'answer_owner', 'meeting', 'company_plan', 'board_premortem', 'owner_verdict', 'division_plans', 'brief', 'commit'] as const;
/** How long a heartbeat waits for company.plan/division.plan before writing the brief with "planning pending" (R33). */
export const PLAN_WAIT_BUDGET_MS = 40 * 90_000;

/** Planning and gate job types never count toward the "N jobs completed" heartbeat trigger — otherwise a single
 *  cycle's own planning/gate sub-jobs (company.plan, board.premortem, division.plan, plus every `GATE_JOB_TYPES`
 *  gate: team:qa.review, office:security.review, requester.review, research.review, office:operations.verify,
 *  and their pre-office names) push the count past the threshold and the heartbeat retriggers itself. The
 *  re-planning gate uses the same list for "work still open": a queued office:operations.verify is bookkeeping,
 *  not work from the plan. `GATE_JOB_TYPES` lives in core so
 *  `wipLoad` (jobs.ts) excludes the identical set from a team's WIP tally — one list, not two literals to drift.
 *
 *  The daemon's own recurring background work belongs here for the same reason: `intelligence` (four sweeps the
 *  heartbeat itself enqueues) and `research.measure` (a follow-up the calendar enqueues) are not work anyone
 *  planned. Counting them meant four of the five completions the next heartbeat waits for were the daemon's own
 *  sweeps, so one real job fired the next cycle, which enqueued four more — a self-driving cadence that also ate
 *  the free cheap-tier pool. */
export const NON_WORK_TYPES = ['ceo.heartbeat', 'company.plan', 'critic.premortem', 'team.plan', ...GATE_JOB_TYPES, 'intelligence', 'research.measure', 'division.plan', 'board.premortem'];

/**
 * The outbound services whose adapters are in mock mode for this env, in the order the brief names them. Asks the
 * adapters themselves (`deployer`, `emailSender`, `analytics`) rather than repeating their env-var names here, so
 * the brief can never disagree with what `email.send` or `deploy` actually did.
 */
export function mockedServices(env: NodeJS.ProcessEnv): ('deploy' | 'email' | 'analytics')[] {
  const modes = { deploy: deployer(env, repoRoot()).mode, email: emailSender(env).mode, analytics: analytics(env).mode } as const;
  return (['deploy', 'email', 'analytics'] as const).filter((s) => modes[s] === 'mock');
}

const SERVICE_KEYS = { deploy: 'CLOUDFLARE_*', email: 'BREVO_*', analytics: 'GOATCOUNTER_*' } as const;

/**
 * The brief's "What needs you" row for mocked outbound services, naming only the ones that are. Without it a
 * brief could say "Verified site deployment" about a copy into `.cubicle/mock/deploy/` and the owner would
 * believe a customer could have seen the site.
 */
export function mockedServicesRow(mocked: ('deploy' | 'email' | 'analytics')[]): string | null {
  if (!mocked.length) return null;
  const names = mocked.map((s, i) => (i === 0 ? s[0].toUpperCase() + s.slice(1) : s));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `- ${list} ${mocked.length === 1 ? 'is' : 'are'} simulated (no ${mocked.map((s) => SERVICE_KEYS[s]).join('/')} keys): nothing has reached a customer. See SETUP.md`;
}

/**
 * Model use over the heartbeat window, from `router.call` events: a fact line always, and a "What needs you" row
 * when the team ran mostly on the local floor — at least 5 calls, at least half of them downgraded (a one-off
 * cascade is noise; a whole cycle on ollama is news). `noCloudKeys` picks the cause: the live run this fixes had
 * no key at all, which Metrics/quota.md ("ok 0/250") could not distinguish from an idle cloud tier.
 */
export function modelUseRows(use: { calls: number; downgraded: number }, noCloudKeys: boolean): { fact: string; needsYou: string | null } {
  const fact = `Model use: ${use.calls} calls, ${use.downgraded} downgraded to local`;
  if (use.calls < 5 || use.downgraded * 2 < use.calls) return { fact, needsYou: null };
  const reason = noCloudKeys ? 'no cloud provider has an API key' : 'cloud models were rate-limited or cooling';
  return { fact, needsYou: `- The team ran mostly on the local model (${use.downgraded} of ${use.calls} calls downgraded): ${reason}. Check API keys in .env (\`cubicle doctor\`) and Metrics/quota.md` };
}

/**
 * Whether this heartbeat may keep the current Plans/plan.md instead of rewriting it. Every heartbeat used to run
 * company.plan → the board pre-mortem → one division.plan per division → gates (≈16 model calls) before any work, and on the
 * local floor one such "Plan Growth" took three days. Skip only when ALL hold: the plan's frontmatter `updated`
 * parses to a date less than `maxAgeDays` old (the template's `updated: ""` and a future or garbled stamp mean
 * "age unknown" → plan), the plan is substantive, work from it is still queued or running, nobody asked for a
 * change (owner message, owner edit, owner-triggered heartbeat), and this is not the board's requested rewrite.
 */
export function planningGate(opts: { plan: string; now: Date; maxAgeDays: number | undefined; openJobs: number; ownerAsked: boolean; rewrite: boolean }): { skip: true; planDate: string } | { skip: false; reason: string } {
  const { plan, now, maxAgeDays, openJobs, ownerAsked, rewrite } = opts;
  if (maxAgeDays === undefined || !(maxAgeDays > 0)) return { skip: false, reason: 'gate disabled' };
  if (rewrite) return { skip: false, reason: 'the board returned the plan' };
  if (ownerAsked) return { skip: false, reason: 'the owner asked for something' };
  if (openJobs === 0) return { skip: false, reason: 'no work from the plan is open' };
  if (!planIsSubstantive(plan)) return { skip: false, reason: 'the plan has no real objective' };
  let updated: unknown;
  try { updated = parseNote(plan).data.updated; } catch { return { skip: false, reason: 'plan frontmatter unreadable' }; }
  const stamp = updated instanceof Date ? updated.toISOString() : typeof updated === 'string' ? updated.trim() : '';
  const t = stamp ? Date.parse(stamp) : NaN;
  if (Number.isNaN(t)) return { skip: false, reason: 'plan age unknown' };
  const ageDays = (now.getTime() - t) / 86400_000;
  if (ageDays < 0) return { skip: false, reason: 'plan stamp is in the future' };
  if (ageDays >= maxAgeDays) return { skip: false, reason: `plan is ${ageDays.toFixed(1)} days old` };
  return { skip: true, planDate: new Date(t).toISOString().slice(0, 10) };
}

/** The plan_verdict note for one heartbeat: a stable id, so a resumed cycle finds its own proposal. */
export function planVerdictId(hbId: string): string { return idFromKey('prop', `verdict:${hbId}`); }

/**
 * The plan the company has not acted on yet: a `plan_verdict` note that was not rejected and whose plan no
 * division has planned against (`fanned_out`). It stays open across the approval itself on purpose — an owner who
 * approves between two heartbeats must get their plan executed, not overwritten by a fresh one.
 */
export function openPlanVerdict(vault: Vault): { path: string; data: InboxFrontmatter; body: string } | null {
  return listInbox(vault).find((n) => n.data.kind === 'plan_verdict' && n.data.approved !== false && !(n.data as { fanned_out?: string }).fanned_out) ?? null;
}

/**
 * The newest plan the owner (or the board on a silent owner) turned down and nobody has rewritten yet. A
 * rejection IS a rewrite request, so the re-planning gate must read it directly: relying on the `owner.edited`
 * signal the rejection happens to leave behind meant a rejection made outside an owner edit — the board's own
 * verdict on a timeout, an approval flag flipped by a script — reached the CEO only by accident. Stamped
 * `fanned_out` by the cycle that acts on it, so one rejection buys one rewrite, not a rewrite every cycle.
 */
export function rejectedPlanVerdict(vault: Vault): { path: string; data: InboxFrontmatter; body: string } | null {
  return listInbox(vault)
    .filter((n) => n.data.kind === 'plan_verdict' && n.data.approved === false && !(n.data as { fanned_out?: string }).fanned_out)
    .sort((a, b) => (a.data.created < b.data.created ? 1 : -1))[0] ?? null;
}

/** How much of Plans/plan.md the verdict note quotes: enough to rule on, short of pasting a whole cycle's plan. */
const PLAN_EXCERPT_CHARS = 3000;

/**
 * What the owner actually reads when a plan lands in their inbox: the board's verdict in words, every finding the
 * board raised as its own bullet, and the plan itself. The findings are on the note rather than only in the
 * pre-mortem decision note because this is the one place the owner is being asked to rule, and a verdict asked
 * for without the case against it is not a decision.
 */
export function planVerdictBody(opts: { board: 'pass' | 'return'; findings: string[]; plan: string; decidesAfterHours: number }): string {
  const findings = opts.findings.length
    ? opts.findings.map((f) => `- ${f}`).join('\n')
    : '- The board raised nothing that would sink the cycle.';
  const deadline = opts.decidesAfterHours > 0
    ? `; after ${opts.decidesAfterHours} h the board's verdict stands (\`board_decides_after_hours\` in Memory/constitution.md)`
    : '';
  return `The board ${opts.board === 'pass' ? 'passed' : 'returned'} this plan.\n\n${findings}\n\n## The plan\n\n${opts.plan.slice(0, PLAN_EXCERPT_CHARS)}\n\nSet \`approved: true\` to let the divisions plan against it, or \`approved: false\` to send it back. Work already approved keeps running while you decide${deadline}.`;
}

/**
 * Who decided, and what. The owner's flag always wins. Until it arrives the plan is pending — and with
 * `board_decides_after_hours` at 0, which is the default, it stays pending for as long as the owner takes: the
 * board advises, only the owner rules. An owner who sets a positive number is handing the board that ruling after
 * that long, which is what an unattended night wants. Work from the previously approved plan runs throughout
 * either way; a pending plan stops only new work.
 */
export function verdictOutcome(opts: { approved: boolean | null; created: string; now: Date; boardVerdict: 'pass' | 'return'; decidesAfterHours: number }): 'approved' | 'rejected' | 'pending' {
  if (opts.approved === true) return 'approved';
  if (opts.approved === false) return 'rejected';
  if (!(opts.decidesAfterHours > 0)) return 'pending';   // off: the owner rules, however long that takes
  const hours = (opts.now.getTime() - Date.parse(opts.created)) / 3600_000;
  if (!Number.isFinite(hours) || hours < opts.decidesAfterHours) return 'pending';
  return opts.boardVerdict === 'pass' ? 'approved' : 'rejected';
}

/**
 * The goal text of a division lead's `division.plan` job. A division lists no members of its own any more, so the
 * people it may schedule are the whole subtree; the rooms are named with their leads so a lead can hand a room's
 * work to the room instead of to a person. A division with nobody under it is told how it gets work onto the
 * queue (through the CEO, or as research) rather than being left to call `scheduler.request` on itself, which the
 * org guards refuse.
 *
 * `budgets` and the "name its stream and its risk" instruction are kept from the old per-team goal (SP6): the
 * error budgets and stream-aligned objectives must still reach whoever actually schedules the work, and after
 * this task that is the division lead, not a room lead.
 */
export function divisionPlanGoal(org: Org, t: TeamFrontmatter, objectives: string, lastNextAction: string, researchTo = 'research_manager', budgets: string[] = []): string {
  const rooms = childTeams(org, t.id);
  const people = subtreeRoles(org, t.id).filter((r) => r !== t.lead);
  const budget = budgets.length ? `\n\nError budgets for your streams (operating model §23):\n${budgets.map((b) => `- ${b}`).join('\n')}` : '';
  const roomLine = rooms.length
    ? `Your division: ${rooms.map((c) => `${c.name} (lead ${c.lead}: ${c.members.join(', ') || 'no members'})`).join('; ')}.`
    : 'Your division has no rooms under it.';
  return `Your division's objectives this cycle:\n${objectives}${budget}\n\nNext action from the last brief: ${lastNextAction}\n\n${roomLine}\n\nDo: (1) vault.read Plans/plan.md and vault.list Jobs to see open work; (2) enqueue at most 4 jobs with scheduler.request for anyone in your division (${people.join(', ') || 'nobody'}), each finishable in one sitting, each with done_when, each naming its stream and its risk — give a room's work to its lead when the room should decide who does it; (3) vault.append the job ids under your "### ${t.id}" section in Plans/plan.md; (4) finish with a one-paragraph summary. Research needs go to ${researchTo} with for: ${t.lead}.${people.length === 0 ? ` Your division has nobody under you: plan work you will do yourself in follow-up jobs assigned to you by the CEO (ask with colleague.message), or request research from ${researchTo}; do not call scheduler.request for yourself.` : ''}`;
}

/**
 * Every `### <team>` section in `Plans/plan.md`: its team id and its full body text (everything up to the next
 * `### ` header or the end of the plan), trimmed. Splits on the header line instead of using a lazy
 * `[\s\S]*?` + lookahead match (Task 9 review round 2: that lookahead was `(?=^### |\s*$)` — under the `m` flag,
 * `\s*$` matches the end of ANY line, not just a real section boundary, so the old regex silently truncated
 * every section to just its first line whenever a section had more than one line of content. This broke both
 * `planIsSubstantive` below on multi-bullet sections and the goal text `division_plans` sends a lead — a second
 * objective bullet, or a `process:` line after the first bullet, was silently dropped).
 *
 * The header itself is kept as written (`Engineering`, `Growth team`, `growth`, …) rather than filtered to a
 * bare `\w+` team-id shape (F4): a CEO-written plan header is prose, not a machine key, and dropping a
 * multi-word or differently-cased header here silently lost the whole section for both `planIsSubstantive` and
 * `division_plans`. Resolving the header to an actual team id is the caller's job (`resolveTeamSection`).
 */
export function parseObjectiveSections(plan: string): { team: string; text: string }[] {
  return plan.split(/^### /m).slice(1).map((chunk) => {
    const nl = chunk.indexOf('\n');
    const team = (nl < 0 ? chunk : chunk.slice(0, nl)).trim();
    const text = (nl < 0 ? '' : chunk.slice(nl + 1)).trim();
    return { team, text };
  }).filter((s) => s.team.length > 0);
}

/**
 * True iff `Plans/plan.md` has at least one real objective, so the board pre-mortem is worth running. A plan with no
 * `### <team>` sections at all is not substantive. Within each section, a bullet counts as real work unless it is
 * pure busywork ("Verify ..." / "Reconcile ..."); the plan is substantive iff ANY bullet in ANY section is real
 * work — a single verify-only section next to a real objective in another section must still run the board
 * (Task 9 review finding 1: the previous regex used `.test()` with `m` and matched per-line, so it wrongly
 * short-circuited to "skip" on the first verify/reconcile-only section it found).
 */
export function planIsSubstantive(plan: string): boolean {
  const sections = parseObjectiveSections(plan);
  if (!sections.length) return false;
  return sections.some((s) => s.text.split('\n').some((line) => {
    const bullet = line.trim().match(/^-\s*(.+)/);
    return !!bullet && !/^(verify|reconcile)\b/i.test(bullet[1]);
  }));
}

/**
 * The id `division_plans` should (re-)block on: the first of `ids` whose status is not done/failed/cancelled, or the
 * last id if every one of them already looks finished (defensive — the caller only asks for this while at least
 * one of `state.divisionPlanJobs` is still open, so that shouldn't happen). Always returning `ids[0]` regardless of
 * its status (Task 9 review finding 2) meant that once the first division.plan finished, `requeueUnblocked` would see its
 * `blocked_on` target as satisfied on every dispatcher tick even while other division plans were still running,
 * busy-looping the heartbeat between `blocked` and `queued` until the slowest one finished.
 */
export function firstOpenJob(ids: string[], statusOf: (id: string) => string | undefined): string {
  const open = ids.find((id) => { const s = statusOf(id); return !s || !['done', 'failed', 'cancelled'].includes(s); });
  return open ?? ids[ids.length - 1];
}

/** The system prompt an advisor speaks from: the hard rules plus its own charter and persona. */
function advisorSystem(vault: Vault, role: string): string {
  const constitution = vault.readTextOrNull('Memory/constitution.md') ?? '';
  const note = vault.readNoteOrNull(`Roles/${role}.md`);
  return `# Constitution\n${constitution}\n\n# Your charter (${String(note?.data.display ?? role)})\n${note?.body ?? ''}\n\nAnswer in plain markdown, no preamble.`;
}

/** What the board calls an advisor by: the display name on its role note, else its id. */
function advisorName(vault: Vault, role: string): string {
  return String(vault.readNoteOrNull(`Roles/${role}.md`)?.data.display ?? role);
}

/**
 * The chair's merged answer, read strictly enough to be trusted and loosely enough never to block the cycle: a
 * `VERDICT: return` line returns the plan, anything else (including a missing line, or no model at all) passes
 * it. The board advises; it may not stall the company by answering badly.
 */
export function mergeBoardVerdict(text: string): { verdict: 'pass' | 'return'; findings: string[] } {
  const verdict = /^\s*verdict:\s*return\b/im.test(text) ? 'return' : 'pass';
  const findings = text.split('\n')
    .map((l) => l.trim().match(/^[-*]\s+(.+)$/)?.[1]?.trim())
    .filter((f): f is string => !!f && f.length > 3)
    .slice(0, 4);
  return { verdict, findings };
}

/**
 * The board room, in at most four model calls (spec §2/§4): each advisor reads the plan in its own voice, the
 * board lead merges the three into one verdict. No sub-jobs, because three advisor jobs plus their gates cost a
 * whole cycle's quota on the free tier and the board must answer inside this heartbeat.
 *
 * Each advisor speaks at its own charter's `model_tier` — the charter is a ceiling on cost, never a floor, so an
 * advisor_investor/advisor_customer charter set to `medium` must not be silently upgraded to `strong`. A missing
 * tier falls back to the board lead's, then to `medium`. `answered` is how many of the (deduplicated) advisors
 * actually got a model response, so a caller can tell "the board passed" from "no model was available at all".
 */
export async function runBoardSession(deps: HeartbeatDeps, org: Org, plan: string): Promise<{ verdict: 'pass' | 'return'; findings: string[]; advisors: string[]; transcript: string; answered: number }> {
  const vault = deps.vault;
  // Its one caller guards on `org.teams.board` first, but this is exported and tests call it directly: an org
  // with no board room must fail as "the board passed unreviewed", not as a TypeError inside the cycle (M5).
  const board = org.teams.board;
  if (!board) return { verdict: 'pass', findings: [], advisors: [], transcript: '', answered: 0 };
  const advisors = [...new Set([board.lead, ...board.members])].filter((r) => org.roles[r]).slice(0, 3);
  const leadTier = org.roles[board.lead]?.model_tier ?? 'medium';
  const tierFor = (roleId: string): ModelTier => org.roles[roleId]?.model_tier ?? leadTier;
  const notes: string[] = [];
  let answered = 0;
  for (const a of advisors) {
    const text = await askAs(deps, a, advisorSystem(vault, a), `This cycle's plan:\n\n${plan.slice(0, 4000)}\n\nImagine the cycle has already failed. Write at most three bullets: the failure mode you see and the one change that would prevent it. One line each, concrete, no preamble.`, 500, tierFor(a));
    if (text) answered++;
    notes.push(`### ${advisorName(vault, a)}\n${text ?? '(no answer: no model was available)'}`);
  }
  const transcript = notes.join('\n\n');
  const merged = await askAs(deps, board.lead, advisorSystem(vault, board.lead), `You chair the board. Your advisors wrote:\n\n${transcript}\n\nMerge them into ONE verdict for the owner. First line exactly "VERDICT: pass" or "VERDICT: return". Then at most four bullets, each a failure mode this plan does not answer and the change that fixes it. Return the plan only if running it as written would waste the cycle; you cannot delay.`, 600, leadTier);
  return { ...mergeBoardVerdict(merged ?? ''), advisors, transcript, answered };
}

/** The board note's own words for "no advisor answered" — shared by the decision note and the daemon warning. */
export const BOARD_UNREVIEWED_NOTE = 'No advisor answered (no model was available); the plan passed unreviewed.';

/**
 * The board's pre-mortem as a `Decisions/premortem-<heartbeat id>.md` note: `adopted` when the plan survived,
 * `proposed` when the board returned it (the plan it judged is not the plan that will run). The findings are the
 * failure modes the board foresaw, which is what makes the note worth reading a cycle later.
 *
 * `answered` (default 1, so existing callers keep today's text) is how many advisors actually got a model
 * response (see `runBoardSession`). When it is zero and the verdict still passed — the only way a session with
 * no model at all can resolve, since `mergeBoardVerdict` fails open — the note must not read as a clean bill of
 * health: nobody reviewed anything.
 */
export function writeBoardPremortemDecision(vault: Vault, hbId: string, boardJobId: string, verdict: 'pass' | 'return', findings: string[], decidedBy: string, now: Date, answered = 1): string {
  const unreviewed = verdict === 'pass' && answered === 0;
  const risks = unreviewed ? `- ${BOARD_UNREVIEWED_NOTE}` : findings.length ? findings.map((f) => `- ${f}`).join('\n') : '- The board found nothing in this plan likely to sink the cycle.';
  const review = new Date(now.getTime() + 7 * 24 * 3600_000).toISOString().slice(0, 10);
  return writeDecision(vault, `premortem-${hbId}`, {
    decided_by: decidedBy, cycle: hbId, status: verdict === 'pass' ? 'adopted' : 'proposed', inputs: ['[[Plans/plan]]'],
  }, {
    context: `Pre-mortem for heartbeat ${hbId}: the board read this cycle's \`Plans/plan.md\` and imagined the cycle had already failed. The advisors' own words are in [[${boardJobId}]].`,
    options: '- Run the plan as the CEO wrote it\n- Return it to the CEO to rewrite before the owner rules on it',
    chosen: verdict === 'pass' ? 'Run the plan as written.' : 'Return the plan to the CEO for one rewrite.',
    why: verdict === 'pass' ? (unreviewed ? BOARD_UNREVIEWED_NOTE : 'The plan survived the pre-mortem.') : 'The board found failure modes the plan does not answer.',
    expected_effect: `Most likely ways this cycle fails, and what would prevent each:\n\n${risks}`,
    review_date: review,
  }, decidedBy);
}

/** Create the `ceo.heartbeat` job note (the heartbeat is a job so R9/R10/R12 apply). */
export function createHeartbeatJob(vault: Vault, trigger: string): string {
  const org = loadOrg(vault);
  return createJob(vault, {
    type: 'ceo.heartbeat', title: `Heartbeat (${trigger})`, assigned: officeHolder(org, 'chief_executive'), priority: 1,
    goal: `Company heartbeat triggered by: ${trigger}. Steps: ${HEARTBEAT_STEPS.join(' → ')}.`,
  }, 'daemon');
}

interface Gathered {
  since: string | null;
  gathered_at?: string;
  elapsedHours: number;
  ownerEdits: string[];
  finished: { id: string; type: string; title: string; status: string; summary: string }[];
  mail: string[];
  analytics: string | null;
  unansweredOwnerMessages: { path: string; id: string; created: string; body: string }[];
}

/** The previous heartbeat's gather moment: from its completion event, else from the last done heartbeat note (kill between updateJob and emit). */
export function lastGatheredAt(vault: Vault): string | null {
  const last = vault.events.last('heartbeat.completed');
  if (last) return (last.payload.gathered_at as string | undefined) ?? last.ts;
  const notes = listJobs(vault, { status: 'done' }).filter((j) => j.type === 'ceo.heartbeat').sort((a, b) => a.updated.localeCompare(b.updated));
  return notes.length ? notes[notes.length - 1].created : null;
}

function gather(vault: Vault, now: Date, mail: string[], analytics: string | null): Gathered {
  const since = lastGatheredAt(vault);
  const elapsedHours = since ? (now.getTime() - Date.parse(since)) / 3600_000 : Infinity;
  const ownerEdits = [...new Set(vault.events.query({ types: ['owner.edited'], from: since ?? undefined }).map((e) => String(e.payload.path)))];
  const finished = vault.events.query({ types: ['job.done', 'job.failed'], from: since ?? undefined })
    .filter((e) => e.job)
    .map((e) => { const j = readJob(vault, e.job!); return { id: e.job!, type: j?.data.type ?? '?', title: j?.data.title ?? '?', status: e.type === 'job.done' ? 'done' : 'failed', summary: String(e.payload.summary ?? e.payload.reason ?? '') }; })
    .filter((f) => f.type !== 'ceo.heartbeat');
  const unansweredOwnerMessages = listInbox(vault).filter((n) => n.data.kind === 'message' && n.data.from === 'owner' && n.data.to === 'ceo' && !n.data.answered).map((n) => ({ path: n.path, id: n.data.id, created: n.data.created, body: n.body }));
  return { since, gathered_at: now.toISOString(), elapsedHours, ownerEdits, finished, mail, analytics, unansweredOwnerMessages };
}

/**
 * One tool-less completion spoken by `roleId`. Returns null on any failure: no step blocks on a model. `tier`
 * defaults to `strong` for the CEO's own asks (via `ask`, below); board advisors pass their own charter's tier
 * so a `medium`-tier charter is never silently upgraded (the charter is a cost ceiling, not a floor).
 */
async function askAs(deps: HeartbeatDeps, roleId: string, system: string, user: string, maxTokens = 800, tier: ModelTier = 'strong'): Promise<string | null> {
  try {
    const r = await deps.llm.chat({ tier, needsTools: false, roleId }, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens });
    return r.content.trim() || null;
  } catch {
    return null;
  }
}

/** The same, spoken by whoever holds the chief executive's office. */
async function ask(deps: HeartbeatDeps, system: string, user: string, maxTokens = 800): Promise<string | null> {
  return askAs(deps, officeHolder(loadOrg(deps.vault), 'chief_executive'), system, user, maxTokens);
}

/**
 * The system prompt the chief executive speaks from. `ask()` routes the call as
 * `officeHolder(org, 'chief_executive')`, so the charter must come from the same lookup (final review I2):
 * reading `Roles/ceo.md` meant that after a re-staff the new holder was prompted with the old holder's charter,
 * or with an empty one once that note was archived.
 */
function ceoSystem(vault: Vault): string {
  const constitution = vault.readTextOrNull('Memory/constitution.md') ?? '';
  const chief = officeHolder(loadOrg(vault), 'chief_executive');
  const note = vault.readNoteOrNull(`Roles/${chief}.md`);
  const prefs = vault.readTextOrNull('Memory/owner_preferences.md') ?? '';
  const lessons = vault.readTextOrNull('Memory/lessons.md') ?? '';
  return `# Constitution\n${constitution}\n\n# Your charter (${String(note?.data.display ?? chief)})\n${note?.body ?? ''}\n\n# Owner preferences\n${prefs}\n\n# Lessons\n${lessons.slice(-3000)}\n\nAnswer in plain markdown, no preamble.`;
}

/**
 * Run or resume a heartbeat job. Each step is checkpointed to the job note (`checkpoint_step` = index of
 * the last completed step + 1). Waiting for `cto.plan` uses `blocked_on: {kind: job}` so a kill during
 * planning resumes at the wait (R33).
 */
export async function runHeartbeat(deps: HeartbeatDeps, jobId: string): Promise<HeartbeatOutcome> {
  const vault = deps.vault;
  const now = deps.now ?? (() => new Date());
  const read = () => readJob(vault, jobId)!;
  let job = read().data;
  if (job.status === 'cancelled') return { status: 'cancelled' };
  const stateRel = `.cubicle/jobs/${jobId}.heartbeat.json`;
  const loadState = (): Partial<Gathered & { companyPlanJob?: string; boardJob?: string; boardVerdict?: 'pass' | 'return'; boardFindings?: string[]; vetoes?: number; planWaiting?: string; verdictProposal?: string; verdict?: 'approved' | 'rejected' | 'pending'; divisionPlanJobs?: string[]; runPath?: string; heartbeatId: string; planPending?: boolean; planSkipped?: { planDate: string; open: number }; feedbackShas?: string[]; commentBaselines?: Record<string, string[]> }> => { try { return JSON.parse(vault.readTextOrNull(stateRel) ?? '{}'); } catch { return {}; } };
  const saveState = (s: object) => { const { atomicWriteSync } = require_core(); atomicWriteSync(vault.abs(stateRel), JSON.stringify(s, null, 2)); };
  let state = loadState();
  const hbId = jobId;
  // The vault is the source of truth: recover what the cache may have lost.
  if (job.blocked_on?.kind === 'job') {
    const atStep = HEARTBEAT_STEPS[job.checkpoint_step];
    if (atStep === 'company_plan' && !state.companyPlanJob) state = { ...state, companyPlanJob: job.blocked_on.id };
    // `owner_verdict` counts as well as `division_plans`: a heartbeat that blocked on the fan-out before its
    // checkpoint reached `division_plans` is still parked on division.plan jobs it already created, and a lost cache
    // file must not make it create them a second time.
    if ((atStep === 'division_plans' || atStep === 'owner_verdict') && !state.divisionPlanJobs) {
      const ids = listJobs(vault).filter((j) => j.parent === jobId && j.type === 'division.plan').map((j) => j.id);
      if (ids.length) state = { ...state, divisionPlanJobs: ids };
    }
  }
  // Likewise the verdict note: it is found by its heartbeat-stable id, so a cache-less resume rules on the note
  // the cycle already filed instead of filing a second one (openPlanVerdict would then see two open plans).
  if (!state.verdictProposal && ['owner_verdict', 'division_plans', 'brief', 'commit'].includes(HEARTBEAT_STEPS[job.checkpoint_step] ?? '') && findInboxById(vault, planVerdictId(hbId))) {
    state = { ...state, verdictProposal: planVerdictId(hbId) };
  }
  if (!state.runPath) {
    const fromLinks = job.links.find((l) => l.startsWith('[[Runs/'))?.replace(/^\[\[|\]\]$/g, '');
    if (fromLinks) state = { ...state, runPath: fromLinks.endsWith('.md') ? fromLinks : fromLinks + '.md' };
  }
  if (!state.heartbeatId) { state = { ...state, heartbeatId: hbId }; saveState(state); }

  if (job.status !== 'running') {
    updateJob(vault, jobId, { status: 'running' }, 'ceo', `- ${nowIso()}: heartbeat ${job.checkpoint_step > 0 ? 'resumed' : 'started'} at step ${job.checkpoint_step}`);
    if (job.checkpoint_step === 0) vault.events.emit({ type: 'heartbeat.started', agent: 'ceo', job: jobId, payload: { trigger: job.title } });
  }
  const done = (stepIdx: number, note: string) => { updateJob(vault, jobId, { checkpoint_step: stepIdx + 1 }, 'ceo', `- step ${stepIdx + 1} ${HEARTBEAT_STEPS[stepIdx]}: ${note}`); job = read().data; };
  const cancelled = () => read().data.status === 'cancelled';

  // The situation the CEO plans against: elapsed time, experiments to adopt, owner feedback, edits and finished jobs.
  const situationSummary = (): string => {
    const experiments = vault.list('Experiments', { ext: '.md' }).filter((r) => !r.endsWith('_template.md') && !r.startsWith('Experiments/posts/')).map((r) => ({ r, d: vault.readNoteOrNull(r)?.data as Record<string, unknown> | undefined })).filter((x) => x.d && ['won', 'lost', 'running'].includes(String(x.d.status)));
    const feedback = collectOwnerFeedbackSafe(vault, state.since ?? undefined);
    return [
      `Elapsed since last heartbeat: ${Number.isFinite(state.elapsedHours) ? state.elapsedHours!.toFixed(1) + ' h' : 'first heartbeat'}.`,
      experiments.length ? `Experiments: ${experiments.map((x) => `${String(x.d!.title ?? x.r)} — ${String(x.d!.status)}${x.d!.result ? ` (${String(x.d!.result).slice(0, 80)})` : ''}`).join('; ')}. Adopt winners into the plan; propose Brand/ changes if a winner implies one.` : '',
      feedback.length ? `Owner feedback since last cycle: ${feedback.map((f) => `[${f.role}] ${f.text}`).join(' | ')}.` : '',
      state.ownerEdits?.length ? `Owner edited: ${state.ownerEdits.join(', ')}.` : 'No owner edits.',
      state.finished?.length ? `Jobs finished: ${state.finished.map((f) => `${f.id} (${f.type}, ${f.status}): ${f.summary.slice(0, 120)}`).join('; ')}.` : 'No jobs finished.',
      state.mail?.length ? `Inbound mail: ${state.mail.length}.` : '',
      state.analytics ? `Analytics: ${state.analytics}` : '',
    ].filter(Boolean).join('\n');
  };
  // Archive the previous cycle's plan before the CEO overwrites it (R33: never lose a plan to a rewrite).
  const archivePlan = (): void => {
    const planCur = vault.readTextOrNull('Plans/plan.md') ?? '';
    const prevArchive = vault.list('Plans/archive', { ext: '.md' }).sort().pop();
    if (planCur.trim() && (!prevArchive || vault.readText(prevArchive) !== planCur)) vault.writeText(`Plans/archive/${stampForFilename(now())}-${hbId.slice(-4)}.md`, planCur, 'ceo', { job: jobId });
  };
  /**
   * What the last brief told a team to do next, so this cycle's plan can build on it instead of starting cold.
   *
   * The brief's `## Next action per team` lines are keyed on the team a queued job *carries*, and every job a
   * division lead schedules carries the room's id (`dev`, `qa`, `sales`, `research`) — never the division's. So
   * asking for a division's own line got "nothing queued" almost every cycle and the continuity this promises
   * the division lead was structurally blank (Task 6 review, finding 3). Fall back to the division's rooms,
   * naming the room the action came from; "none recorded" only when nothing anywhere is queued.
   */
  const lastNextAction = (teamId: string): string => {
    const last = vault.list('Runs', { ext: '.md' }).sort().at(-1);
    if (!last) return 'none recorded';
    const section = (vault.readTextOrNull(last) ?? '').split('## Next action per team')[1];
    if (!section) return 'none recorded';
    const lines = section.split('\n');
    const actionFor = (id: string): string | null => {
      const line = lines.find((l) => l.trim().startsWith(`- ${id}:`));
      if (!line) return null;
      const value = line.trim().slice(`- ${id}:`.length).trim();
      return value && value !== 'nothing queued' ? value : null;
    };
    const own = actionFor(teamId);
    if (own) return own;
    for (const room of childTeams(loadOrg(vault), teamId)) {
      const value = actionFor(room.id);
      if (value) return `${value} (${room.id})`;
    }
    return 'none recorded';
  };

  if (job.checkpoint_step > 0 && !state.finished) {
    const m = readJob(vault, jobId)?.body.match(/## Plan\s*\n+```json\n([\s\S]*?)\n```/);
    if (m) { try { const f = JSON.parse(m[1]); state = { ...state, since: f.since, gathered_at: f.gathered_at, elapsedHours: f.elapsedHours ?? Infinity, ownerEdits: f.ownerEdits ?? [], finished: f.finished ?? [], mail: [], analytics: f.analytics ?? null, unansweredOwnerMessages: [] }; } catch { /* fall through with defaults */ } }
  }
  for (let i = job.checkpoint_step; i < HEARTBEAT_STEPS.length; i++) {
    if (cancelled()) return { status: 'cancelled' };
    const step = HEARTBEAT_STEPS[i];
    // Block the heartbeat on a single sub-job (company.plan, division.plan): resumes when it finishes (R33).
    const block = (id: string, log: string): HeartbeatOutcome => {
      updateJob(vault, jobId, { status: 'blocked', blocked_on: { kind: 'job', id, since: nowIso() } }, 'ceo', `- step ${i + 1} ${step}: ${log}`);
      vault.events.emit({ type: 'job.blocked', agent: 'ceo', job: jobId, payload: { reason: 'job', id } });
      return { status: 'blocked', on: { kind: 'job', id } };
    };
    // Block on the first of several sub-jobs (division.plan fan-out); the step re-checks the rest on each revisit.
    const blockMany = (ids: string[], log: string): HeartbeatOutcome => block(ids[0], log);
    // Still waiting → re-block (same start time). Budget exceeded → mark planPending, advance the step, and let
    // the caller continue with a stale plan rather than block the company forever (returns null to continue).
    const waitOrGiveUp = (id: string, giveUpNote: (waitedMin: number) => string): HeartbeatOutcome | null => {
      const since = job.blocked_on?.since;
      const waitedMs = since ? now().getTime() - Date.parse(since) : 0;
      if (waitedMs < PLAN_WAIT_BUDGET_MS) {
        updateJob(vault, jobId, { status: 'blocked', blocked_on: { kind: 'job', id, since: since ?? nowIso() } }, 'ceo');
        return { status: 'blocked', on: { kind: 'job', id } };
      }
      state = { ...state, planPending: true }; saveState(state);
      updateJob(vault, jobId, { status: 'running', blocked_on: undefined }, 'ceo');
      done(i, giveUpNote(Math.round(waitedMs / 60000)));
      return null;
    };
    switch (step) {
      case 'gather': {
        const mail = deps.pollInbox ? await deps.pollInbox().catch(() => []) : [];
        const analytics = deps.pullAnalytics ? await deps.pullAnalytics().catch(() => null) : null;
        const g = gather(vault, now(), mail, analytics);
        // The owner `feedback:` entries this cycle can actually show the CEO are the ones that exist now. Their
        // shas are recorded here and marked delivered at commit; see markFeedbackDelivered for why a fresh read
        // at commit would destroy an entry the owner adds mid-cycle.
        const gatheredFeedback = collectOwnerFeedbackSafe(vault, g.since ?? undefined);
        const feedbackShas = preferenceFeedbackShas(gatheredFeedback);
        // Same idea for `%%cubicle:%%` comments, retired by advancing each note's comment baseline at commit;
        // see markCommentsDelivered for why a system-written note otherwise repeats its comment every restart.
        const commentBaselines = gatheredCommentBaselines(vault, gatheredFeedback);
        state = { ...state, ...g, feedbackShas, commentBaselines }; saveState(state);
        // Persist the gathered facts in the job note so a cache wipe cannot change what later steps see.
        vault.updateNote(`Jobs/${jobId}.md`, (n) => ({ data: n.data, body: setSection(n.body, '## Plan', '```json\n' + JSON.stringify({ since: g.since, gathered_at: g.gathered_at, elapsedHours: Number.isFinite(g.elapsedHours) ? g.elapsedHours : null, ownerEdits: g.ownerEdits, finished: g.finished, mail: g.mail.length, analytics: g.analytics, owner_messages: g.unansweredOwnerMessages.map((m) => m.id) }, null, 2) + '\n```') }), 'ceo', { job: jobId });
        done(i, `elapsed ${Number.isFinite(g.elapsedHours) ? g.elapsedHours.toFixed(1) + 'h' : 'first run'}; ${g.ownerEdits.length} owner edits; ${g.finished.length} jobs finished; ${g.mail.length} mails; ${g.unansweredOwnerMessages.length} owner messages`);
        break;
      }
      case 'reconcile_brand': {
        const touched = (state.ownerEdits ?? []).filter((p) => p.startsWith('Brand/'));
        if (touched.length) {
          const open = listJobs(vault, { status: ['queued', 'running', 'blocked'] }).some((j) => j.type === 'engineer.ship' && /reconcile site with brand/i.test(j.title));
          if (!open) {
            const org = loadOrg(vault);
            const engOffice = officeHolder(org, 'engineering');
            const id = createJob(vault, { type: 'engineer.ship', title: 'Reconcile site with brand', assigned: roleWithTool(org, teamOf(org, engOffice)?.id, 'deploy.site') ?? engOffice, priority: 2, goal: `The owner edited ${touched.join(', ')}. Read every file in Brand/ and update Site/ so it matches the brand kit. Never revert owner edits under Site/. Finish with the list of files you changed.` }, 'ceo');
            done(i, `owner edited ${touched.join(', ')} → queued ${id}`);
          } else done(i, 'reconcile job already open');
        } else done(i, 'no brand edits');
        break;
      }
      case 'answer_owner': {
        const msgs = state.unansweredOwnerMessages ?? [];
        let answered = 0;
        for (const m of msgs) {
          const note = vault.readNoteOrNull(m.path);
          if (!note || note.data.answered) continue;
          const body = note.body;
          const isFirstIdea = !(parseNote(vault.readTextOrNull('Brand/name.md') ?? '').data.name as string) && !listInbox(vault).some((n) => n.data.kind === 'brand_change' && n.data.target === 'Brand/name.md');
          const surprise = /^\s*#?.*surprise me\s*$/im.test(body) || /\bsurprise me\b/i.test(body.split('\n').slice(-3).join('\n'));
          let reply: string | null = null;
          if (surprise) {
            reply = await ask(deps, ceoSystem(vault), `The owner wants you to surprise them. Propose exactly three one-line business ideas a two-person team can start this week with a static website and email, all free to run. Format: a numbered list "1. <name> — <one sentence>".`);
            const ideas = reply ?? '1. Untitled — (no model available; edit this proposal)\n2. —\n3. —';
            createProposal(vault, { id: idFromKey('prop', `${jobId}:${m.id}`), kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'Three company ideas — pick one', body: `${ideas}\n\nSet \`chosen: 1|2|3\` and \`approved: true\`; the chosen line's name becomes the company name.`, job: jobId }, 'ceo');
            reply = `I filed three ideas as a proposal in 00 Inbox/. Pick one with \`chosen:\` and \`approved: true\`.\n\n${ideas}`;
          } else if (isFirstIdea) {
            const r = await ask(deps, ceoSystem(vault), `The owner's business idea:\n\n${body}\n\nReply with exactly two lines:\nNAME: <a short, brandable company name>\nTAGLINE: <one sentence>`);
            const name = r?.match(/NAME:\s*(.+)/i)?.[1]?.trim() ?? 'Untitled Co';
            const tagline = r?.match(/TAGLINE:\s*(.+)/i)?.[1]?.trim() ?? '';
            createProposal(vault, { id: idFromKey('prop', `${jobId}:${m.id}`), kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: `Name the company: ${name}`, body: `## Proposed content\n\n\`\`\`\n---\nname: "${name.replace(/"/g, "'")}"\ntagline: "${tagline.replace(/"/g, "'")}"\nurl: ""\n---\n# ${name}\n\n${tagline}\n\`\`\`\n\nSet \`approved: true\` to adopt.`, job: jobId }, 'ceo');
            reply = `Got it. I proposed the name **${name}** (${tagline}) in 00 Inbox/ — approve or edit it. The CTO is planning the first jobs now.`;
          } else {
            reply = (await ask(deps, ceoSystem(vault), `The owner wrote:\n\n${body}\n\nReply briefly and concretely. If it is an instruction, say what you will do and enqueue nothing yourself (the CTO plans). If it is a question, answer it.`)) ?? 'Noted. (No model was available to draft a fuller reply; I will act on this next cycle.)';
          }
          // Persist the defaults listInbox derived for an owner-typed note (id/created/from/to) so later ticks see a stable, complete note.
          vault.updateNote(m.path, (n) => ({ data: { ...n.data, id: m.id, created: m.created, from: 'owner', to: 'ceo', answered: true }, body: setSection(n.body, '## CEO', reply!) }), 'ceo', { job: jobId });
          vault.events.emit({ type: 'agent.spoke', agent: 'ceo', job: jobId, payload: { to: 'owner', text: reply!.slice(0, 280), id: m.id } });
          answered++;
        }
        done(i, `${answered} owner message(s) answered`);
        break;
      }
      case 'meeting': {
        // Board meeting only when several jobs failed since last time (Phase 5 wires meeting.open).
        const failed = (state.finished ?? []).filter((f) => f.status === 'failed');
        if (failed.length >= 2 && deps.openMeeting) {
          const id = await deps.openMeeting(`Board meeting: ${failed.length} jobs failed since the last heartbeat (${failed.map((f) => f.title).join('; ')}). Decide what changes.`).catch(() => null);
          done(i, id ? `board meeting ${id}` : 'meeting skipped');
        } else done(i, 'no meeting needed');
        break;
      }
      case 'company_plan': {
        // Await company.plan as a sub-job. First visit: create it and block. Second visit: it finished.
        if (!state.companyPlanJob) {
          // A plan already waiting for the owner blocks NEW work only (program design §4): do not write another
          // plan over it, and let this cycle's owner_verdict step re-read that same note — an approval that
          // arrived since the last heartbeat makes the divisions plan today.
          const waiting = openPlanVerdict(vault);
          if (waiting && waiting.data.id !== planVerdictId(hbId)) {
            state = { ...state, planWaiting: waiting.path, verdictProposal: waiting.data.id }; saveState(state);
            // A `plan_verdict` note stays open across the approval itself — until a cycle fans it out and stamps
            // `fanned_out` (see openPlanVerdict) — so `waiting` is just as likely to be a plan the owner has
            // ALREADY approved as one still waiting. Both pause the rewrite for the same reason (do not write a
            // new plan over the plan the divisions are about to plan against), but they are not the same news:
            // a fresh-vault run reported "planning paused — the plan is waiting for your verdict" in the same
            // startup in which the owner's approval had just been read and three division plans fanned out. The
            // note's own flag picks the words.
            const approved = waiting.data.approved === true;
            const note = approved
              ? `planning paused — the plan from ${waiting.data.created.slice(0, 10)} was approved; the divisions plan against it this cycle (${waiting.path})`
              : `planning paused — the plan from ${waiting.data.created.slice(0, 10)} is waiting for your verdict (${waiting.path})`;
            deps.log?.(`heartbeat ${hbId}: ${note}`);
            done(i, note);
            break;
          }
          // Re-planning gate: a fresh, substantive plan with work still open stands (see planningGate). "Owner
          // asked" is read broadly — an unanswered message, any owner edit, or an owner-/forced-triggered
          // heartbeat — because skipping wrongly costs a cycle of stale direction while planning wrongly costs
          // only quota. A board return (state.vetoes) is a rewrite request and is never skipped.
          const openJobs = listJobs(vault, { status: ['queued', 'running'] }).filter((j) => !NON_WORK_TYPES.includes(j.type)).length;
          const ownerAsked = (state.unansweredOwnerMessages?.length ?? 0) > 0 || (state.ownerEdits?.length ?? 0) > 0 || /owner|forced/i.test(job.title);
          // A turned-down plan is a rewrite request in its own right, whether the owner rejected it or the board
          // did on a silent owner — not something the gate should only notice because an owner edit happened to
          // land in the same window.
          const rejected = rejectedPlanVerdict(vault);
          const gate = planningGate({ plan: vault.readTextOrNull('Plans/plan.md') ?? '', now: now(), maxAgeDays: deps.planMaxAgeDays, openJobs, ownerAsked, rewrite: (state.vetoes ?? 0) > 0 || !!rejected });
          if (gate.skip) {
            state = { ...state, planSkipped: { planDate: gate.planDate, open: openJobs } }; saveState(state);
            const note = `planning skipped — the plan from ${gate.planDate} stands and ${openJobs} job${openJobs === 1 ? ' is' : 's are'} still open`;
            deps.log?.(`heartbeat ${hbId}: ${note}`);
            done(i, note);
            break;
          }
          archivePlan();
          const org = loadOrg(vault);
          const teams = divisionTeams(org).map((t) => `${t.id} (lead ${t.lead}: ${t.mission})`).join('; ');
          const streams = listStreams(vault).filter((s) => s.status === 'active').map((s) => `${s.slug} (${s.outcome_metric}, owned by ${s.owner_team})`).join('; ') || 'none yet — the product manager writes Streams/<slug>.md before the first objective';
          const findings = state.boardFindings?.length ? `\n\nThe board returned the previous draft with these findings; address each one:\n${state.boardFindings.map((f) => `- ${f}`).join('\n')}` : '';
          // The seat, not the id (final review I1): the job was already *assigned* by office, but it carried
          // `owner_role: 'ceo'` and a hard-coded `executive` team, which is what WIP and the job tree attribute
          // against — so after a re-staff the plan job went to the right person under the wrong name.
          const chief = officeHolder(org, 'chief_executive');
          const id = createJob(vault, {
            type: 'company.plan', title: state.vetoes ? 'Rewrite the plan after the board' : 'Write the company plan', assigned: chief, priority: 1, parent: jobId, team: teamOf(org, chief)?.id, owner_role: chief,
            goal: `Write this cycle's objectives per division, not jobs.\n\nSituation:\n${situationSummary()}\n\nDivisions: ${teams}.\n\nStreams: ${streams}.\n\nDo: (1) vault.read Plans/plan.md, Memory/lessons.md, the latest Runs/ note, Docs/engineering-handbook.md and Docs/tech-radar.md if present; (2) rewrite Plans/plan.md via vault.write with "# Plan", "## Objectives" and one "### <division id>" subsection per division that has work this cycle (a bullet per objective; every objective for a product division ends with "stream: <slug>" naming a note under Streams/, and states an outcome with a number rather than a feature list; add a line "process: <name>" under an objective that needs a cross-team pipeline from Processes/); a division with nothing to do gets no section; (3) finish with a one-paragraph summary. If one role can do it, don't split it.${findings}`,
          }, 'ceo');
          // This cycle is the rewrite that rejection asked for, so spend the note — but only now that the
          // rewrite exists (Task 6 review, minor 5). Stamped before `createJob`, a kill in between left the
          // rejection spent with no rewrite queued, and the resumed step (no rejection on file, a fresh plan,
          // open work) could let the gate stand the old plan down: the owner's "no" would have vanished.
          if (rejected) vault.updateNote(rejected.path, (n) => ({ data: { ...n.data, fanned_out: hbId }, body: n.body }), 'daemon');
          state = { ...state, companyPlanJob: id }; saveState(state);
          return block(id, `waiting for company.plan ${id}`);
        }
        const sub = readJob(vault, state.companyPlanJob);
        if (!sub || !['done', 'failed', 'cancelled'].includes(sub.data.status)) {
          const w = waitOrGiveUp(state.companyPlanJob, (min) => `company.plan ${state.companyPlanJob} still ${sub?.data.status ?? 'missing'} after ${min} min — planning pending`);
          if (w) return w;
          break;
        }
        if (job.status !== 'running') updateJob(vault, jobId, { status: 'running', blocked_on: undefined }, 'ceo');
        done(i, `company.plan ${sub.data.status}`);
        break;
      }
      case 'board_premortem': {
        if (state.planSkipped || state.planWaiting) { done(i, 'board skipped — the plan was not rewritten'); break; }
        if (state.boardVerdict) { done(i, `board ${state.boardVerdict} (already run)`); break; }
        const org = loadOrg(vault);
        const board = org.teams.board;
        const plan = vault.readTextOrNull('Plans/plan.md') ?? '';
        if (!board || !org.roles[board.lead] || !planIsSubstantive(plan)) { done(i, 'board skipped'); break; }
        const ceo = officeHolder(org, 'chief_executive');
        const session = await runBoardSession(deps, org, plan);
        if (cancelled()) return { status: 'cancelled' };
        // The job note is the record of the session, not a unit of work: it is created with `depends_on` on this
        // heartbeat (so no worker can pick it up while the heartbeat runs) and closed in the same tick. Its id is
        // keyed on the round (`vetoes`), so a crash-resume rewrites the same note while the one allowed rewrite
        // gets a second one — two sessions, two records.
        const boardJob = createJob(vault, {
          id: idFromKey('job', `board:${hbId}:${state.vetoes ?? 0}`), type: 'board.premortem', title: `Board pre-mortem for ${hbId}`,
          assigned: board.lead, priority: 1, parent: jobId, team: board.id, owner_role: ceo,
          depends_on: [jobId], links: [`[[${jobId}]]`],
          goal: `The board read Plans/plan.md for heartbeat ${hbId} and merged ${session.advisors.length} pre-mortems into one verdict.`,
        }, ceo);
        vault.updateNote(`Jobs/${boardJob}.md`, (n) => ({
          data: { ...n.data, status: 'done', checkpoint_step: 1, updated: nowIso() },
          body: setSection(setSection(n.body, '## Advisors', session.transcript), '## Result', '```json\n' + JSON.stringify({ status: 'done', summary: `board ${session.verdict}`, verdict: session.verdict, findings: session.findings }, null, 2) + '\n```'),
        }), board.lead, { job: boardJob });
        vault.events.emit({ type: 'job.done', agent: board.lead, job: boardJob, payload: { type: 'board.premortem', summary: `board ${session.verdict}`, verdict: session.verdict } });
        // Not one advisor answered — every model call in the session failed — is not the same thing as "the
        // board reviewed this and found nothing"; the owner needs to see that difference, not a clean bill of
        // health. The board still doesn't stall the cycle (it advises, the owner rules), so this stays a warning.
        if (session.answered === 0) {
          vault.events.emit({ type: 'daemon.warning', agent: board.lead, job: jobId, payload: { where: 'board_premortem', reason: BOARD_UNREVIEWED_NOTE } });
        }
        // A pre-mortem is a decision the company should be able to look back on (spec §4.1), so the heartbeat
        // writes it as a validated Decisions/ note rather than trusting the board to hand-roll the frontmatter
        // and the six sections. Written BEFORE the verdict becomes durable in the state file: a crash in the
        // other order resumes into the "already run" branch above and the cycle loses its pre-mortem for good.
        try { writeBoardPremortemDecision(vault, hbId, boardJob, session.verdict, session.findings, board.lead, now(), session.answered); }
        catch (err) { vault.events.emit({ type: 'daemon.warning', agent: board.lead, job: jobId, payload: { where: 'board_premortem', message: `could not write the pre-mortem decision note: ${(err as Error).message}` } }); }
        state = { ...state, boardJob, boardVerdict: session.verdict, boardFindings: session.findings }; saveState(state);
        if (session.verdict === 'return') {
          const vetoes = (state.vetoes ?? 0) + 1;
          vault.events.emit({ type: 'plan.vetoed', agent: board.lead, job: jobId, payload: { findings: session.findings, vetoes } });
          if (vetoes === 1) {
            // One rewrite, then the owner rules on whatever the CEO produced: the board cannot stall the company.
            state = { ...state, vetoes, companyPlanJob: undefined, boardJob: undefined, boardVerdict: undefined }; saveState(state);
            updateJob(vault, jobId, { status: 'queued', checkpoint_step: i - 1, blocked_on: undefined }, 'ceo', `- step ${i + 1} board_premortem: returned; rewriting the plan`);
            return { status: 'requeued', attempt: job.attempt };
          }
          state = { ...state, vetoes }; saveState(state);
          createProposal(vault, { kind: 'message', from: ceo, to: 'owner', title: `The board vetoed the plan twice`, body: `Findings:\n${session.findings.map((f) => `- ${f}`).join('\n')}\n\nThe cycle continues with the current plan; reply if you want it changed.`, job: jobId }, ceo);
        }
        done(i, `board ${session.verdict}`);
        break;
      }
      case 'owner_verdict': {
        // No new plan this cycle means nothing to rule on: the plan the divisions are working from was already
        // approved, and `division_plans` skips on `planSkipped` before it ever looks at `state.verdict`.
        if (state.planSkipped) { done(i, 'no new plan to rule on'); break; }
        // A plan with no real objective is nothing to rule on — the board already skipped it for the same reason
        // — and asking the owner to approve an empty page would park the company behind it: with the switch off
        // nobody would ever close that verdict, and `openPlanVerdict` would hold every later cycle's planning.
        if (!state.verdictProposal && !planIsSubstantive(vault.readTextOrNull('Plans/plan.md') ?? '')) {
          state = { ...state, verdict: 'approved' }; saveState(state);
          done(i, 'nothing to rule on: the plan has no objective');
          break;
        }
        const org = loadOrg(vault);
        const ceo = officeHolder(org, 'chief_executive');
        const decidesAfterHours = vault.constitution().board_decides_after_hours;
        if (!state.verdictProposal) {
          const board = state.boardVerdict ?? 'pass';
          const plan = vault.readTextOrNull('Plans/plan.md') ?? '';
          const { id, path: rel } = createProposal(vault, {
            id: planVerdictId(hbId), kind: 'plan_verdict', from: ceo, to: 'owner', job: jobId,
            title: `Approve this cycle's plan`,
            body: planVerdictBody({ board, findings: state.boardFindings ?? [], plan, decidesAfterHours }),
          }, ceo);
          // The board's verdict lives on the note, not in cache state: a later heartbeat rules on this plan after
          // a restart, and it must know what the board actually said.
          vault.updateNote(rel, (n) => ({ data: { ...n.data, board_verdict: board }, body: n.body }), 'daemon');
          state = { ...state, verdictProposal: id }; saveState(state);
        }
        const note = findInboxById(vault, state.verdictProposal!);
        if (!note) { state = { ...state, verdict: 'approved' }; saveState(state); done(i, 'verdict note is gone; treating the plan as approved'); break; }
        // A note with no `board_verdict` is a note whose board session never got stamped — a crash between
        // `createProposal` and the `updateNote` below. Read that as a return, never as a pass: an unstamped note
        // must not auto-approve a plan nobody vouched for once `board_decides_after_hours` elapses.
        const boardVerdict = (note.data as { board_verdict?: string }).board_verdict === 'pass' ? 'pass' as const : 'return' as const;
        const outcome = verdictOutcome({ approved: note.data.approved, created: note.data.created, now: now(), boardVerdict, decidesAfterHours });
        // A verdict the board made on its own is written onto the note as the decision it is — otherwise a
        // board-rejected plan would sit undecided forever and no later cycle could plan at all. Guarded on
        // `approved === null` so a replay of this step stamps the note once, not once per resume.
        if (outcome !== 'pending' && note.data.approved === null) {
          vault.updateNote(note.path, (n) => ({ data: { ...n.data, approved: outcome === 'approved', decided_by: 'board', resolved_at: nowIso() }, body: n.body.trimEnd() + `\n\n---\n_Resolved ${nowIso()}: the board's verdict (${boardVerdict}) stood after ${decidesAfterHours} h._\n` }), 'daemon');
          vault.events.emit({ type: 'proposal.resolved', agent: 'daemon', job: jobId, payload: { id: note.data.id, kind: 'plan_verdict', approved: outcome === 'approved', outcome: 'the board decided' } });
        }
        state = { ...state, verdict: outcome }; saveState(state);
        done(i, `plan verdict: ${outcome}`);
        break;
      }
      case 'division_plans': {
        // The leads already planned against this plan last cycle and their jobs are the open work the gate saw.
        if (state.planSkipped && !state.divisionPlanJobs) { done(i, 'division plans skipped — no new plan to fan out'); break; }
        // A plan with no real objective files no verdict (see owner_verdict) — and the remedy for that must stop
        // at "do not file one", not "proceed as if approved" (Task 6 review, finding 1). `planIsSubstantive` is
        // false for an empty page but also for any plan whose every bullet starts with verify/reconcile, which
        // is a plausible Operations-only cycle: without this the fan-out queued a division.plan for the COO, who
        // may then schedule up to four jobs of its own choosing, with nobody having ruled on any of it.
        if (!state.verdictProposal && !state.divisionPlanJobs && !planIsSubstantive(vault.readTextOrNull('Plans/plan.md') ?? '')) {
          done(i, 'nothing to fan out: the plan has no objective');
          break;
        }
        // "Approved work continues, new work waits": a plan still waiting for the owner fans out nothing, while
        // the jobs an earlier approved plan already put on the queue keep running. `planWaiting` deliberately
        // does NOT skip this step — a plan the owner approved between two heartbeats is exactly the plan this
        // cycle must fan out, and `owner_verdict` above has just re-read that note.
        if (state.verdict !== 'approved' && !state.divisionPlanJobs) { done(i, `no division plans: the plan is ${state.verdict ?? 'not approved'}`); break; }
        const org = loadOrg(vault);
        if (!state.divisionPlanJobs) {
          const plan = vault.readTextOrNull('Plans/plan.md') ?? '';
          const sections = parseObjectiveSections(plan).filter((s) => s.text);
          const divisions = new Set(divisionTeams(org).map((t) => t.id));
          const byDivision = new Map<string, string[]>();
          // Every `process:` expansion this cycle already made, by its idempotency marker (F9). Read once, before
          // the loop creates any: a kill between two expansions must resume into "already done", not a second set.
          const expanded = new Set(listJobs(vault).flatMap((j) => j.links));
          for (const s of sections) {
            // A CEO-written header is prose, not a machine key (F4): match it to a team, then roll the team up to
            // its division, so "### dev" and "### Technology" both land on the CTO. An unmatched header warns
            // instead of silently dropping the whole section.
            const teamId = resolveTeamSection(org, s.team);
            if (!teamId) { vault.events.emit({ type: 'daemon.warning', payload: { where: 'division_plans', message: `no team matches section "${s.team}"` } }); continue; }
            const t = org.teams[teamId];
            for (const m of s.text.matchAll(/^process:\s*(\w+)/gm)) {
              // Process-expanded jobs (parent = this heartbeat, like division.plan) can run for hours across
              // several roles, so the heartbeat must not wait on them — only on the division.plan jobs below
              // (Task 9 review round 2: waiting on rollup() of every child delayed the brief for hours).
              //
              // C1: `expandProcess` mints random ids, and `state.divisionPlanJobs` is not written until the whole
              // fan-out is built, so a kill anywhere in here used to resume with no cache and run the expansion a
              // second time. The marker is keyed on this heartbeat, this team and this process, and goes onto
              // every step's `links`, so a resumed cycle sees its own work and skips it.
              const marker = idFromKey('job', `proc:${hbId}:${teamId}:${m[1]}`);
              if (expanded.has(`[[${marker}]]`)) continue;
              try { expandProcess(vault, m[1], s.text.split('\n')[0].replace(/^- /, ''), { parent: jobId, by: officeHolder(org, 'chief_executive'), team: t.id, owner_role: t.lead, marker }); }
              catch (err) { vault.events.emit({ type: 'daemon.warning', payload: { where: 'division_plans', message: String((err as Error).message) } }); }
            }
            const div = divisionOf(org, teamId);
            if (!div || !divisions.has(div)) { vault.events.emit({ type: 'daemon.warning', payload: { where: 'division_plans', message: `section "${s.team}" belongs to ${div ?? teamId}, which holds no planning round; give that work to a division or to a named role` } }); continue; }
            byDivision.set(div, [...(byDivision.get(div) ?? []), s.text]);
          }
          const ids: string[] = [];
          for (const [divId, texts] of byDivision) {
            const t = org.teams[divId];
            // Streams are owned by the rooms, not by the division, so the error budgets a division lead plans
            // against are every room's in its subtree (SP6 §23) — not just the (usually empty) division's own.
            const budgets = [...new Set(Object.values(org.teams).filter((x) => divisionOf(org, x.id) === divId).flatMap((x) => budgetLines(vault, x.id)))];
            ids.push(createJob(vault, {
              // C1: deterministic, like `board.premortem`'s id and the verdict note's. `state.divisionPlanJobs` is
              // written only after the whole fan-out is built and `blockMany` sets `blocked_on` later still, so a
              // kill in between resumes with neither — and with a random id per division that resume queued a
              // second planning round for every division, each of which schedules up to four more jobs. With the
              // id keyed on (heartbeat, division), `createJob` returns the existing note instead.
              id: idFromKey('job', `divplan:${hbId}:${divId}`),
              type: 'division.plan', title: `Plan ${t.name}`, assigned: t.lead, priority: 1, parent: jobId, team: t.id, owner_role: t.lead,
              goal: divisionPlanGoal(org, t, texts.join('\n\n'), lastNextAction(t.id), researchLead(org) ?? 'research_manager', budgets),
            }, officeHolder(org, 'chief_executive')));
          }
          state = { ...state, divisionPlanJobs: ids }; saveState(state);
          // The plan has now been acted on: stamp the verdict note so `openPlanVerdict` stops holding back the
          // next cycle's planning (see openPlanVerdict — the note stays open across the approval itself).
          const verdictNote = state.verdictProposal ? findInboxById(vault, state.verdictProposal) : null;
          if (verdictNote && !(verdictNote.data as { fanned_out?: string }).fanned_out) {
            vault.updateNote(verdictNote.path, (n) => ({ data: { ...n.data, fanned_out: hbId }, body: n.body }), 'daemon');
          }
          if (!ids.length) { done(i, 'no division plans needed'); break; }
          return blockMany(ids, `waiting for ${ids.length} division plan(s)`);
        }
        const emitPlanned = () => {
          for (const id of state.divisionPlanJobs!) {
            const j = readJob(vault, id);
            if (j?.data.type === 'division.plan' && j.data.status === 'done') vault.events.emit({ type: 'team.planned', agent: j.data.assigned, job: id, payload: { team: j.data.team, jobs: childrenOf(vault, id).map((c) => c.id) } });
          }
        };
        // Readiness comes solely from the division.plan jobs themselves, not rollup() of every heartbeat child — a
        // process: line's expanded jobs (parent = this heartbeat too) are not among state.divisionPlanJobs, so they
        // never gate this step (Task 9 review round 2).
        const openPlans = state.divisionPlanJobs.filter((id) => { const s = readJob(vault, id)?.data.status; return !s || !['done', 'failed', 'cancelled'].includes(s); });
        if (openPlans.length) {
          // Re-block on whichever job is still actually open (firstOpenJob), not always ids[0] — see its doc
          // comment for the busy-loop this fixes (Task 9 review finding 2).
          const blockOn = firstOpenJob(state.divisionPlanJobs, (id) => readJob(vault, id)?.data.status);
          const w = waitOrGiveUp(blockOn, (min) => `${openPlans.length} division plan(s) still open after ${min} min — planning pending`);
          if (w) return w;
          emitPlanned(); // waitOrGiveUp already advanced the checkpoint on give-up
          break;
        }
        if (job.status !== 'running') updateJob(vault, jobId, { status: 'running', blocked_on: undefined }, 'ceo');
        emitPlanned();
        done(i, `${state.divisionPlanJobs.length} division plan(s) finished`);
        break;
      }
      case 'brief': {
        // D8: heartbeat #1 must leave the company with a site, an offer and a channel to work on, whatever the
        // plan turned out to say. Runs after division_plans (every exit path of it, including the give-up one) so a
        // lead's own scheduling wins and only what nobody covered is seeded; later cycles seed nothing.
        const firstStream = seedFirstStream(vault);
        if (firstStream) updateJob(vault, jobId, {}, 'ceo', `- step ${i + 1} ${step}: created the first stream Streams/${firstStream}.md from the owner's idea`);
        const seeded = seedFirstJobs(vault, loadOrg(vault));
        if (seeded.length) updateJob(vault, jobId, {}, 'ceo', `- step ${i + 1} ${step}: seeded ${seeded.length} first job(s)`);
        const runRel = state.runPath ?? `Runs/${stampForFilename(now())}.md`;
        if (!state.runPath) updateJob(vault, jobId, { links: [...job.links, `[[${runRel.replace(/\.md$/, '')}]]`] }, 'ceo');
        const queued = listJobs(vault, { status: 'queued' });
        const blocked = listJobs(vault, { status: 'blocked' }).filter((j) => j.id !== jobId);
        const pending = listInbox(vault).filter((n) => n.data.kind !== 'message' && n.data.approved === null);
        // A migration (spec §1) happened since the previous heartbeat: flag it once so the owner notices the new
        // teams/charters instead of finding out from a stray diff (F10).
        const migrated = vault.events.query({ types: ['org.changed'], from: state.since ?? undefined }).some((e) => e.payload.reason === 'migration');
        // Same window as the other facts (since the previous gather): how much of the cycle ran on the local floor,
        // and which outbound services only pretended. Both were invisible in a live run's briefs for three days.
        const calls = vault.events.query({ types: ['router.call'], from: state.since ?? undefined });
        const modelUse = modelUseRows({ calls: calls.length, downgraded: calls.filter((e) => e.payload.downgraded === true).length }, deps.noCloudKeys?.() ?? false);
        const mocked = deps.env ? mockedServices(deps.env) : [];
        const needsYou = [
          ...pending.map((p) => `- Approve or reject: ${p.body.split('\n')[0].replace(/^#\s*/, '')} (\`${p.path}\`)`),
          ...blocked.filter((j) => j.blocked_on?.kind === 'message').map((j) => `- Answer ${j.assigned}'s question on job ${j.id}`),
          // A job that finished as blocked waits for the owner and nothing else requeues it (loop.ts / requeueUnblocked):
          // unlisted, it sat for a day while the brief said "nothing needs you".
          ...blocked.filter((j) => j.blocked_on?.kind === 'owner').map((j) => `- Decide on ${j.id} (${j.assigned}: ${j.title}) — it stopped: ${jobBlockers(vault, j.id) || 'no reason given'}. Set status: queued to retry it or status: cancelled to drop it`),
          ...(migrated ? ['- The company was reorganised into teams — review Teams/ and the new charters'] : []),
          ...(modelUse.needsYou ? [modelUse.needsYou] : []),
          ...(mockedServicesRow(mocked) ? [mockedServicesRow(mocked)!] : []),
        ];
        const facts = [
          `Elapsed: ${Number.isFinite(state.elapsedHours) ? state.elapsedHours!.toFixed(1) + ' h' : 'first heartbeat'}`,
          ...(state.planPending ? ['Planning: PENDING — the team plans have not finished this cycle; the previous plan stands.'] : []),
          ...(state.planSkipped ? [`Planning: skipped — the plan from ${state.planSkipped.planDate} stands and ${state.planSkipped.open} job${state.planSkipped.open === 1 ? ' is' : 's are'} still open`] : []),
          // A plan can be waiting for the owner (`planWaiting`, filed by an earlier cycle) and still be ruled on
          // by this one, so the "paused" line only stands while the verdict has not come through.
          ...(state.planWaiting && state.verdict !== 'approved' ? [`Planning: paused — a plan is waiting for your verdict (${state.planWaiting})`] : []),
          // The line above already says this for a plan an earlier cycle filed, and both were printed on the
          // same brief (Task 6 review, minor 4). This one is for the plan *this* cycle wrote.
          ...(state.verdict === 'pending' && !state.planWaiting ? ['Planning: this cycle\'s plan is waiting for your verdict; work already approved keeps running'] : []),
          ...(state.verdict === 'rejected' ? ['Planning: the plan was rejected; the CEO rewrites it next cycle and no new work was queued'] : []),
          modelUse.fact,
          ...(deps.env ? [`Outbound services: ${(['deploy', 'email', 'analytics'] as const).map((s) => `${s} ${mocked.includes(s) ? 'mock' : 'live'}`).join(', ')}`] : []),
          `Owner edits: ${state.ownerEdits?.length ? state.ownerEdits.join(', ') : 'none'}`,
          `Finished jobs: ${state.finished?.length ? state.finished.map((f) => `${f.title} (${f.status})`).join('; ') : 'none'}`,
          `Queued next: ${queued.map((j) => `${j.assigned}: ${j.title}`).join('; ') || 'nothing'}`,
          `Blocked: ${blocked.map((j) => `${j.id} on ${j.blocked_on?.kind ?? '?'}`).join('; ') || 'none'}`,
          `Needs owner: ${needsYou.length ? needsYou.join(' | ') : 'nothing'}`,
          `Plan: ${(vault.readTextOrNull('Plans/plan.md') ?? '').slice(0, 1500)}`,
        ].join('\n');
        let drafted = await ask(deps, ceoSystem(vault), `Write the owner's "since you were away" brief from these facts, under 200 words, three sections: ## What happened, ## What's next, ## What needs you. Bullet points only. Do not invent anything not in the facts.\n\n${facts}`, 1200);
        if (drafted && !(/## What happened/.test(drafted) && /## What'?s next/.test(drafted) && /## What needs you/.test(drafted) && drafted.trim().length > 80)) drafted = null; // truncated or malformed → template
        const fallback = `## What happened\n- ${state.finished?.length ? state.finished.map((f) => `${f.title}: ${f.status}`).join('\n- ') : 'Nothing finished since the last heartbeat.'}\n\n## What's next\n- ${queued.length ? queued.map((j) => `${j.assigned}: ${j.title}`).join('\n- ') : 'Waiting on the plan.'}\n\n## What needs you\n${needsYou.length ? needsYou.join('\n') : '- Nothing right now.'}`;
        const org = loadOrg(vault);
        const nextActionPerTeam = Object.values(org.teams).map((t) => `- ${t.id}: ${queued.find((j) => j.team === t.id)?.title ?? 'nothing queued'}`).join('\n');
        const content = stringifyNote({ heartbeat: hbId, at: nowIso(), elapsed_hours: Number.isFinite(state.elapsedHours) ? Number(state.elapsedHours!.toFixed(1)) : null, trigger: job.title }, `# Since you were away\n\n${drafted ?? fallback}\n\n## Next action per team\n\n${nextActionPerTeam}\n\n---\n_Facts used:_\n\n\`\`\`\n${facts}\n\`\`\`\n`);
        vault.writeText(runRel, content, 'ceo', { job: jobId });
        state = { ...state, runPath: runRel }; saveState(state);
        writeQueueMd(vault);
        if (deps.router) vault.writeText('Metrics/quota.md', renderQuotaMarkdown(deps.router.quotaSnapshot(), now()), 'daemon', { generated: true });
        done(i, `wrote ${runRel}`);
        break;
      }
      case 'commit': {
        let commitNote = 'nothing to commit';
        const hash = await autoCommit(vault.root, `cubicle: heartbeat ${hbId}`).catch((e) => { commitNote = `COMMIT FAILED: ${String((e as Error).message ?? e).slice(0, 160)}`; vault.events.emit({ type: 'daemon.warning', payload: { where: 'heartbeat.commit', message: String(e) } }); return null; });
        // The cycle that carried the owner's `feedback:` entries is over, so they are spent (D5). Marking here
        // rather than at collection keeps them available to a mid-cycle plan rewrite and re-delivers them if a
        // cycle never finished; the marker lives in the event log, so `cubicle rebuild` does not resurrect them.
        try { markFeedbackDelivered(vault, state.feedbackShas ?? []); } catch { /* never block the commit */ }
        // The owner comments this cycle carried are spent too: advance each note's baseline so neither the next
        // startup sweep nor the next cycle's collection reports them again (I1).
        try { markCommentsDelivered(vault, state.commentBaselines ?? {}); } catch { /* never block the commit */ }
        updateJob(vault, jobId, { status: 'done', checkpoint_step: HEARTBEAT_STEPS.length }, 'ceo', `- step ${i + 1} commit: ${hash ?? commitNote}`);
        vault.events.emit({ type: 'job.done', agent: 'ceo', job: jobId, payload: { type: 'ceo.heartbeat', summary: `heartbeat ${hbId}` } });
        vault.events.emit({ type: 'heartbeat.completed', agent: 'ceo', job: jobId, payload: { id: hbId, commit: hash, run: state.runPath, trigger: job.title, gathered_at: state.gathered_at ?? nowIso() } });
        return { status: 'done' };
      }
    }
  }
  return { status: 'done' };
}

/** The blockers a job reported in its `## Result` JSON, joined; '' when there is no parsable result. */
function jobBlockers(vault: Vault, id: string): string {
  const body = readJob(vault, id)?.body ?? '';
  const m = body.split('## Result')[1]?.match(/```json\s*([\s\S]*?)```/);
  if (!m) return '';
  try {
    const r = JSON.parse(m[1]) as { blockers?: unknown; summary?: unknown };
    const blockers = Array.isArray(r.blockers) ? r.blockers.map(String).filter(Boolean) : [];
    return (blockers.length ? blockers.join('; ') : typeof r.summary === 'string' ? r.summary : '').slice(0, 200);
  } catch { return ''; }
}

import * as core from '@cubicle/core';
function require_core() { return core; }
export type { JobFrontmatter, CubicleEvent };
