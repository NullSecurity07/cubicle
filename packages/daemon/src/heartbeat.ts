import {
  type Vault, type JobFrontmatter, type InboxFrontmatter, readJob, updateJob, createJob, listJobs, listInbox, findInboxById, nowIso, stampForFilename,
  autoCommit, parseNote, stringifyNote, setSection, createProposal, idFromKey, type CubicleEvent,
  loadOrg, expandProcess, childrenOf, resolveTeamSection, writeDecision, repoRoot, type TeamFrontmatter,
  officeHolder, roleWithTool, teamOf, researchLead, listStreams, type Org, type ModelTier,
  childTeams, subtreeRoles, divisionTeams, divisionOf,
  budgetLines, GATE_JOB_TYPES,
  nextIdeaForBoard, listIdeas, readIdea, updateIdea, ideaBand, bandReason, ideaPath, renderScoreSection, type IdeaBand,
  FOUNDER_BRIEF, keptIdeas, keptIdeaLines, unkeptIdeasNamedIn, IDEA_SCORE_MAX, type IdeaDecision,
  readPressureVerdict, pressureToBoard, pressureFindings, renderRubric, renderBoardSection,
  PRESSURE_VERDICTS, BANNED_HEDGE, RUBRIC_DIMENSIONS, RUBRIC_LABEL, RUBRIC_MAX, PRESSURE_UNANSWERED, PRESSURE_MAX_FLAWS, PRESSURE_HANDBOOK_PATH, PRESSURE_PARTS, type PressurePart,
  PRESSURE_CHAIR_SECTION, chairAnswerText,
  type PressureVerdict, type BoardRubric,
  isLongPrompt, isSkip, asksForSurprise, interviewPhase, INTERVIEW_PATH,
  readLedger, moneyReport, moneyLine, moneyNeedsYou, money, HOUSE, LEDGER_PATH, DEFAULT_CURRENCY, type MoneyReport, type LedgerEntry,
} from '@cubicle/core';
import type { Llm } from '@cubicle/harness';
import { renderQuotaMarkdown, type ModelBudget, type Router } from '@cubicle/router';
import { deployer, emailSender, analytics } from '@cubicle/tools';
import { writeQueueMd } from './queue-md.js';
import { collectOwnerFeedback, markFeedbackDelivered, preferenceFeedbackShas, gatheredCommentBaselines, markCommentsDelivered } from './evolution.js';
import { seedFirstJobs, seedFirstStream } from './first-run.js';
import { currentDiscoveryStatus, askInterview, enqueueDiscovery, openDiscoveryJob, captureInterviewAnswer, ownerSaid, enqueueEstimates, enqueueResearchHalf, estimateJobId, hasApprovedBrief, rejectionAsksForNewIdea } from './discovery.js';
import { writeRunway, accrueModelCost, enqueueRunway, dormancyMessage, revivalMessage } from './money.js';

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
  /**
   * The **house** budget every ask in a cycle runs against (SP4 §4), whoever is speaking — it takes no role for
   * exactly that reason. The house reserve exists so that the heartbeat, the gates and the board session are
   * never starved by a busy division: an advisor who happens to lead a division that spent its quota on ordinary
   * work must still be able to speak at the table. `runHeartbeat` memoises it per cycle (`withCycleBudget`), so
   * a cycle reads it once however many times the room speaks.
   */
  modelBudget?: () => ModelBudget | null | undefined;
}

/**
 * One budget read per cycle. The rule is the harness's (SP4 §4): a budget is read at the start of a piece of
 * work and every call it makes runs against that reading, because a cycle whose advisors silently change tier
 * halfway through a board session produces a transcript nobody can account for. A `deps` object is built fresh
 * for each heartbeat job by the worker pool, so the memo lives exactly as long as the cycle does.
 *
 * Exported for its own test: what it guarantees (one read per cycle) is a rule about calls that did *not*
 * happen, which is far more legible asserted here than inferred from a scripted cycle.
 */
export function withCycleBudget(deps: HeartbeatDeps): HeartbeatDeps {
  const read = deps.modelBudget;
  if (!read) return deps;
  let seen: { budget: ModelBudget | null | undefined } | null = null;
  return { ...deps, modelBudget: () => { if (!seen) seen = { budget: read() }; return seen.budget; } };
}

export type HeartbeatOutcome = { status: 'done' } | { status: 'blocked'; on: { kind: 'job'; id: string } } | { status: 'cancelled' } | { status: 'requeued'; attempt: number };

/**
 * The cycle, in order. Every step has a `case` in the loop below; a step with none would be walked through
 * without doing anything. `owner_verdict` files the `plan_verdict` note the owner rules on and reads the
 * ruling back (Task 5): only an approved plan reaches `division_plans`, while work an earlier plan already
 * queued keeps running throughout.
 *
 * `discovery` and `ideas_board` sit before `company_plan` because that is the order the company thinks in: read
 * what the owner gave us, judge the best idea that came out of it, then plan against what survived.
 *
 * `money` is second, straight after `gather`: nothing should be planned against a company whose position
 * nobody has read, and a company that has spent what the owner gave it stops right here rather than spending a
 * cycle's quota deciding what to do about having no money. It is the one insertion this list has ever taken,
 * and it is safe because a heartbeat checkpointed across the upgrade only re-runs the step it had just
 * finished: `reconcile_brand`, `answer_owner`, `discovery` and `ideas_board` are each already guarded against
 * running twice, which the checkpoint design requires of them anyway.
 */
export const HEARTBEAT_STEPS = ['gather', 'money', 'reconcile_brand', 'answer_owner', 'discovery', 'ideas_board', 'meeting', 'company_plan', 'board_premortem', 'owner_verdict', 'division_plans', 'brief', 'commit'] as const;
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
 *  the free cheap-tier pool.
 *
 *  `board.session` joins them for the same reason `board.premortem` is here: it is the *record* of a board the
 *  heartbeat already sat, closed in the same tick it was created, not work anyone has to do. `discovery` and
 *  `finance.estimate` are deliberately absent — they are what cycle one is *for*, so they count both toward the
 *  heartbeat's completion trigger and toward their team's WIP.
 *
 *  `finance.runway` joins `intelligence` for exactly its reason: it is the daemon's own once-a-day bookkeeping,
 *  not work anyone planned, and counting it would let the company's accounts drive its own cadence.
 *
 *  `pantry.chat` (SP5 §6) is the plainest case of all: it is a coffee break between two people who had nothing
 *  to do, so counting it would have the company's own idleness triggering its next cycle. */
export const NON_WORK_TYPES = ['ceo.heartbeat', 'company.plan', 'critic.premortem', 'team.plan', ...GATE_JOB_TYPES, 'intelligence', 'research.measure', 'division.plan', 'board.premortem', 'board.session', 'finance.runway', 'pantry.chat'];

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
 * Whether a `router.call` event's downgrade counts toward `modelUseRows`'s "check your API keys" row. A division
 * that spent its own model budget (`reason: 'division budget'`) is working as designed — never stopped, just
 * cheaper — and must not be read as a keys or quota outage. Only a `cascade` downgrade (nothing at the asked-for
 * tier had headroom) is evidence of that.
 */
export function isKeyProblemDowngrade(payload: { downgraded?: unknown; reason?: unknown }): boolean {
  return payload.downgraded === true && payload.reason !== 'division budget';
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

/**
 * Whether an owner edit under `00 Inbox/` is worth a whole heartbeat (ruling S-4).
 *
 * Finding S3: four heartbeats in twenty minutes, one per Obsidian save of a proposal, each one re-planning — a
 * plan, two board sessions and a rewrite — and the free strong tier was gone by mid-morning. Every one of those
 * saves was the owner *approving* something, which is the one inbox edit that needs no cycle at all: the
 * dispatcher applies an approval on the very next tick, and the tick runs every few seconds.
 *
 * Two edits still wake one, and they are the two nothing else would act on. An owner **message** is the company
 * being asked a question, and the cycle is what plans against it (the answer itself is a tick sweep — ruling
 * FR-1 — so this is about the plan, not the reply). A **rejection** is a rewrite request: a turned-down plan
 * verdict or founder brief has to reach the CEO, and no other trigger carries it.
 *
 * Read off the note as it stands now rather than off the edit, because that is the state the woken cycle would
 * act on. A note that has since been deleted wakes nothing.
 */
export function inboxEditWakesHeartbeat(vault: Vault, rel: string): boolean {
  const note = listInbox(vault).find((n) => n.path === rel);
  if (!note) return false;
  const d = note.data;
  if (d.kind === 'message') return d.from === 'owner';
  return (d.kind === 'plan_verdict' || d.kind === 'founder_brief') && d.approved === false;
}

/**
 * Whether an owner edit counts as "the owner asked for something" in the re-planning gate — the same question
 * `inboxEditWakesHeartbeat` answers, asked of one path rather than of the wake.
 *
 * The two have to agree. The gate reads `ownerEdits` (every path the owner touched since the last cycle), and
 * an approval is an owner edit under `00 Inbox/` like any other: without this, a cycle woken for some unrelated
 * reason would still find the approval in that list and rewrite the plan the owner had just approved. Outside
 * the inbox every owner edit still counts — a brand note, an idea card, a file dropped in `Discovery/inbox/`
 * are all the owner saying something, and none of them is applied by a tick.
 */
export function ownerEditAsksForWork(vault: Vault, rel: string): boolean {
  return rel.startsWith('00 Inbox/') ? inboxEditWakesHeartbeat(vault, rel) : true;
}

/**
 * The stream an `engineer.ship` the daemon queues *itself* must carry (ruling S-6b).
 *
 * Finding S5: the reconcile-the-site job was created straight from `createJob` with no `stream`, did the whole
 * job, and was then refused at the CI gate — which reads the stream to find the record that says the build is
 * green (§17). The work was done and thrown away, which is the one outcome worth spending a queue slot to
 * avoid, so the choice is made before the job exists rather than after.
 *
 * Exactly one stream is the only case that can be decided without a model: it is the stream. None means there
 * is nothing to ship against at all, and several means picking one is a product decision the daemon has no
 * standing to make — in both, nothing is queued and the caller says why, in the log the owner reads. The same
 * rule `scheduler.request` applies to engineering job types, so a role asking for one and the daemon queueing
 * one cannot disagree.
 */
export function soleStreamForShip(vault: Vault): { stream: string; refuse?: undefined } | { stream?: undefined; refuse: string } {
  const streams = listStreams(vault);
  if (streams.length === 1) return { stream: streams[0].slug };
  return {
    refuse: streams.length === 0
      ? 'no stream exists to ship against, so it would fail the CI gate after doing the work; the product manager writes Streams/<slug>.md first'
      : `${streams.length} streams exist (${streams.map((s) => s.slug).join(', ')}) and nothing here may choose between them; name one on a scheduler.request instead`,
  };
}

/**
 * What the four planning steps log when there is no adopted founder brief (ruling S-1). One string, exported,
 * because it is the only thing a checkpoint log says about a cycle that planned nothing — the tests read it and
 * so does the owner.
 */
export const WAITING_FOR_BRIEF = 'waiting for the founder brief';

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

export interface BoardMerge {
  verdict: 'pass' | 'return';
  findings: string[];
  /** The pressure-test word, on an idea the chair answered properly; null on a plan or on a refusal. */
  pressure: PressureVerdict | null;
  rubric: BoardRubric | null;
  /** Why the answer was not believed, or null. Non-null is what buys the chair its one re-ask. */
  refused: string | null;
}

/**
 * The chair's merged answer, read strictly enough to be trusted and loosely enough never to block the cycle.
 *
 * A **plan** reads as it always has: a `VERDICT: return` line returns it, anything else — a missing line, a
 * hedge, no model at all — passes it. The board advises; it may not stall the company by answering badly.
 *
 * An **idea** is read against the pressure test instead (spec §3), and there the asymmetry flips. A plan that
 * is never judged still runs, so failing open is safe; an idea that is never judged is only parked, so a chair
 * that hedges, names no verdict or invents a fourth outcome is refused, and a refusal that survives its one
 * re-ask returns the idea rather than passing it by default.
 */
export function mergeBoardVerdict(text: string, kind: BoardSubject['kind'] = 'plan'): BoardMerge {
  if (kind !== 'idea') {
    const verdict = /^\s*verdict:\s*return\b/im.test(text) ? 'return' : 'pass';
    const findings = text.split('\n')
      .map((l) => l.trim().match(/^[-*]\s+(.+)$/)?.[1]?.trim())
      .filter((f): f is string => !!f && f.length > 3)
      .slice(0, 4);
    return { verdict, findings, pressure: null, rubric: null, refused: null };
  }
  const read = readPressureVerdict(text);
  if (!read.ok) return { verdict: 'return', findings: [read.reason], pressure: null, rubric: null, refused: read.reason };
  return { verdict: pressureToBoard(read.verdict), findings: pressureFindings(read), pressure: read.verdict, rubric: read.rubric, refused: null };
}

/**
 * What the board records when the re-ask was refused too: the idea is returned, and the refusal leads the
 * findings so the owner reads why before they read what. Exported because it is the whole of Decision 7 — an
 * idea nobody would judge is parked, not passed — and it was the one piece of that path with no direct test.
 */
export function unansweredMerge(m: BoardMerge): BoardMerge {
  return { ...m, verdict: 'return', findings: [PRESSURE_UNANSWERED, ...m.findings].slice(0, PRESSURE_MAX_FLAWS) };
}

/** What one board session judges: this cycle's plan, or one idea out of the funnel. */
export interface BoardSubject {
  kind: 'plan' | 'idea';
  /** What the advisors read. */
  text: string;
  /** One line naming what is being judged: the meeting agenda, the decision note and the whiteboard all use it. */
  title: string;
  /** `Ideas/<slug>` for an idea session; absent for a plan. */
  slug?: string;
}

/**
 * A bare string is this cycle's plan — the shape `runBoardSession` had before ideas existed, kept so SP2's
 * callers and tests read the same as they did.
 */
export function boardSubject(subject: string | BoardSubject): BoardSubject {
  return typeof subject === 'string' ? { kind: 'plan', text: subject, title: "this cycle's plan" } : subject;
}

/** How much of the subject an advisor reads. A plan is long; an idea dossier is one page and goes in whole. */
export const SUBJECT_CHARS = 4000;

/**
 * What each of the five parts asks for. Keyed on `PRESSURE_PARTS` rather than written out as a numbered list,
 * so the advisors' questions, the chair's headings and the `## Three Fatal Flaws` heading `readPressureVerdict`
 * scopes its flaws to all come from core's one ordered list and cannot drift apart.
 */
const ADVISOR_ASK: Record<PressurePart, string> = {
  'Core Assumption': 'the one belief that, if false, makes everything else irrelevant, written as a falsifiable sentence.',
  'Three Fatal Flaws': 'the three most likely ways this dies, each naming a mechanism specific to this idea, this market and this customer. "Competition is tough" and "user acquisition is hard" are not flaws.',
  'Problem Validation': 'vitamin, painkiller or hair on fire, and the ugly workaround these people use today.',
  'Founder-Market Fit': 'why this company is the right one to do it, or plainly why it is not.',
  'Brutal Verdict': `${PRESSURE_VERDICTS.join(', ')} — and one line of why.`,
};

/** The heading each part gets in the chair's merged answer; only the flaws carry a rule about how many. */
const CHAIR_HEADING: Record<PressurePart, string> = {
  'Core Assumption': '',
  'Three Fatal Flaws': ' — at most four bullets, each a flaw specific to this idea and the change that fixes it',
  'Problem Validation': '',
  'Founder-Market Fit': '',
  'Brutal Verdict': '',
};

export function advisorPrompt(s: BoardSubject): string {
  if (s.kind === 'plan') {
    return `This cycle's plan:\n\n${s.text.slice(0, SUBJECT_CHARS)}\n\nImagine the cycle has already failed. Write at most three bullets: the failure mode you see and the one change that would prevent it. One line each, concrete, no preamble.`;
  }
  return [
    'An idea the company is considering:',
    '',
    s.text.slice(0, SUBJECT_CHARS),
    '',
    'Pressure test it the way Paul Graham reads a YC application: assume it is wrong and try to prove it. Answer in five parts, in this order, one or two lines each, no preamble.',
    '',
    ...PRESSURE_PARTS.map((part, i) => `${i + 1}. ${part} — ${ADVISOR_ASK[part]}`),
    '',
    // `Docs/` is a memory-search directory, so naming the handbook is enough for an advisor to fetch it; the
    // path itself is core's one constant (`PRESSURE_HANDBOOK_PATH`) rather than a literal repeated here.
    `Every flaw must be specific to this idea; no generic advice. The catalogue to hunt in is \`${PRESSURE_HANDBOOK_PATH}\`.`,
  ].join('\n');
}

/**
 * The chair's merge prompt. The two subjects must stay distinguishable by their words alone: the scripted
 * models in `scripts/lib/org-llm.ts` route the board's calls on the text of the last prompt, so the plan's says
 * "this plan" and asks for `VERDICT: pass`, and the idea's says "this idea" and asks for one of the three
 * pressure-test words. The plan branch is byte-identical to what it was before SP5b.
 */
export function chairPrompt(s: BoardSubject, transcript: string): string {
  if (s.kind !== 'idea') {
    return `You chair the board. Your advisors wrote:\n\n${transcript}\n\nMerge them into ONE verdict for the owner on this plan. First line exactly "VERDICT: pass" or "VERDICT: return". Then at most four bullets, each a failure mode this plan does not answer and the change that fixes it. Return the plan only if running it as written would waste the cycle; you cannot delay.`;
  }
  return [
    'You chair the board. Your advisors wrote:',
    '',
    transcript,
    '',
    'Merge them into ONE verdict for the owner on this idea. The test is: would Paul Graham fund this in its current form? Write exactly this, in this order:',
    '',
    ...chairFormat(),
  ].join('\n');
}

/**
 * The exact shape the chair's answer must take, written once because the first ask and the one re-ask both have
 * to carry all of it. `askAs` sends a fresh single-turn chat, so a re-asked chair remembers nothing of the first
 * prompt: a re-ask that only said "then the RUBRIC line, then the five parts" would name neither the five rubric
 * labels `parseRubric` looks for nor the `## Three Fatal Flaws` heading `readPressureVerdict` scopes its flaws
 * to, and a chair that complied as well as it could would still lose both — on the one extra call the
 * heartbeat's budget was raised to buy.
 */
function chairFormat(): string[] {
  return [
    `VERDICT: ${PRESSURE_VERDICTS.join(' or ')} — one of those three, and nothing else on that line.`,
    `RUBRIC: ${RUBRIC_DIMENSIONS.map((d) => `${RUBRIC_LABEL[d]} <0-2>`).join(', ')} — out of ${RUBRIC_MAX}.`,
    'WEDGE: <the narrowest useful slice, and the most desperate users to aim it at> — on PIVOT REQUIRED only; leave the line out otherwise.',
    '',
    'Then the five parts, in this order, under these headings:',
    '',
    ...PRESSURE_PARTS.map((part) => `## ${part}${CHAIR_HEADING[part]}`),
    '',
    `Be direct. Never write "${BANNED_HEDGE}" — it is a way of not deciding. You cannot delay, and you do not decide: the owner does.`,
  ];
}

/**
 * What the idea chair may write, in tokens (ruling H4). The plan's chair keeps the 600 it has always had.
 *
 * Before SP5b the chair wrote one verdict line and up to four bullets inside 600 tokens. It is now asked for
 * three machine lines and five headed sections, and an answer that runs past the cap is cut **from the end** —
 * where, under the old ordering, the `WEDGE:` line sat. `PIVOT REQUIRED` is precisely the verdict where the
 * wedge is the point, so a truncated answer degraded to "the board says pivot but named no wedge" on an answer
 * whose chair had named one. The wedge is asked for second now, and the cap doubles: it is one call per
 * session either way, so the number of calls the budget counts does not move (spec §2).
 */
export const CHAIR_IDEA_TOKENS = 1200;

/**
 * The one re-ask a chair gets, and only when it answered badly rather than not at all (spec Decision 6). It
 * names what it is judging and repeats the whole format, because this call starts a conversation of its own.
 */
export function chairReaskPrompt(s: BoardSubject, transcript: string, why: string): string {
  return [
    `That answer was not usable: ${why}.`,
    '',
    `Answer again on "${s.title}", from the same advisors' notes. The first line must be exactly "VERDICT: " followed by one of ${PRESSURE_VERDICTS.join(', ')} and nothing else, then the RUBRIC line, then the WEDGE line if you are pivoting, then the five parts. Decide. In full, the form your answer owes:`,
    '',
    ...chairFormat(),
    '',
    'The advisors wrote:',
    '',
    transcript.slice(0, SUBJECT_CHARS),
  ].join('\n');
}

/** The agenda line the board room shows while the session is open. */
export function boardAgenda(s: BoardSubject): string {
  return s.kind === 'plan' ? 'Pre-mortem: this cycle\'s plan' : `Idea review: ${s.title}`;
}

/**
 * The board room, in at most four model calls (spec §2/§4): each advisor reads the subject in its own voice, the
 * board lead merges the three into one verdict. No sub-jobs, because three advisor jobs plus their gates cost a
 * whole cycle's quota on the free tier and the board must answer inside this heartbeat.
 *
 * The subject is either this cycle's plan or one idea (spec §3). A bare string is the plan, so every SP2 caller
 * reads as it did; the plan's wording is unchanged and the idea asks its own question.
 *
 * Each advisor speaks at its own charter's `model_tier` — the charter is a ceiling on cost, never a floor, so an
 * advisor_investor/advisor_customer charter set to `medium` must not be silently upgraded to `strong`. A missing
 * tier falls back to the board lead's, then to `medium`. `answered` is how many of the (deduplicated) advisors
 * actually got a model response, so a caller can tell "the board passed" from "no model was available at all".
 *
 * On an idea the chair gets **one** re-ask, and only when it answered badly — a hedge, a fourth outcome, no
 * verdict line — so the session costs three advisors plus one or two chair calls and never more. `calls` is
 * that count, and `reasked` says whether the extra one was spent. A chair that is silent on the re-ask spends
 * no third call and no refusal: the session falls open to `pass` and `chairLost` says so (spec Decision 6).
 *
 * `chairText` is the chair's merged answer itself, on an idea it actually judged — the five parts the owner's
 * prompt asks for. Before ruling H3 it went out of scope here and three of the five reached nobody.
 */
export async function runBoardSession(
  deps: HeartbeatDeps, org: Org, subject: string | BoardSubject,
): Promise<BoardMerge & { advisors: string[]; transcript: string; answered: number; subject: BoardSubject; calls: number; reasked: boolean; chairLost: string | null; chairText: string }> {
  const vault = deps.vault;
  const s = boardSubject(subject);
  // Its one caller guards on `org.teams.board` first, but this is exported and tests call it directly: an org
  // with no board room must fail as "the board passed unreviewed", not as a TypeError inside the cycle (M5).
  // Nothing is emitted on this path either: no advisor walked to the table, so the room must not light up.
  const board = org.teams.board;
  if (!board) return { verdict: 'pass', findings: [], pressure: null, rubric: null, refused: null, advisors: [], transcript: '', answered: 0, subject: s, calls: 0, reasked: false, chairLost: null, chairText: '' };
  const advisors = [...new Set([board.lead, ...board.members])].filter((r) => org.roles[r]).slice(0, 3);
  // A board whose charters are all gone is the same as no board: nobody walks to the table (review of Task 7).
  if (advisors.length === 0) return { verdict: 'pass', findings: [], pressure: null, rubric: null, refused: null, advisors: [], transcript: '', answered: 0, subject: s, calls: 0, reasked: false, chairLost: null, chairText: '' };
  const leadTier = org.roles[board.lead]?.model_tier ?? 'medium';
  const tierFor = (roleId: string): ModelTier => org.roles[roleId]?.model_tier ?? leadTier;
  // The board room, on screen: the advisors walk to the table, the owner's chair fills, and the whiteboard says
  // the board is sitting. Emitted here rather than in the caller so the plan pre-mortem gets it too — it never
  // has, which is why the owner's chair has not once been used in a live run (spec §6.1).
  const meetingId = idFromKey('meet', `board:${s.kind}:${s.slug ?? 'plan'}:${advisors.join('-')}:${nowIso()}`);
  vault.events.emit({ type: 'meeting.opened', agent: board.lead, payload: { id: meetingId, room: 'board', participants: advisors, agenda: boardAgenda(s), subject: s.kind, title: s.title } });
  const notes: string[] = [];
  let answered = 0;
  for (const a of advisors) {
    const text = await askAs(deps, a, advisorSystem(vault, a), advisorPrompt(s), 500, tierFor(a));
    if (text) answered++;
    vault.events.emit({ type: 'meeting.turn', agent: a, payload: { id: meetingId, round: 1, text: (text ?? '(no answer)').slice(0, 280) } });
    notes.push(`### ${advisorName(vault, a)}\n${text ?? '(no answer: no model was available)'}`);
  }
  const transcript = notes.join('\n\n');
  const chair = (prompt: string): Promise<string | null> => askAs(deps, board.lead, advisorSystem(vault, board.lead), prompt, s.kind === 'idea' ? CHAIR_IDEA_TOKENS : 600, leadTier);
  const merged = await chair(chairPrompt(s, transcript));
  // No answer at all is not a bad answer. With no model available the session falls open exactly as it did
  // before the pressure test existed, and `answered === 0` is what tells the owner nobody reviewed anything —
  // spending the re-ask on a silent model would buy a second silence (spec Decision 6).
  let merge: BoardMerge = merged === null
    ? { verdict: 'pass', findings: [], pressure: null, rubric: null, refused: null }
    : mergeBoardVerdict(merged, s.kind);
  // The chair's own five parts, kept rather than dropped on the floor (ruling H3). Only on an idea, and only
  // when the answer was believed: the plan pre-mortem's record is byte-identical to what it always was, and a
  // refused answer is quoted back to the chair in the re-ask rather than filed as the board's verdict.
  let chairText = s.kind === 'idea' && merged !== null && !merge.refused ? merged : '';
  let calls = advisors.length + 1;
  let reasked = false;
  let chairLost: string | null = null;
  if (merge.refused) {
    reasked = true;
    calls++;
    const again = await chair(chairReaskPrompt(s, transcript, merge.refused));
    if (again === null) {
      // Silence is not a second refusal. Decision 7 returns an idea the chair declined to judge *twice*; here
      // it declined once and then the model was gone, which is Decision 6's zero-model path arriving late, so
      // the session falls open and `chairLost` carries the reason to the warning and the decision note.
      chairLost = chairLostNote(merge.refused);
      merge = { verdict: 'pass', findings: [], pressure: null, rubric: null, refused: null };
    } else {
      const second = mergeBoardVerdict(again, s.kind);
      merge = second.refused ? unansweredMerge(second) : second;
      chairText = second.refused ? '' : again;
    }
  }
  const out = { ...merge, advisors, transcript, answered, subject: s, calls, reasked, chairLost, chairText };
  vault.events.emit({
    type: 'meeting.closed', agent: board.lead,
    payload: {
      id: meetingId, room: 'board', subject: s.kind, title: s.title, verdict: out.verdict, findings: out.findings,
      // Strings, not objects: the viewer depends on no package here, and a second copy of the rubric's
      // arithmetic over there is a second place for it to be wrong (spec Decision 12).
      pressure: out.pressure ?? '', rubric: out.rubric ? renderRubric(out.rubric) : '',
      decision: `VERDICT: ${out.pressure ?? out.verdict}`,
    },
  });
  return out;
}

/**
 * What the board says when the chair's first answer was refused and the re-ask found no model at all. Silence
 * is never a refusal (spec Decision 6), so this is not "the chair would not decide twice running": one model
 * call disagreed with the form and the next one never happened, which is the zero-model path reached late. The
 * idea passes, as it would have if no model had answered from the start, and this sentence is why — on the
 * `daemon.warning` the owner reads and in the `Decisions/` note, so neither reads as a clean bill of health.
 */
export function chairLostNote(reason: string): string {
  return `the chair's first answer was refused (${reason}) and the second call had no model, so the idea passed unreviewed`;
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
  return writeBoardDecision(vault, `premortem-${hbId}`, {
    verdict, findings, decidedBy, now, answered, cycle: hbId, inputs: ['[[Plans/plan]]'],
    unreviewedNote: BOARD_UNREVIEWED_NOTE,
    noFindingsNote: 'The board found nothing in this plan likely to sink the cycle.',
    context: `Pre-mortem for heartbeat ${hbId}: the board read this cycle's \`Plans/plan.md\` and imagined the cycle had already failed. The advisors' own words are in [[${boardJobId}]].`,
    options: '- Run the plan as the CEO wrote it\n- Return it to the CEO to rewrite before the owner rules on it',
    chosen: verdict === 'pass' ? 'Run the plan as written.' : 'Return the plan to the CEO for one rewrite.',
    why: verdict === 'pass' ? 'The plan survived the pre-mortem.' : 'The board found failure modes the plan does not answer.',
    risksHeading: 'Most likely ways this cycle fails, and what would prevent each:',
    reviewDays: 7,
  });
}

/** Everything one board decision note needs beyond the four paragraphs every board session writes the same way. */
export interface BoardDecisionOpts {
  verdict: 'pass' | 'return';
  findings: string[];
  decidedBy: string;
  now: Date;
  /** How many advisors actually got a model response; 0 with a `pass` is "nobody reviewed this". */
  answered: number;
  /** The `cycle` field: the heartbeat for a pre-mortem, the board.session job for an idea. */
  cycle: string;
  inputs: string[];
  /** The note's own words for "no advisor answered", with the right subject in them. */
  unreviewedNote: string;
  /** `chairLostNote(...)` when the chair's answer was refused and the re-ask found no model; else absent. */
  chairLost?: string;
  /** What the risks section says when the board passed and raised nothing. */
  noFindingsNote: string;
  context: string;
  options: string;
  chosen: string;
  /** Why, for a reviewed session; the unreviewed note replaces it when `answered` is 0 on a pass. */
  why: string;
  /** The line above the risk bullets. */
  risksHeading: string;
  /** How many days out the note asks to be reviewed. */
  reviewDays: number;
  /** A closing line under the risks, when the note needs one. */
  epilogue?: string;
}

/**
 * One board session as a `Decisions/` note. The plan's pre-mortem and an idea's session differ only in their
 * words — the six sections, the `adopted`/`proposed` rule (the board passed it, or it returned it and the thing
 * it judged is not the thing that will be built) and the "no advisor answered" honesty are the same decision
 * written twice, so they are written once here.
 */
export function writeBoardDecision(vault: Vault, id: string, o: BoardDecisionOpts): string {
  // Two ways a `pass` can mean "nobody judged this": no advisor answered at all, or the chair's one answer was
  // refused and the re-ask found no model. Either way the note must not read as a clean bill of health.
  const unjudged = o.verdict === 'pass' ? (o.answered === 0 ? o.unreviewedNote : o.chairLost ?? '') : '';
  const risks = unjudged ? `- ${unjudged}` : o.findings.length ? o.findings.map((f) => `- ${f}`).join('\n') : `- ${o.noFindingsNote}`;
  return writeDecision(vault, id, {
    decided_by: o.decidedBy, cycle: o.cycle, status: o.verdict === 'pass' ? 'adopted' : 'proposed', inputs: o.inputs,
  }, {
    context: o.context,
    options: o.options,
    chosen: o.chosen,
    why: unjudged || o.why,
    expected_effect: `${o.risksHeading}\n\n${risks}${o.epilogue ? `\n\n${o.epilogue}` : ''}`,
    review_date: new Date(o.now.getTime() + o.reviewDays * 24 * 3600_000).toISOString().slice(0, 10),
  }, o.decidedBy);
}

/**
 * The board's verdict on one idea as `Decisions/board-<slug>.md`: `adopted` when the board passed it,
 * `proposed` when it returned it (the idea it judged is not the idea that will be built). Keyed on the slug so
 * a resumed cycle rewrites the same note instead of filing a second one.
 */
export function writeBoardSessionDecision(
  vault: Vault, slug: string, title: string, boardJobId: string,
  verdict: 'pass' | 'return', findings: string[], decidedBy: string, now: Date, answered = 1, chairLost?: string | null, chair?: string,
): string {
  // The chair's merged answer goes in the context, whole: this note is the durable record of the session, and
  // a record of a five-part verdict that keeps one word of it is not a record (ruling H3).
  const chairSaid = chair?.trim() ? `\n\nThe chair merged them into this:\n\n${chairAnswerText(chair)}` : '';
  return writeBoardDecision(vault, `board-${slug}`, {
    verdict, findings, decidedBy, now, answered, chairLost: chairLost ?? undefined, cycle: boardJobId, inputs: [`[[Ideas/${slug}]]`],
    unreviewedNote: BOARD_UNREVIEWED_NOTE.replace('the plan passed', 'the idea passed'),
    noFindingsNote: 'The board found nothing in this idea likely to sink a quarter.',
    context: `The board read the dossier for "${title}" ([[Ideas/${slug}]]) and imagined the company had already spent a quarter on it and failed. The advisors' own words are in [[${boardJobId}]].${chairSaid}`,
    options: '- Keep it: the company plans against it\n- Park it: the failure modes are real but answerable later\n- Scrap it: it should not be built',
    chosen: verdict === 'pass' ? 'The board saw nothing that would sink it; the recommendation stands.' : 'The board returned it; the recommendation drops to park until its findings are answered.',
    why: verdict === 'pass' ? 'The dossier answered the failure modes the board could name.' : 'The dossier does not answer failure modes the board could name.',
    risksHeading: 'Most likely ways this idea fails, and what would prevent each:',
    epilogue: 'The owner rules; the board advises.',
    reviewDays: 30,
  });
}

/**
 * The findings the board adds to a plan that draws on ideas nobody kept (spec §4). A deterministic check rather
 * than a line in the advisors' prompt: a model asked to notice a slug in a wall of markdown will miss it, and
 * this is the one rule the whole idea pipeline exists to enforce.
 */
export function unkeptIdeaFindings(unkept: { id: string; decision: IdeaDecision }[]): string[] {
  return unkept.map((i) => i.decision === 'undecided'
    ? `The plan draws on [[Ideas/${i.id}]], which the board has not ruled on yet — plan around it or let this cycle's board session judge it first.`
    : `The plan draws on [[Ideas/${i.id}]], which the company ${i.decision === 'scrap' ? 'scrapped' : 'parked'}. A plan may only draw on kept ideas.`);
}

/**
 * A plan is returned for a parked or scrapped idea; an undecided one is a finding, not a return (spec §4).
 *
 * The asymmetry is deliberate: parked and scrapped are rulings the company made, and planning against one
 * ignores them. Undecided is the state every card starts in, and returning a plan for it would deadlock cycle
 * one — nothing is kept yet, the board rules on one card a cycle, and the CEO would rewrite for ever.
 */
export function unkeptForcesReturn(unkept: { decision: IdeaDecision }[]): boolean {
  return unkept.some((i) => i.decision === 'park' || i.decision === 'scrap');
}

/** A returned plan carries at most this many findings: enough to act on, few enough for the CEO to answer all. */
export const MAX_PLAN_FINDINGS = 6;
/** …of which the deterministic guard takes at most this many whenever the board also spoke. */
export const MAX_GUARD_FINDINGS = 3;

/**
 * The findings one plan return carries, from the guard's warnings and the board's own.
 *
 * The board's always survive. `mergeBoardVerdict` already caps them at four and they are the failure modes the
 * CEO has to answer, whereas the guard's warnings are one sentence repeated per idea — so the guard takes what
 * is left of the budget and never more than three, rather than a plan naming six undecided ideas crowding the
 * board out of its own return (review T10, finding 1). With no session at all — the guard returned the plan
 * before the board sat — the guard has the whole budget to itself.
 */
export function planReturnFindings(guard: string[], session: string[] = []): string[] {
  const share = session.length ? Math.max(0, Math.min(MAX_GUARD_FINDINGS, MAX_PLAN_FINDINGS - session.length)) : MAX_PLAN_FINDINGS;
  return [...guard.slice(0, share), ...session].slice(0, MAX_PLAN_FINDINGS);
}

/** The `## Kept ideas` block in the company.plan goal: what the plan may draw on, and nothing else. */
export function keptIdeasGoalBlock(lines: string[]): string {
  if (!lines.length) return `Kept ideas: none yet. Plan from ${FOUNDER_BRIEF}; the board rules on the idea cards this cycle and the next plan draws on whatever it keeps.`;
  return `Kept ideas — the only ideas this plan may draw on (spec §4; naming a parked or scrapped one gets the plan returned), each out of ${IDEA_SCORE_MAX}:\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

/** Stable per idea, so a resumed cycle rules on the note it already filed. */
export function ideaVerdictKey(slug: string): string { return `idea-verdict:${slug}`; }

/** What the owner is being asked to rule on, and everything the ruling should be made from. */
export interface IdeaVerdictFacts {
  slug: string;
  title: string;
  score: number;
  band: IdeaBand;
  reason: string;
  board: 'pass' | 'return';
  findings: string[];
  /** The board's pressure-test word and rubric, when it ran one. Both absent on a card judged before SP5b. */
  pressure?: string;
  rubric?: BoardRubric | null;
  /** The chair's merged five-part answer, as it stands on the card. Absent on a card judged before ruling H3. */
  chair?: string;
  research: string;
  estimate: string;
  decidesAfterHours: number;
}

/**
 * What the owner reads when an idea lands in their inbox: the recommendation and the arithmetic behind it, the
 * board's findings, and the two numbers anyone would ask for. `chosen:` is how they overrule it, so the owner
 * can keep something the score parked without editing the card by hand.
 */
export function ideaVerdictBody(f: IdeaVerdictFacts): string {
  const findings = f.findings.length ? f.findings.map((x) => `- ${x}`).join('\n') : '- The board raised nothing that would sink this.';
  const deadline = f.decidesAfterHours > 0
    ? `; after ${f.decidesAfterHours} h the recommendation stands (\`board_decides_after_hours\` in Memory/constitution.md)`
    : '';
  return [
    `**${f.title}** — [[Ideas/${f.slug}]]`,
    '',
    `Recommendation: **${f.band}**. ${f.reason}`,
    '',
    `- Research: ${f.research || 'none linked'}`,
    `- Cost: ${f.estimate || 'not estimated'}`,
    `- Board: ${f.board === 'pass' ? 'passed' : 'returned'}`,
    ...(f.pressure ? [`- Pressure test: ${f.pressure}${f.rubric ? ` · rubric ${renderRubric(f.rubric)}` : ''}`] : []),
    '',
    '## What the board said',
    '',
    findings,
    // The chair's own words, under the bullets: the flaw bullets are a subset of them, and the three parts the
    // owner asked for that the bullets cannot carry — the core assumption, the problem validation and the
    // founder-market fit — are the reason the board was asked at all (ruling H3).
    ...(f.chair?.trim() ? ['', PRESSURE_CHAIR_SECTION, '', chairAnswerText(f.chair)] : []),
    '',
    `Set \`approved: true\` to take the recommendation (**${f.band}**), or \`approved: false\` to park it and tell me why. To overrule the recommendation, set \`chosen: 1\` for keep, \`2\` for park or \`3\` for scrap and \`approved: true\`${deadline}.`,
  ].join('\n');
}

/**
 * The findings the board raised on a card, read back off its `## The board` section. The verdict note is
 * rebuilt from the card, so what it says the board said has to come from the card and not from a cache that a
 * kill may have taken with it. The placeholder the section carries when the board raised nothing is not a
 * finding, so it is dropped rather than quoted back as one.
 */
export function cardBoardFindings(body: string): string[] {
  return boardSectionOf(body).split(/^#{2,6}[ \t]/m)[0].split('\n')
    .map((l) => l.trim().match(/^-\s+(.+)$/)?.[1]?.trim())
    .filter((f): f is string => !!f && f !== 'Nothing they thought would sink it.');
}

/** The `## The board` section of a card, up to the next one. '' when the board has not sat. */
function boardSectionOf(body: string): string {
  return (body.split(/^## The board[ \t]*$/m)[1] ?? '').split(/^## /m)[0];
}

/**
 * The chair's own merged answer, read back off the card (ruling H3). The verdict note is rebuilt from the card
 * — that is how a kill between the stamp and `createProposal` is recovered — so the five parts the owner reads
 * in the note have to come from the same place as the findings above them, not from a session variable this
 * process may no longer have.
 */
export function cardBoardChair(body: string): string {
  const section = boardSectionOf(body);
  const at = section.search(new RegExp(`^${PRESSURE_CHAIR_SECTION}[ \\t]*$`, 'm'));
  return at < 0 ? '' : section.slice(at).replace(/^.*\n/, '').trim();
}

/** The board job note's heading for the chair's merged answer, beneath the advisors' own notes. */
export const BOARD_JOB_CHAIR_SECTION = '## The chair';

/** The job note with the chair's merge written under the advisors, or untouched when the chair said nothing. */
function withChair(body: string, chair: string): string {
  return chair.trim() ? setSection(body, BOARD_JOB_CHAIR_SECTION, chairAnswerText(chair)) : body;
}

/**
 * File the `idea_verdict` note the owner rules on, built from the card as it now stands. Separate from the step
 * because it is called twice: once when the board sits, and once as recovery for a card a kill left stamped with
 * a verdict and no note — `nextIdeaForBoard` skips a stamped card, so without the second call that idea could
 * never be kept, parked or scrapped by anyone. The id is derived from the slug, so the recovery is a no-op
 * whenever the first call landed. Returns null for a card the board has not judged.
 */
export function fileIdeaVerdict(
  vault: Vault, slug: string, opts: { from: string; job?: string; findings: string[] },
): { id: string; path: string; band: IdeaBand; filed: boolean } | null {
  const card = readIdea(vault, slug);
  if (!card || card.data.board_verdict === null) return null;
  const board = card.data.board_verdict;
  const score = card.data.score ?? 0;
  const value = card.data.score_inputs.value ?? 3;
  const band = ideaBand(score, { value, board });
  const id = idFromKey('prop', ideaVerdictKey(slug));
  const existing = findInboxById(vault, id);
  if (existing) return { id, path: existing.path, band, filed: false };
  const reason = bandReason(score, { value, board });
  const { path: rel } = createProposal(vault, {
    id, kind: 'idea_verdict', from: opts.from, to: 'owner', job: opts.job,
    target: ideaPath(slug), title: `Keep, park or scrap: ${card.data.title}`,
    body: ideaVerdictBody({
      slug, title: card.data.title, score, band, reason, board,
      findings: opts.findings,
      pressure: card.data.board_pressure || undefined, rubric: card.data.board_rubric, chair: cardBoardChair(card.body),
      research: card.data.research, estimate: card.data.estimate,
      decidesAfterHours: vault.constitution().board_decides_after_hours,
    }),
  }, opts.from);
  // The band, the board's verdict and the arithmetic behind them live on the note, not in cache state: a later
  // heartbeat closes this verdict after a restart, and it must rule on — and explain — what was recommended
  // then, not a recomputation. `band_reason` rides along so the sentence the owner is shown when their
  // approval is applied is the same sentence they read when they approved it.
  vault.updateNote(rel, (n) => ({ data: { ...n.data, board_verdict: board, band, band_reason: reason }, body: n.body }), 'daemon');
  return { id, path: rel, band, filed: true };
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
  unansweredOwnerMessages: OwnerMessage[];
  /**
   * How many messages the owner typed since the last cycle gathered, **answered or not**.
   *
   * The re-planning gate below asks "did the owner ask for something?", and until FR-1 the only reading of
   * that was "a message nobody has answered". Now the tick answers within seconds of the owner hitting enter,
   * so by the time a cycle gathers there is usually nothing unanswered left — and the plan the owner's message
   * was meant to shake loose would be skipped because the CEO had been quick about replying to it.
   */
  ownerMessages: number;
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
  const ownerMessages = listInbox(vault).filter((n) => n.data.kind === 'message' && n.data.from === 'owner' && n.data.to === 'ceo' && (!since || String(n.data.created ?? '') > since)).length;
  return { since, gathered_at: now.toISOString(), elapsedHours, ownerEdits, finished, mail, analytics, unansweredOwnerMessages: unansweredOwnerMessages(vault), ownerMessages };
}

/**
 * One tool-less completion spoken by `roleId`. Returns null on any failure: no step blocks on a model. `tier`
 * defaults to `strong` for the CEO's own asks (via `ask`, below); board advisors pass their own charter's tier
 * so a `medium`-tier charter is never silently upgraded (the charter is a cost ceiling, not a floor).
 */
async function askAs(deps: HeartbeatDeps, roleId: string, system: string, user: string, maxTokens = 800, tier: ModelTier = 'strong'): Promise<string | null> {
  try {
    // `roleId` is who speaks; the budget is the house's whoever that is (SP4 §4, and `HeartbeatDeps.modelBudget`):
    // a board advisor who leads a division that spent its quota this morning must still get a strong model at
    // the table, because the house reserve is there to keep the cycle and the board off the divisions' meter.
    // …and the calls are *stamped* with the house, so the bank screen counts them there too. Without the stamp
    // `divisionSpend` had to infer a pool from the speaker's role, and an advisor whose `team:` names a division
    // raised that division's `used` for a call the house had paid for.
    const budget = deps.modelBudget?.() ?? undefined;
    const r = await deps.llm.chat({ tier, needsTools: false, roleId, budget, budgetDivision: budget ? HOUSE : undefined }, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens });
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

/** One owner message nobody has answered, as both callers of `answerOwnerMessages` see it. */
export interface OwnerMessage { path: string; id: string; created: string; body: string }

/** Every owner message in the cabin the CEO has not answered yet. One read of the inbox, one filter, two callers. */
export function unansweredOwnerMessages(vault: Vault): OwnerMessage[] {
  return listInbox(vault)
    .filter((n) => n.data.kind === 'message' && n.data.from === 'owner' && n.data.to === 'ceo' && !n.data.answered)
    .map((n) => ({ path: n.path, id: n.data.id, created: n.data.created, body: n.body }));
}

/**
 * How long a claim on an owner message stands before another caller takes the note over.
 *
 * Long enough for the slowest reply anyone has seen (a strong-tier call on the "surprise me" path ran 1–30 s
 * in the owner's live run), short enough that a process killed mid-answer does not strand the note: the next
 * caller past this window answers it.
 */
export const ANSWER_CLAIM_MS = 5 * 60_000;

/** The three-ideas ask. Sent twice at most: once on the prompt budget, once with room for a thinking model. */
const SURPRISE_ASK = 'The owner wants you to surprise them. Propose exactly three one-line business ideas a two-person team can start this week with a static website and email, all free to run. Format: a numbered list "1. <name> — <one sentence>". Write all three lines in full and write nothing else.';
/** The re-ask's ceiling. Generous on purpose: the first run's reply was cut off mid-sentence at the default. */
export const SURPRISE_RETRY_TOKENS = 1200;
/** What the CEO says when two asks did not produce three whole ideas. Honest, and it says what to do next. */
export const SURPRISE_FAILED = 'I could not get three complete ideas from the model this time — ask me again in a minute, or type an idea.';

/**
 * The numbered ideas in a reply, truncated ones dropped, renumbered 1–3.
 *
 * Finding F1: the first live run's reply was cut at 30 tokens (`finish_reason: length`) and the half of it that
 * arrived — a name, an em dash, and nothing after it — was filed as the three-ideas proposal unchecked. The
 * owner was then asked to pick one of three ideas, two of which did not exist. So a line counts only when the
 * model finished writing it, and the proposal is filed only with three of them (ruling FR-2).
 *
 * Renumbering matters: the proposal says `chosen: 1|2|3` and the dispatcher matches that number against the
 * line, so three ideas that arrived as 1, 3 and 4 have to read 1, 2, 3 in the note the owner picks from.
 */
export function completeIdeaLines(reply: string | null): string[] {
  const lines = (reply ?? '').split('\n').map((l) => l.trim()).filter((l) => /^\d+\.\s+\S/.test(l));
  return lines.filter(ideaLineComplete).slice(0, 3).map((l, i) => l.replace(/^\d+\.\s*/, `${i + 1}. `));
}

/** One idea line the model finished: a name, and a sentence after the dash rather than the dash it stopped on. */
export function ideaLineComplete(line: string): boolean {
  const body = line.replace(/^\d+\.\s*/, '').trim();
  if (!body) return false;
  if (/[—–\-:,;]$/.test(body)) return false;                    // cut off mid-line, which is what truncation looks like
  const sentence = body.split(/\s+[—–-]\s+|:\s+/)[1];
  return sentence === undefined ? body.split(/\s+/).length >= 3 : sentence.trim().length > 0;
}

/**
 * Answer every owner message nobody has answered yet, and return how many were answered.
 *
 * This is the `answer_owner` heartbeat step, lifted out of it so the daemon's tick can run exactly the same
 * code (ruling FR-1). Finding F2: the owner's follow-up went unanswered through a whole live run because
 * answering was a step of a cycle that was blocked on a discovery job, and the tick would not even look while
 * a heartbeat was open. The owner types into a chat window; a chat window that goes quiet for ten minutes is
 * broken, whatever the company is doing behind it.
 *
 * Every id it derives comes from the *message*, never from the caller, so no two callers can file two
 * proposals for one message whichever of them runs first — and the note is **claimed before the model call**,
 * not after it (whole-branch review, Important 1). Reading `answered` and writing it either side of a 30 s
 * model call left a window the cabin and the cycle both walked into: `onChat` starts a reply *and* requests a
 * heartbeat, and `answer_owner` is step 3 of 13 with no model call ahead of it, so the cycle reached the same
 * note while the cabin was still waiting on the model. The owner saw the CEO answer twice and the company paid
 * twice. The claim is stamped with no `await` between the read and the write, which is what makes it a claim.
 */
export async function answerOwnerMessages(
  deps: HeartbeatDeps,
  vault: Vault,
  msgs: readonly OwnerMessage[],
  opts: { jobId?: string; now?: () => Date } = {},
): Promise<number> {
  const now = opts.now ?? deps.now ?? (() => new Date());
  const jobId = opts.jobId;
  let answered = 0;
  for (const m of msgs) {
    const note = vault.readNoteOrNull(m.path);
    if (!note || note.data.answered) continue;
    // Somebody else is on this one, and has not been gone long enough to have died: leave it to them.
    const claimed = Date.parse(String(note.data.answering ?? ''));
    if (Number.isFinite(claimed) && now().getTime() - claimed < ANSWER_CLAIM_MS) continue;
    claim(vault, m.path, now().toISOString(), jobId);
    try {
      answered += await answerOne(deps, vault, m, note.body, now, jobId);
    } catch (err) {
      // The claim is cleared on the way out so the note is not stranded until the window expires. The error is
      // the caller's — the tick's sweep and the cabin's own catch both turn it into a `daemon.warning`.
      release(vault, m.path, jobId);
      throw err;
    }
  }
  return answered;
}

/** Stamp the note as being answered right now. Never inside an `await`: see `answerOwnerMessages`. */
function claim(vault: Vault, path: string, at: string, jobId?: string): void {
  vault.updateNote(path, (n) => ({ data: { ...n.data, answering: at }, body: n.body }), 'ceo', { job: jobId });
}

/** Drop the claim, leaving the note exactly as it was for whoever comes next. */
function release(vault: Vault, path: string, jobId?: string): void {
  try {
    vault.updateNote(path, (n) => { const { answering: _claim, ...rest } = n.data as Record<string, unknown>; return { data: rest, body: n.body }; }, 'ceo', { job: jobId });
  } catch { /* the note is gone, or unwritable: the claim expires on its own */ }
}

/**
 * The surprise path: three complete ideas filed as the `brand_change` the owner picks from, and the sentence
 * the CEO says about it. Returns `SURPRISE_FAILED` — and files nothing — when two asks did not produce three
 * whole lines (finding F1, ruling FR-2).
 *
 * Lifted out of `answerOne` because ruling S-2 gives it a second caller: an owner who rejects the founder brief
 * with "get a new idea" is asking for exactly this, and a second copy of the ask, the re-ask, the completeness
 * check and the proposal body is a second place for the three ideas to stop being three.
 *
 * `propId` is the caller's, and is always derived from the thing being answered (the message id, the rejected
 * proposal's id), so `createProposal`'s idempotent replay is what stops two callers filing two trios.
 */
async function proposeThreeIdeas(deps: HeartbeatDeps, vault: Vault, opts: { propId: string; jobId?: string }): Promise<string> {
  let raw = await ask(deps, ceoSystem(vault), SURPRISE_ASK);
  let ideas = completeIdeaLines(raw);
  // One re-ask, with room for a model that thinks before it answers (finding F1). Beyond that the CEO says
  // so rather than filing a proposal the owner cannot pick from.
  if (ideas.length < 3) {
    raw = await ask(deps, ceoSystem(vault), SURPRISE_ASK, SURPRISE_RETRY_TOKENS);
    ideas = completeIdeaLines(raw);
  }
  if (ideas.length < 3) return SURPRISE_FAILED;
  const three = ideas.join('\n');
  createProposal(vault, { id: opts.propId, kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'Three company ideas — pick one', body: `${three}\n\nSet \`chosen: 1|2|3\` and \`approved: true\`; the chosen line's name becomes the company name.`, job: opts.jobId }, 'ceo');
  return `I filed three ideas as a proposal in 00 Inbox/. Pick one with \`chosen:\` and \`approved: true\`.\n\n${three}`;
}

/**
 * What the chief executive says when the owner turns the founder brief down (ruling S-2 (a)).
 *
 * The rejection is answered where the owner will see it — a `message` note in `00 Inbox/`, the same shape the
 * cabin interview uses — because the note they rejected is closed the moment the dispatcher stamps it, and the
 * live run's owner got nothing at all back for "rejected make it better or get a new idea".
 *
 * One short paragraph, and it has to be true, so the facts are assembled here and the model only phrases them:
 * their own words, the re-run that is already queued, and — when they asked for a different idea — the three
 * fresh ones the CEO has just filed for them to pick from. A model that cannot answer costs the phrasing, never
 * the message: the template below says the same things.
 *
 * Every id it derives comes from the rejected proposal, so a replayed tick re-finds this message and that trio
 * rather than filing a second of either.
 */
export async function answerRejectedBrief(
  deps: HeartbeatDeps,
  note: { path: string; data: InboxFrontmatter; body: string },
  ctx: { comment: string; brief: string; discoveryJob: string },
  opts: { jobId?: string } = {},
): Promise<string> {
  const vault = deps.vault;
  const ceo = officeHolder(loadOrg(vault), 'chief_executive');
  const said = ctx.comment.trim();
  // The surprise path, not a copy of it: an owner who says "get a new idea" is asking for the same three lines
  // the cabin's "surprise me" files, and they must arrive in the same note shape or `ownerPick` will not read
  // the pick back.
  const trio = rejectionAsksForNewIdea(said)
    ? await proposeThreeIdeas(deps, vault, { propId: idFromKey('prop', `brief-rejected-ideas:${note.data.id}`), jobId: opts.jobId })
    : null;
  const facts = [
    said ? `They turned the founder brief down and said: "${said}".` : 'They turned the founder brief down without saying why.',
    `The research office has already been given job ${ctx.discoveryJob}: it re-reads everything, including what they just said, and files a new founder brief for them to approve.`,
    trio && trio !== SURPRISE_FAILED ? 'You have also filed three fresh company ideas in 00 Inbox/ for them to pick one of; the brief follows what they pick.' : '',
    trio === SURPRISE_FAILED ? 'You tried to put three fresh ideas to them and the model would not produce three complete ones, so you will try again shortly.' : '',
    'Nothing is planned until a brief is adopted.',
  ].filter(Boolean).join(' ');
  const drafted = await ask(deps, ceoSystem(vault), `The owner rejected the founder brief. Write ONE short paragraph to them, under 80 words, saying what the company will do about it. No headings, no bullets, no preamble. Say only what these facts say:\n\n${facts}`, 400);
  const paragraph = drafted?.trim() || [
    said ? `Understood — "${said}".` : 'Understood.',
    `I have put the brief back to the research office as ${ctx.discoveryJob}: they re-read everything, your words included, and file a new one for you to approve.`,
    trio && trio !== SURPRISE_FAILED ? 'Three fresh ideas are in 00 Inbox/ for you to pick from.' : '',
    'Nothing is planned until a brief is adopted.',
  ].filter(Boolean).join(' ');
  const body = [
    paragraph,
    ...(trio ? ['', '---', '', trio] : []),
  ].join('\n');
  createProposal(vault, {
    id: idFromKey('prop', `brief-rejected:${note.data.id}`), kind: 'message', from: ceo, to: 'owner',
    title: 'About the founder brief you turned down', body, job: opts.jobId,
  }, ceo);
  vault.events.emit({ type: 'agent.spoke', agent: ceo, job: opts.jobId ?? null, payload: { to: 'owner', text: paragraph.slice(0, 280), proposal: note.data.id } });
  return paragraph;
}

/** One message: the reply the CEO drafts for it, the proposal it may file, and the note it writes back. */
async function answerOne(deps: HeartbeatDeps, vault: Vault, m: OwnerMessage, body: string, now: () => Date, jobId?: string): Promise<number> {
  const isFirstIdea = !(parseNote(vault.readTextOrNull('Brand/name.md') ?? '').data.name as string) && !listInbox(vault).some((n) => n.data.kind === 'brand_change' && n.data.target === 'Brand/name.md');
  // The same predicate `isDiscoveryMaterial` uses, from core: the cabin and discovery must agree about what a
  // request for three ideas looks like, or a brief that merely mentions the phrase is dropped by one and
  // promised a reading by the other (whole-branch review, Important 3).
  const surprise = asksForSurprise(body);
  // What the owner typed, without the `# title` line the cabin prepends. The interview has to read the
  // stripped text: `isSkip` is anchored to the whole string, so an owner who types `skip` (note body
  // `# skip\n\nskip`) would otherwise be recorded as having answered the six questions with "skip".
  const said = ownerSaid(body);
  // An open interview is closed by an answer, or by "skip" — never by a question or a quick note (ruling
  // FR-6; it used to close on whatever came next, so a complaint became the six answers). This is a vault
  // write, not a model call: the interview must not cost a cycle's quota to conduct.
  const closedInterview = captureInterviewAnswer(vault, said, now());
  const interviewStillOpen = !closedInterview && interviewPhase(vault.readTextOrNull(INTERVIEW_PATH)) === 'asked';
  // A document, not a one-line idea: discovery reads it, and the CEO does not try to squeeze a company
  // name out of its first sentence.
  const longPrompt = isLongPrompt(body);
  const propId = idFromKey('prop', `owner-answer:${m.id}`);
  let reply: string | null = null;
  if (surprise) {
    reply = await proposeThreeIdeas(deps, vault, { propId, jobId });
    // "skip" is a refusal to be interviewed, not a business idea: naming the company after it would be
    // absurd, and it belongs in the general reply, which already says the interview was closed.
  } else if (isFirstIdea && !longPrompt && !isSkip(said)) {
    const r = await ask(deps, ceoSystem(vault), `The owner's business idea:\n\n${body}\n\nReply with exactly two lines:\nNAME: <a short, brandable company name>\nTAGLINE: <one sentence>`);
    const name = r?.match(/NAME:\s*(.+)/i)?.[1]?.trim() ?? 'Untitled Co';
    const tagline = r?.match(/TAGLINE:\s*(.+)/i)?.[1]?.trim() ?? '';
    createProposal(vault, { id: propId, kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: `Name the company: ${name}`, body: `## Proposed content\n\n\`\`\`\n---\nname: "${name.replace(/"/g, "'")}"\ntagline: "${tagline.replace(/"/g, "'")}"\nurl: ""\n---\n# ${name}\n\n${tagline}\n\`\`\`\n\nSet \`approved: true\` to adopt.`, job: jobId }, 'ceo');
    reply = `Got it. I proposed the name **${name}** (${tagline}) in 00 Inbox/ — approve or edit it. The CTO is planning the first jobs now.`;
  } else {
    const extra = [
      closedInterview ? 'You had asked them six questions; their reply is now in Discovery/interview.md and the research office will read it.' : '',
      // The owner has to be told, in the reply they are already reading, that the six questions are still
      // waiting — nothing else will say it, and the interview no longer closes itself on this message (FR-6).
      interviewStillOpen ? 'The six questions you sent them in the cabin are still open: what they just wrote is not an answer to them. End your reply with one line saying so — an answer in their own words, or "skip", is all you need.' : '',
      longPrompt ? 'This is a long brief rather than a one-line idea: the research office is reading it in full and will file a founder brief for them to approve. Do not try to summarise it yourself.' : '',
    ].filter(Boolean).join(' ');
    reply = (await ask(deps, ceoSystem(vault), `The owner wrote:\n\n${body}\n\n${extra}\n\nReply briefly and concretely. If it is an instruction, say what you will do and enqueue nothing yourself (the divisions plan). If it is a question, answer it.`)) ?? 'Noted. (No model was available to draft a fuller reply; I will act on this next cycle.)';
  }
  // Persist the defaults listInbox derived for an owner-typed note (id/created/from/to) so later ticks see a
  // stable, complete note — and drop the claim in the same write that makes it unnecessary.
  vault.updateNote(m.path, (n) => {
    const { answering: _claim, ...rest } = n.data as Record<string, unknown>;
    return { data: { ...rest, id: m.id, created: m.created, from: 'owner', to: 'ceo', answered: true }, body: setSection(n.body, '## CEO', reply!) };
  }, 'ceo', { job: jobId });
  vault.events.emit({ type: 'agent.spoke', agent: 'ceo', job: jobId, payload: { to: 'owner', text: reply!.slice(0, 280), id: m.id } });
  return 1;
}

/**
 * Run or resume a heartbeat job. Each step is checkpointed to the job note (`checkpoint_step` = index of
 * the last completed step + 1). Waiting for `cto.plan` uses `blocked_on: {kind: job}` so a kill during
 * planning resumes at the wait (R33).
 */
export async function runHeartbeat(rawDeps: HeartbeatDeps, jobId: string): Promise<HeartbeatOutcome> {
  const deps = withCycleBudget(rawDeps);
  const vault = deps.vault;
  const now = deps.now ?? (() => new Date());
  const read = () => readJob(vault, jobId)!;
  let job = read().data;
  if (job.status === 'cancelled') return { status: 'cancelled' };
  const stateRel = `.cubicle/jobs/${jobId}.heartbeat.json`;
  const loadState = (): Partial<Gathered & { discoveryJob?: string; companyPlanJob?: string; boardJob?: string; boardVerdict?: 'pass' | 'return'; boardFindings?: string[]; vetoes?: number; planWaiting?: string; verdictProposal?: string; verdict?: 'approved' | 'rejected' | 'pending'; divisionPlanJobs?: string[]; runPath?: string; heartbeatId: string; planPending?: boolean; discoveryPending?: boolean; estimateJobs?: string[]; researchJobs?: string[]; estimatesPending?: boolean; ideaJudged?: string; planSkipped?: { planDate: string; open: number }; feedbackShas?: string[]; commentBaselines?: Record<string, string[]> }> => { try { return JSON.parse(vault.readTextOrNull(stateRel) ?? '{}'); } catch { return {}; } };
  const saveState = (s: object) => { const { atomicWriteSync } = require_core(); atomicWriteSync(vault.abs(stateRel), JSON.stringify(s, null, 2)); };
  let state = loadState();
  const hbId = jobId;
  // The vault is the source of truth: recover what the cache may have lost.
  if (job.blocked_on?.kind === 'job') {
    const atStep = HEARTBEAT_STEPS[job.checkpoint_step];
    if (atStep === 'discovery' && !state.discoveryJob) state = { ...state, discoveryJob: job.blocked_on.id };
    if (atStep === 'company_plan' && !state.companyPlanJob) state = { ...state, companyPlanJob: job.blocked_on.id };
    // `owner_verdict` counts as well as `division_plans`: a heartbeat that blocked on the fan-out before its
    // checkpoint reached `division_plans` is still parked on division.plan jobs it already created, and a lost cache
    // file must not make it create them a second time.
    if ((atStep === 'division_plans' || atStep === 'owner_verdict') && !state.divisionPlanJobs) {
      const ids = listJobs(vault).filter((j) => j.parent === jobId && j.type === 'division.plan').map((j) => j.id);
      if (ids.length) state = { ...state, divisionPlanJobs: ids };
    }
    // `ideas_board` blocks on its estimates before its own checkpoint advances — the caseless `discovery` step
    // leaves `atStep` at `discovery` — so this one keys off the blocked job's type instead. Without it a
    // cache-less resume calls `enqueueEstimates` again, gets `[]` back because those jobs already exist, stops
    // waiting, finds no scored card, and loses the cycle's board session with nothing said about it.
    if (!state.estimateJobs && readJob(vault, job.blocked_on.id)?.data.type === 'finance.estimate') {
      const open = listJobs(vault, { status: ['queued', 'running', 'blocked'] }).filter((j) => j.type === 'finance.estimate').map((j) => j.id);
      state = { ...state, estimateJobs: [...new Set([job.blocked_on.id, ...open])] };
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

  /**
   * The company's position, with the **read** guarded and not only the arithmetic.
   *
   * `readLedger` can throw where `moneyReport` cannot: `Vault.readTextOrNull` is `existsSync(p) ? readFileSync(p)
   * : null`, so a path that exists but is not a readable file raises — `EISDIR` for a folder left where the book
   * should be, `EACCES` for a file the owner chmodded or a restore that changed ownership. Both of this cycle's
   * money reads (the `money` step, and the brief's deliberate re-read) went through it bare, and the step loop has
   * no per-step catch, so an unreadable book killed the whole cycle: no money line, no plan, no brief, and a
   * heartbeat left `running` to be requeued straight back into the same throw. That is exactly what the invariant
   * written three times on this branch forbids — money can make the company cheaper, it must never make it silent.
   *
   * So a book that cannot be read reads as "nothing is known" for this one cycle: an empty position, which is
   * deliberately **not** dormant (dormancy needs a live `capital` row, so nothing is stopped and no worker is
   * parked), one `daemon.warning` naming the path and the error, and a money line that says the book could not be
   * read rather than presenting a fabricated zero as the company's truth.
   *
   * Said **once per cycle**, not once per read: the two reads are one fault, and the event log is something the
   * owner reads. Once per *cycle* rather than once per pass, because a cycle blocks on its own planning jobs and
   * comes back here minutes later — the warning is stamped with the heartbeat job, so the resume that finally
   * reaches the brief finds the row this cycle already wrote instead of repeating it.
   */
  let ledgerReadWarned = false;
  interface MoneyRead { report: MoneyReport; unreadable: boolean }
  const readMoney = (): MoneyRead => {
    try { return { report: moneyReport(readLedger(vault), now()), unreadable: false }; }
    catch (err) {
      const told = ledgerReadWarned || vault.events.query({ types: ['daemon.warning'], job: jobId }).some((e) => e.payload.where === 'money.ledger');
      ledgerReadWarned = true;
      if (!told) vault.events.emit({ type: 'daemon.warning', job: jobId, payload: { where: 'money.ledger', path: LEDGER_PATH, message: `${LEDGER_PATH} could not be read: ${String((err as Error).message ?? err)}`.slice(0, 200) } });
      return { report: moneyReport({ currency: DEFAULT_CURRENCY, entries: [], problems: [], missing: true }, now()), unreadable: true };
    }
  };
  /** The cycle's one money line — or, when the book could not be read, the honest replacement for it. */
  const moneyLineOf = (m: MoneyRead): string =>
    m.unreadable ? `Money: \`${LEDGER_PATH}\` could not be read, so the company's position is unknown this cycle (the \`money.ledger\` warning on the log says why)` : moneyLine(m.report);

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

  /**
   * Ruling S-1: nothing is planned before the owner has adopted a founder brief.
   *
   * The second live run planned two seconds after the owner typed "surprise me" — before a single idea card
   * existed — and planned again after they rejected the brief the company had written. The design is
   * discovery → board → plan, and the brief is the document every plan is written *against*: without one, the
   * CEO is asked to plan for a company nobody has described yet, which is how that run's plan came to be about
   * a company the owner had never mentioned.
   *
   * Only the four planning steps wait. Money, discovery, the ideas board and the weekly meeting keep running —
   * the cycle that reads the owner's material and files the brief is the same cycle, and stopping it would
   * deadlock the company on the document it is trying to write.
   */
  const planningWaitsForBrief = (): boolean => !hasApprovedBrief(vault);

  if (job.checkpoint_step > 0 && !state.finished) {
    const m = readJob(vault, jobId)?.body.match(/## Plan\s*\n+```json\n([\s\S]*?)\n```/);
    if (m) { try { const f = JSON.parse(m[1]); state = { ...state, since: f.since, gathered_at: f.gathered_at, elapsedHours: f.elapsedHours ?? Infinity, ownerEdits: f.ownerEdits ?? [], finished: f.finished ?? [], mail: [], analytics: f.analytics ?? null, unansweredOwnerMessages: [], ownerMessages: f.owner_messages_since ?? (f.owner_messages ?? []).length }; } catch { /* fall through with defaults */ } }
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
    // Still waiting → re-block (same start time). Budget exceeded → raise `flag`, advance the step, and let the
    // caller carry on rather than block the company forever (returns null to continue). The flag is a parameter
    // because what the brief must then say about the cycle depends on what was being waited for: a stuck
    // estimate is not a stuck plan, and saying "Planning: PENDING" about one would be a lie.
    const waitBounded = (id: string, flag: 'planPending' | 'estimatesPending' | 'discoveryPending', giveUpNote: (waitedMin: number) => string, advance = true): HeartbeatOutcome | null => {
      const since = job.blocked_on?.since;
      const waitedMs = since ? now().getTime() - Date.parse(since) : 0;
      if (waitedMs < PLAN_WAIT_BUDGET_MS) {
        updateJob(vault, jobId, { status: 'blocked', blocked_on: { kind: 'job', id, since: since ?? nowIso() } }, 'ceo');
        return { status: 'blocked', on: { kind: 'job', id } };
      }
      state = { ...state, [flag]: true }; saveState(state);
      updateJob(vault, jobId, { status: 'running', blocked_on: undefined }, 'ceo');
      // `advance` is false for a step that gives up and then carries on doing its real work: advancing the
      // checkpoint here would both log the step twice and, worse, resume a kill during that work at the NEXT
      // step — silently skipping what the give-up was supposed to let the step get on with.
      if (advance) done(i, giveUpNote(Math.round(waitedMs / 60000)));
      else updateJob(vault, jobId, {}, 'ceo', `- step ${i + 1} ${step}: ${giveUpNote(Math.round(waitedMs / 60000))}`);
      return null;
    };
    /** The planning steps' wait: giving up leaves the previous plan standing, advances the step, and the brief says so. */
    const waitOrGiveUp = (id: string, giveUpNote: (waitedMin: number) => string): HeartbeatOutcome | null => waitBounded(id, 'planPending', giveUpNote);
    /** `ideas_board`'s wait: giving up means the board chooses from the cards that were priced in time, and the
     *  step stays where it is so a kill during the session it then runs resumes at the board, not past it. */
    const waitForEstimates = (id: string, giveUpNote: (waitedMin: number) => string): HeartbeatOutcome | null => waitBounded(id, 'estimatesPending', giveUpNote, false);
    /** `discovery`'s wait: giving up means the cycle plans from whatever the owner's material already said. */
    const waitForDiscovery = (id: string, giveUpNote: (waitedMin: number) => string): HeartbeatOutcome | null => waitBounded(id, 'discoveryPending', giveUpNote);
    /** The same wait for a job found in the vault rather than in the cache, which then gets on with the step. */
    const waitForStrandedDiscovery = (id: string, giveUpNote: (waitedMin: number) => string): HeartbeatOutcome | null => waitBounded(id, 'discoveryPending', giveUpNote, false);
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
        vault.updateNote(`Jobs/${jobId}.md`, (n) => ({ data: n.data, body: setSection(n.body, '## Plan', '```json\n' + JSON.stringify({ since: g.since, gathered_at: g.gathered_at, elapsedHours: Number.isFinite(g.elapsedHours) ? g.elapsedHours : null, ownerEdits: g.ownerEdits, finished: g.finished, mail: g.mail.length, analytics: g.analytics, owner_messages: g.unansweredOwnerMessages.map((m) => m.id), owner_messages_since: g.ownerMessages }, null, 2) + '\n```') }), 'ceo', { job: jobId });
        done(i, `elapsed ${Number.isFinite(g.elapsedHours) ? g.elapsedHours.toFixed(1) + 'h' : 'first run'}; ${g.ownerEdits.length} owner edits; ${g.finished.length} jobs finished; ${g.mail.length} mails; ${g.unansweredOwnerMessages.length} owner messages`);
        break;
      }
      // The company's money, before anything is planned against it. Pure arithmetic: not one model call on
      // either path. Yesterday's paid-model spend is accrued *first*, so the position this cycle reads — and
      // the dormancy it may declare — includes it.
      case 'money': {
        const org = loadOrg(vault);
        const cfg = deps.router?.config ?? null;
        // Guarded like its neighbour below, and for the same reason, written three times on this branch: money
        // can make the company cheaper, it must never make it silent. An accrual that cannot be booked — a disk
        // that will not take the write, `appendEntry` giving up after its retries, a `router.call` row whose
        // payload the arithmetic cannot use — would otherwise throw out of step 1 with nothing to catch it: no
        // brief, no plan, no money line, and a heartbeat that requeues straight back into the same throw.
        let accrued: LedgerEntry | null = null;
        if (cfg) {
          try { accrued = accrueModelCost(vault, cfg, now()); }
          catch (err) { vault.events.emit({ type: 'daemon.warning', payload: { where: 'money.accrual', message: String((err as Error).message ?? err).slice(0, 200) } }); }
        }
        const position = readMoney();
        const report: MoneyReport = position.report;
        const line = moneyLineOf(position);
        // The runway note is a report, never the cycle: a providers file the router could not parse must not
        // stop the company from working. And a book that could not be read regenerates **nothing**: the page is
        // the owner's standing record of the position, and overwriting the last true one with a stand-in empty
        // report would turn a read fault into a false statement that outlives the cycle that made it.
        if (cfg && !position.unreadable) {
          // The report this step already derived, rather than a second identical read of the same book.
          try { writeRunway(vault, org, cfg, now(), report); }
          catch (err) { vault.events.emit({ type: 'daemon.warning', payload: { where: 'money.runway', message: String((err as Error).message ?? err).slice(0, 200) } }); }
        }
        if (report.dormant) {
          const msg = dormancyMessage(vault, org, report, now());
          // Jump to the brief in ONE write. Every step in between plans, judges or queues work, and a company
          // with no money does none of those — least of all spend a cycle's model quota writing about having no
          // money. Checkpointing the step first and correcting it afterwards left a kill window in which the
          // job resumed at `reconcile_brand`: `money` would not run again, nothing would re-check dormancy
          // until `brief`, and a stopped company would spend a full planning round getting there. A kill before
          // this write resumes at `money` and re-derives dormancy from the ledger; a kill after it resumes at
          // `brief`. Both are correct, and there is no third state.
          const briefIdx = HEARTBEAT_STEPS.indexOf('brief');
          updateJob(vault, jobId, { checkpoint_step: briefIdx }, 'ceo',
            `- step ${i + 1} money: dormant: ${money(report.cashCents, report.currency)} cash${msg ? `; told the owner (${msg})` : '; the owner has already been told'}\n- steps ${i + 2}–${briefIdx}: skipped — the company is dormant`);
          job = read().data;
          i = briefIdx - 1;
          break;
        }
        const revived = revivalMessage(vault, org, report, now());
        // `enqueueRunway` reads the book again to write the CFO's figures into the job's goal, so it is the third
        // read this step makes and it would throw out of the cycle just as the first two used to. There is also
        // nothing for the CFO to say: a job whose goal carried a stand-in zero would have them write an opinion
        // about a position nobody has. No position, no runway job — tomorrow's cycle queues one.
        const runway = position.unreadable ? null : enqueueRunway(vault, org, now());
        done(i, [
          line,
          revived ? `told the owner we are back (${revived})` : '',
          accrued ? `accrued ${money(accrued.cents, report.currency)} of model cost` : '',
          position.unreadable ? 'no runway job and no runway note: neither can be written from a position nobody could read'
            : runway ? `queued ${runway}` : 'today\'s runway job is already queued',
        ].filter(Boolean).join('; '));
        break;
      }
      case 'reconcile_brand': {
        const touched = (state.ownerEdits ?? []).filter((p) => p.startsWith('Brand/'));
        if (touched.length) {
          const open = listJobs(vault, { status: ['queued', 'running', 'blocked'] }).some((j) => j.type === 'engineer.ship' && /reconcile site with brand/i.test(j.title));
          if (!open) {
            // Ruling S-6b: a ship with no stream fails the CI gate *after* doing the work, so the stream is
            // settled before the job exists. With none or several to choose from the cycle says so and queues
            // nothing — the brand edit is still on file and the next cycle re-reads it.
            const s = soleStreamForShip(vault);
            if (s.refuse) { done(i, `owner edited ${touched.join(', ')} → no reconcile job: ${s.refuse}`); break; }
            const org = loadOrg(vault);
            const engOffice = officeHolder(org, 'engineering');
            const id = createJob(vault, { type: 'engineer.ship', title: 'Reconcile site with brand', assigned: roleWithTool(org, teamOf(org, engOffice)?.id, 'deploy.site') ?? engOffice, priority: 2, stream: s.stream, goal: `The owner edited ${touched.join(', ')}. Read every file in Brand/ and update Site/ so it matches the brand kit. Never revert owner edits under Site/. Finish with the list of files you changed.` }, 'ceo');
            done(i, `owner edited ${touched.join(', ')} → queued ${id} on stream ${s.stream}`);
          } else done(i, 'reconcile job already open');
        } else done(i, 'no brand edits');
        break;
      }
      case 'answer_owner': {
        // The body of this step is `answerOwnerMessages`, which the daemon's tick also runs (ruling FR-1): the
        // owner is answered within seconds of typing, whatever the cycle is doing. Whichever gets there first,
        // the other finds `answered: true` and does nothing.
        const answered = await answerOwnerMessages(deps, vault, state.unansweredOwnerMessages ?? [], { jobId, now });
        done(i, `${answered} owner message(s) answered`);
        break;
      }
      // Read what the owner gave us before anything is planned against it. Three outcomes, and only one of them
      // costs a model call: ask the founder interview (a proposal and a transcript, no model), queue one
      // discovery job and block on it, or note why neither applies and move on. `currentDiscoveryStatus` derives
      // all three from the vault, and the job's id is a digest of its material, so a replayed cycle re-finds the
      // job it queued rather than queueing a second one.
      case 'discovery': {
        const org = loadOrg(vault);
        const ceo = officeHolder(org, 'chief_executive');
        if (!state.discoveryJob) {
          // A discovery job that is still being worked on means the company is reading right now, whatever the
          // cache says. Checked from the vault before anything else, because a kill in the one write between
          // `createJob` and `saveState` leaves a job that neither the state file nor `blocked_on` names — and
          // walking past it would plan while discovery is still reading, which is what this step exists to
          // prevent. Looking for any open job rather than for one derived id also survives the digest moving
          // (it drops material the newest job has read, so it is not the same digest a moment later).
          const running = openDiscoveryJob(vault, new Date(now().getTime() - PLAN_WAIT_BUDGET_MS).toISOString());
          if (running) {
            state = { ...state, discoveryJob: running }; saveState(state);
            // Bounded, like every other wait in this cycle. A discovery job that never reaches a terminal
            // status — a saturated research team, an assignee that stopped being claimable — would otherwise
            // cost *every* later cycle its whole wait budget at this step and stop the company ever reading
            // anything new again. Past the budget it is left behind with the give-up note in the job log, and
            // this cycle goes on to ask and to queue whatever the material now needs.
            const w = waitForStrandedDiscovery(running, (min) => `discovery ${running} still open after ${min} min — reading on without it`);
            if (w) return w;
            state = { ...state, discoveryJob: undefined }; saveState(state);
          }
          // Asking and reading are independent (spec §1.3, §5.5): the interview costs no model call, so an
          // owner who typed one line gets the questions *and* a discovery job over that line on cycle one. The
          // status is re-read after the ask because the transcript it writes is part of the digest.
          let status = currentDiscoveryStatus(vault, now());
          let asked: string | null = null;
          if (status.ask) {
            asked = askInterview(vault, ceo, now());
            status = currentDiscoveryStatus(vault, now());
          }
          const askedNote = asked ? `asked the founder interview (${asked})` : '';
          if (!status.run) { done(i, [askedNote, status.why].filter(Boolean).join('; ')); break; }
          const id = enqueueDiscovery(vault, org, status);
          if (!id) { done(i, [askedNote, status.why].filter(Boolean).join('; ')); break; }
          state = { ...state, discoveryJob: id }; saveState(state);
          return block(id, `waiting for discovery ${id}${askedNote ? `; ${askedNote}` : ''}`);
        }
        const sub = readJob(vault, state.discoveryJob);
        if (!sub || !['done', 'failed', 'cancelled'].includes(sub.data.status)) {
          // Its own flag, never `planPending`: `state.planPending` is never cleared, so borrowing it here would
          // make this cycle's brief say the team plans had not finished even after every one of them did.
          const w = waitForDiscovery(state.discoveryJob, (min) => `discovery ${state.discoveryJob} still ${sub?.data.status ?? 'missing'} after ${min} min — planning from what there is`);
          if (w) return w;
          break;
        }
        if (job.status !== 'running') updateJob(vault, jobId, { status: 'running', blocked_on: undefined }, 'ceo');
        done(i, `discovery ${sub.data.status}`);
        break;
      }
      case 'ideas_board': {
        const org = loadOrg(vault);
        const board = org.teams.board;
        const ceo = officeHolder(org, 'chief_executive');
        // Cards the discovery job filed still need their price before the board can read a score. Queue the
        // estimates once, then wait for them the same way company_plan waits for its sub-job — bounded by
        // PLAN_WAIT_BUDGET_MS, so a stuck finance office costs this cycle's board session and nothing more.
        // Only an estimate that could actually put a card in front of the board is worth waiting for: a card
        // whose research half is missing cannot be scored however fast the finance office answers, so holding
        // the cycle for its price spends up to an hour — and the plan's latency — on a card that cannot be
        // judged this cycle whatever happens. The job is still queued; it is simply not waited on.
        const waitable = (ids: string[]): string[] => {
          const scorable = new Set(listIdeas(vault).filter((c) => c.score_inputs.evidence !== undefined && c.score_inputs.fit !== undefined).map((c) => estimateJobId(c.id)));
          return ids.filter((id) => scorable.has(id));
        };
        if (!state.estimateJobs) {
          // Both halves get a producer. The research jobs are queued and not waited on: they run the full
          // research lifecycle, so their cards reach the board next cycle rather than this one, and blocking on
          // them would spend the cycle's plan latency on work that cannot change this cycle's board session.
          const researchJobs = enqueueResearchHalf(vault, org);
          const ids = enqueueEstimates(vault, org);
          state = { ...state, estimateJobs: ids, researchJobs }; saveState(state);
          const wait = waitable(ids);
          if (wait.length) return blockMany(wait, `waiting for ${wait.length} idea estimate(s)`);
        }
        // `estimatesPending` means this cycle already gave up on them: the `blocked_on.since` it cleared would
        // otherwise start a fresh 60-minute budget every time the step is re-entered.
        if (!state.estimatesPending && state.estimateJobs?.length) {
          const waitOn = waitable(state.estimateJobs);
          const open = waitOn.filter((id) => { const s = readJob(vault, id)?.data.status; return !s || !['done', 'failed', 'cancelled'].includes(s); });
          if (open.length) {
            const w = waitForEstimates(firstOpenJob(waitOn, (id) => readJob(vault, id)?.data.status), (min) => `${open.length} estimate(s) still open after ${min} min — the board chooses from what is priced`);
            if (w) return w;
          } else if (job.status !== 'running') updateJob(vault, jobId, { status: 'running', blocked_on: undefined }, 'ceo');
        }
        // A card the board judged whose verdict note never got filed — a kill between the stamp below and
        // `createProposal` — is stranded: `nextIdeaForBoard` skips a stamped card, so nobody would ever ask the
        // owner about it and `keptIdeas` could never return it. Re-file it from the card before looking for a
        // new one; the proposal id is derived from the slug, so a cycle that already filed it does nothing.
        const refiled: string[] = [];
        for (const c of listIdeas(vault)) {
          if (c.board_verdict === null || c.decision !== 'undecided') continue;
          if (findInboxById(vault, idFromKey('prop', ideaVerdictKey(c.id)))) continue;
          const r = fileIdeaVerdict(vault, c.id, { from: ceo, job: jobId, findings: cardBoardFindings(readIdea(vault, c.id)?.body ?? '') });
          if (!r?.filed) continue;
          refiled.push(c.id);
          vault.events.emit({ type: 'daemon.warning', agent: ceo, job: jobId, payload: { where: 'ideas_board', message: `re-filed the missing verdict note for Ideas/${c.id}: the board had judged it but the owner was never asked` } });
        }
        const idea = nextIdeaForBoard(vault);
        const refiledNote = refiled.length ? `; re-filed ${refiled.length} stranded verdict note(s): ${refiled.join(', ')}` : '';
        // No board room means the funnel is stopped, not merely quiet: say so, because nothing else will.
        if (!idea || !board || !org.roles[board.lead]) { done(i, (idea ? `board skipped: no advisors, so no idea can be judged and the funnel is stopped (${idea.id} is waiting)` : 'no idea is ready for the board') + refiledNote); break; }
        // The card is re-read here, and again after the session: it is a file, and the owner can delete or
        // break it between the two. A `TypeError` out of a non-null assertion would fail the whole cycle —
        // every step after this one, including the plan — over one card, which is why the decision-note write
        // beside these is already wrapped.
        const card = readIdea(vault, idea.id);
        if (!card) { done(i, `board skipped: Ideas/${idea.id} disappeared before the session${refiledNote}`); break; }
        const session = await runBoardSession(deps, org, { kind: 'idea', text: `# ${card.data.title}\n\n${card.body}`, title: card.data.title, slug: idea.id });
        if (cancelled()) return { status: 'cancelled' };
        // The record, closed in the same tick and depending on this heartbeat so no worker picks it up.
        const boardJob = createJob(vault, {
          id: idFromKey('job', `board-idea:${idea.id}`), type: 'board.session', title: `Board: ${card.data.title}`,
          assigned: board.lead, priority: 1, parent: jobId, team: board.id, owner_role: ceo,
          depends_on: [jobId], links: [`[[${jobId}]]`, `[[${ideaPath(idea.id).replace(/\.md$/, '')}]]`],
          goal: `The board read [[Ideas/${idea.id}]] and merged ${session.advisors.length} pre-mortems into one verdict.`,
        }, ceo);
        vault.updateNote(`Jobs/${boardJob}.md`, (n) => ({
          data: { ...n.data, status: 'done', checkpoint_step: 1, updated: nowIso() },
          // The advisors' own words, then the chair's merge of them. The job note is where an owner goes to
          // read what the board actually said, and a record that keeps three attempts at the five parts but
          // not the merge they were hired for is a record of the working and not the answer (ruling H3).
          body: setSection(withChair(setSection(n.body, '## Advisors', session.transcript), session.chairText), '## Result', '```json\n' + JSON.stringify({ status: 'done', summary: `board ${session.verdict} on ${idea.id}`, verdict: session.verdict, findings: session.findings }, null, 2) + '\n```'),
        }), board.lead, { job: boardJob });
        vault.events.emit({ type: 'job.done', agent: board.lead, job: boardJob, payload: { type: 'board.session', summary: `board ${session.verdict}`, verdict: session.verdict, idea: idea.id } });
        // Nobody answered is not "the board reviewed this and found nothing"; the same warning the plan's
        // pre-mortem raises, for the same reason — the decision note says so too, but the owner reads events.
        if (session.answered === 0) {
          vault.events.emit({ type: 'daemon.warning', agent: board.lead, job: jobId, payload: { where: 'ideas_board', reason: BOARD_UNREVIEWED_NOTE.replace('the plan passed', 'the idea passed') } });
        } else if (session.chairLost) {
          // The advisors answered and the chair did not, twice over in two different ways. Same warning route,
          // because to the owner it is the same fact: this idea passed without anyone merging a verdict on it.
          vault.events.emit({ type: 'daemon.warning', agent: board.lead, job: jobId, payload: { where: 'ideas_board', reason: session.chairLost } });
        }
        let decisionRel = '';
        try { decisionRel = writeBoardSessionDecision(vault, idea.id, card.data.title, boardJob, session.verdict, session.findings, board.lead, now(), session.answered, session.chairLost, session.chairText); }
        catch (err) { vault.events.emit({ type: 'daemon.warning', agent: board.lead, job: jobId, payload: { where: 'ideas_board', message: `could not write the board decision note: ${(err as Error).message}` } }); }
        // The verdict goes on the card before the proposal is filed: a crash between the two must leave the
        // dossier true, not leave the owner ruling on a card that never heard from the board.
        updateIdea(vault, idea.id, { board_verdict: session.verdict, board_decision: decisionRel, board_pressure: session.pressure ?? '', board_rubric: session.rubric }, 'daemon', {
          heading: '## The board',
          content: renderBoardSection({
            verdict: session.verdict, advisors: session.advisors.length, date: now().toISOString().slice(0, 10),
            decision: decisionRel, findings: session.findings, pressure: session.pressure, rubric: session.rubric,
            chair: session.chairText,
          }),
        });
        // The board's verdict is an input to the band (a returned idea parks), so the `## Score` section is
        // re-rendered from the card as it now stands rather than from the numbers read before the session.
        const after = readIdea(vault, idea.id);
        if (after) {
          const value = after.data.score_inputs.value ?? 3;
          updateIdea(vault, idea.id, {}, 'daemon', { heading: '## Score', content: renderScoreSection({ value, evidence: after.data.score_inputs.evidence ?? 3, effort: after.data.score_inputs.effort ?? 3, fit: after.data.score_inputs.fit ?? 3 }, { board: session.verdict }) });
        }
        // The session happened whatever the card does next: the `board.session` job note and the `Decisions/`
        // note above are the record. A card that vanished between the stamp and the verdict note is reported,
        // not thrown — and the stranded-verdict sweep at the top of this step re-files the note if it comes back.
        const filed = fileIdeaVerdict(vault, idea.id, { from: ceo, job: jobId, findings: session.findings });
        state = { ...state, ideaJudged: idea.id }; saveState(state);
        if (!filed) vault.events.emit({ type: 'daemon.warning', agent: ceo, job: jobId, payload: { where: 'ideas_board', message: `the board ruled on Ideas/${idea.id} but the card could not be read back, so the owner has not been asked yet` } });
        done(i, `board ${session.verdict} on ${idea.id}; ${filed ? `recommendation ${filed.band}, waiting for the owner` : 'the card could not be read back, so no verdict note was filed'}${refiledNote}`);
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
        if (planningWaitsForBrief()) { done(i, WAITING_FOR_BRIEF); break; }
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
          // `ownerMessages` counts what the owner typed since the last cycle whether or not it has been
          // answered (ruling FR-1 made answering a tick sweep, so a message is usually answered before the
          // cycle that should re-plan against it ever gathers).
          // …but an **approval is not an ask** (ruling S-4). It is an owner edit under `00 Inbox/` like any
          // other, and counting it here is how the second live run rewrote the plan the owner had just approved,
          // four times in twenty minutes, for the price of the day's whole strong tier. `ownerEditAsksForWork`
          // is the same predicate that decides whether the edit was worth waking a cycle for at all, so the two
          // can never disagree: a plan is rewritten when it is stale, when the board returned it, or when a
          // verdict was rejected — never because the owner said yes to something.
          const ownerAsked = (state.ownerMessages ?? 0) > 0 || (state.unansweredOwnerMessages?.length ?? 0) > 0 || (state.ownerEdits ?? []).some((p) => ownerEditAsksForWork(vault, p)) || /owner|forced/i.test(job.title);
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
          // What the plan is allowed to be about (spec §4). The kept cards carry their scores so the CEO can
          // tell a 58 from a 45, and the founder brief above them is what the whole company is for — a plan
          // written without it is a plan for some other company.
          const kept = keptIdeasGoalBlock(keptIdeaLines(keptIdeas(vault)));
          const brief = vault.readTextOrNull(FOUNDER_BRIEF);
          // The seat, not the id (final review I1): the job was already *assigned* by office, but it carried
          // `owner_role: 'ceo'` and a hard-coded `executive` team, which is what WIP and the job tree attribute
          // against — so after a re-staff the plan job went to the right person under the wrong name.
          const chief = officeHolder(org, 'chief_executive');
          const id = createJob(vault, {
            type: 'company.plan', title: state.vetoes ? 'Rewrite the plan after the board' : 'Write the company plan', assigned: chief, priority: 1, parent: jobId, team: teamOf(org, chief)?.id, owner_role: chief,
            goal: `Write this cycle's objectives per division, not jobs.\n\nSituation:\n${situationSummary()}\n\nDivisions: ${teams}.\n\nStreams: ${streams}.\n\n${kept}${brief ? `\n\nThe founder brief (${FOUNDER_BRIEF}) is what this company is for. Read it before you plan; everything below serves it:\n\n${brief.slice(0, 2000)}` : ''}\n\nDo: (1) vault.read Plans/plan.md, Memory/lessons.md, the latest Runs/ note, Docs/engineering-handbook.md and Docs/tech-radar.md if present; (2) rewrite Plans/plan.md via vault.write with "# Plan", "## Objectives" and one "### <division id>" subsection per division that has work this cycle (a bullet per objective; every objective for a product division ends with "stream: <slug>" naming a note under Streams/, and states an outcome with a number rather than a feature list; add a line "process: <name>" under an objective that needs a cross-team pipeline from Processes/); a division with nothing to do gets no section; (3) finish with a one-paragraph summary. If one role can do it, don't split it.${findings}`,
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
        if (planningWaitsForBrief()) { done(i, WAITING_FOR_BRIEF); break; }
        if (state.planSkipped || state.planWaiting) { done(i, 'board skipped — the plan was not rewritten'); break; }
        if (state.boardVerdict) { done(i, `board ${state.boardVerdict} (already run)`); break; }
        const org = loadOrg(vault);
        const board = org.teams.board;
        const plan = vault.readTextOrNull('Plans/plan.md') ?? '';
        if (!board || !org.roles[board.lead] || !planIsSubstantive(plan)) { done(i, 'board skipped'); break; }
        const ceo = officeHolder(org, 'chief_executive');
        /**
         * The one way a plan goes back to the CEO, whoever asked for it: the veto is counted and emitted, one
         * rewrite is allowed, and a second return goes to the owner rather than stalling the company. Returns
         * the heartbeat's own outcome when the cycle requeues, `null` when the caller should carry on and close
         * the step itself.
         */
        const returnPlan = (findings: string[], reason: string): HeartbeatOutcome | null => {
          const vetoes = (state.vetoes ?? 0) + 1;
          vault.events.emit({ type: 'plan.vetoed', agent: board.lead, job: jobId, payload: { findings, vetoes, reason } });
          if (vetoes === 1) {
            // One rewrite, then the owner rules on whatever the CEO produced: the board cannot stall the company.
            state = { ...state, vetoes, companyPlanJob: undefined, boardJob: undefined, boardVerdict: undefined }; saveState(state);
            updateJob(vault, jobId, { status: 'queued', checkpoint_step: i - 1, blocked_on: undefined }, 'ceo', `- step ${i + 1} board_premortem: returned (${reason}); rewriting the plan`);
            return { status: 'requeued', attempt: job.attempt };
          }
          state = { ...state, vetoes }; saveState(state);
          createProposal(vault, { kind: 'message', from: ceo, to: 'owner', title: `The board vetoed the plan twice`, body: `Findings:\n${findings.map((f) => `- ${f}`).join('\n')}\n\nThe cycle continues with the current plan; reply if you want it changed.`, job: jobId }, ceo);
          return null;
        };
        // Deterministic, and before any model call: a plan that draws on an idea the company parked or scrapped
        // is returned whatever the advisors would have said, with the idea named (spec §4.2). An advisor asked
        // to spot a slug in a wall of markdown will miss it, and this is the one rule the whole idea pipeline
        // exists to enforce. An undecided idea is carried into the session's findings instead (see below).
        const unkept = unkeptIdeasNamedIn(plan, listIdeas(vault));
        const guardFindings = unkeptIdeaFindings(unkept);
        // Whole budget here (no board findings to make room for), the board's share below.
        const guardOnlyFindings = planReturnFindings(guardFindings);
        if (unkeptForcesReturn(unkept)) {
          // The pre-mortem note the cycle owes, in the guard's own words: `writeBoardPremortemDecision` would
          // point the reader at a board job that does not exist and promise "the advisors' own words" nobody
          // spoke, so this fills the same shape through the factored writer and says what actually happened.
          try {
            writeBoardDecision(vault, `premortem-${hbId}`, {
              verdict: 'return', findings: guardFindings, decidedBy: board.lead, now: now(), answered: 0,
              cycle: hbId, inputs: ['[[Plans/plan]]'],
              unreviewedNote: BOARD_UNREVIEWED_NOTE,
              noFindingsNote: 'The board found nothing in this plan likely to sink the cycle.',
              context: `Pre-mortem for heartbeat ${hbId}: the plan drew on ${unkept.length} idea${unkept.length === 1 ? '' : 's'} the company did not keep, so it was returned before the board sat. No advisor was asked — this one is arithmetic, not judgement.`,
              options: '- Run the plan as the CEO wrote it\n- Return it to the CEO to rewrite before the owner rules on it',
              chosen: 'Return the plan to the CEO for one rewrite.',
              why: 'A plan may only draw on ideas the company kept (spec §4); the company ruled on these already.',
              risksHeading: 'The ideas this plan draws on that the company did not keep:',
              reviewDays: 7,
            });
          } catch { /* a note is a record, never a reason to stall the cycle */ }
          // The note above keeps every offending idea — it is the durable record of what the plan named. What
          // the CEO rewrites against and what the owner reads is the capped list, the same budget the board's
          // own return gets: a plan naming twenty scrapped ideas must not become a twenty-bullet prompt.
          state = { ...state, boardVerdict: 'return', boardFindings: guardOnlyFindings }; saveState(state);
          const out = returnPlan(guardOnlyFindings, 'unkept ideas');
          if (out) return out;
          done(i, `board returned: ${unkept.length} unkept idea(s), second time`);
          break;
        }
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
        // The guard's warnings lead: an idea nobody has ruled on yet does not return the plan, but the CEO and
        // the owner should still read that the plan leans on one. They take what is left of the budget after
        // the board's own findings, never the other way round — see `planReturnFindings`.
        const boardFindings = planReturnFindings(guardFindings, session.findings);
        state = { ...state, boardJob, boardVerdict: session.verdict, boardFindings }; saveState(state);
        if (session.verdict === 'return') {
          const out = returnPlan(boardFindings, 'board return');
          if (out) return out;
        }
        done(i, `board ${session.verdict}`);
        break;
      }
      case 'owner_verdict': {
        if (planningWaitsForBrief()) { done(i, WAITING_FOR_BRIEF); break; }
        const decidesAfterHours = vault.constitution().board_decides_after_hours;
        // `board_decides_after_hours` governs idea verdicts too (spec §3.5). The recommendation stamped on the
        // note is what stands when it elapses — never a fresh recomputation, because the card may have changed
        // since the board read it.
        //
        // This runs before every early exit below, not after the plan verdict: a cycle whose plan was skipped or
        // had nothing to rule on still has to close the idea notes it filed, or an unattended night would leave
        // them open for ever. The decision is written here rather than left to the dispatcher on purpose:
        // `dispatchProposals` acts on an approval flag only when `vault.isOwnerChanged` says the *owner* set it,
        // so a daemon write of `approved: true` would be refused as a forged approval — correctly. This loop is
        // the deciding code, so it writes the decision onto the card itself and stamps `resolved_at`.
        for (const note of listInbox(vault).filter((n) => n.data.kind === 'idea_verdict' && n.data.approved === null && !n.data.resolved_at)) {
          const boardVerdict = (note.data as { board_verdict?: string }).board_verdict === 'pass' ? 'pass' as const : 'return' as const;
          const outcome = verdictOutcome({ approved: null, created: note.data.created, now: now(), boardVerdict, decidesAfterHours });
          if (outcome === 'pending') continue;
          // The band is the decision, and it already carries the board's return (`ideaBand` parks a returned
          // idea rather than scrapping it). `approved` records what `verdictOutcome` actually said, so a note
          // the board returned does not read as approved to anything that later filters on that flag;
          // `decision` is the field that says what happened to the idea, matching the card.
          const band = ((note.data as { band?: string }).band ?? 'park') as IdeaBand;
          const slug = String(note.data.target ?? '').slice('Ideas/'.length).replace(/\.md$/, '');
          if (slug && readIdea(vault, slug)) {
            updateIdea(vault, slug, { decision: band, decided_by: 'board', decided_at: nowIso(), status: band === 'scrap' ? 'rejected' : band === 'keep' ? 'accepted' : 'triaged' }, 'daemon', {
              heading: '## Decision',
              content: `**${band}** — the board, ${nowIso().slice(0, 10)}. The owner did not rule within ${decidesAfterHours} h, so the recommendation stood (\`board_decides_after_hours\`).`,
            });
          }
          vault.updateNote(note.path, (n) => ({ data: { ...n.data, approved: outcome === 'approved', decision: band, decided_by: 'board', resolved_at: nowIso() }, body: n.body.trimEnd() + `\n\n---\n_Resolved ${nowIso()}: the recommendation (${band}) stood after ${decidesAfterHours} h._\n` }), 'daemon');
          vault.events.emit({ type: 'proposal.resolved', agent: 'daemon', job: jobId, payload: { id: note.data.id, kind: 'idea_verdict', approved: outcome === 'approved', decision: band, outcome: `the board decided: ${band}` } });
        }
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
        if (planningWaitsForBrief()) { done(i, WAITING_FOR_BRIEF); break; }
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
              // Mark it expanded in this run too, so two plan sections that resolve to the same team and name the
              // same process expand it once (re-review of the fix wave, minor 2).
              try { expandProcess(vault, m[1], s.text.split('\n')[0].replace(/^- /, ''), { parent: jobId, by: officeHolder(org, 'chief_executive'), team: t.id, owner_role: t.lead, marker }); expanded.add(`[[${marker}]]`); }
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
        // What the brief says about money is derived from the book here, not carried down from the `money`
        // step: the state file is a resume aid, and a crash that loses it must not be able to make the brief
        // forget the money line or seed a stopped company with its first jobs. The ledger is the only thing
        // that knows, and it costs one read to ask it — which is why the cycle caches nothing about money at
        // all, and why nothing here may be changed to trust a remembered figure.
        // Guarded by the same `readMoney` the `money` step uses, and for the same reason: this read is the last
        // thing between a cycle's work and the owner hearing about it, so a book that cannot be read must cost
        // the brief its money line and nothing else.
        const moneyNow = readMoney();
        const moneyFacts = { line: moneyLineOf(moneyNow), needsYou: moneyNeedsYou(moneyNow.report), dormant: moneyNow.report.dormant };
        // D8 seeds heartbeat #1 with a stream and the first jobs — but never for a company that has no money
        // to do them with. A dormant cycle writes its brief and nothing else.
        const firstStream = moneyFacts.dormant ? null : seedFirstStream(vault);
        if (firstStream) updateJob(vault, jobId, {}, 'ceo', `- step ${i + 1} ${step}: created the first stream Streams/${firstStream}.md from the owner's idea`);
        const seeded = moneyFacts.dormant ? [] : seedFirstJobs(vault, loadOrg(vault));
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
        const modelUse = modelUseRows({ calls: calls.length, downgraded: calls.filter((e) => isKeyProblemDowngrade(e.payload)).length }, deps.noCloudKeys?.() ?? false);
        const mocked = deps.env ? mockedServices(deps.env) : [];
        // Ruling S-1 again, said to the owner rather than to the checkpoint log: four steps of this cycle did
        // nothing, and the brief is the only place they would ever find out why. An open brief proposal is
        // already the first row of `pending` above — this row would only repeat it — so this one names what is
        // being waited for *instead*, in the discovery step's own words: the research office is writing it, or
        // the company is waiting on them to pick an idea, or there is nothing to read yet.
        const briefRow = ((): string | null => {
          if (hasApprovedBrief(vault)) return null;
          if (pending.some((p) => p.data.kind === 'founder_brief')) return null;
          let why = 'the research office is writing the founder brief';
          try { if (!openDiscoveryJob(vault)) why = currentDiscoveryStatus(vault, now()).why; } catch { /* the brief never fails over a status read */ }
          return `- Nothing is planned until a founder brief is adopted — ${why}`;
        })();
        const needsYou = [
          ...pending.map((p) => `- Approve or reject: ${p.body.split('\n')[0].replace(/^#\s*/, '')} (\`${p.path}\`)`),
          ...(briefRow ? [briefRow] : []),
          ...blocked.filter((j) => j.blocked_on?.kind === 'message').map((j) => `- Answer ${j.assigned}'s question on job ${j.id}`),
          // A job that finished as blocked waits for the owner and nothing else requeues it (loop.ts / requeueUnblocked):
          // unlisted, it sat for a day while the brief said "nothing needs you".
          ...blocked.filter((j) => j.blocked_on?.kind === 'owner').map((j) => `- Decide on ${j.id} (${j.assigned}: ${j.title}) — it stopped: ${jobBlockers(vault, j.id) || 'no reason given'}. Set status: queued to retry it or status: cancelled to drop it`),
          ...(migrated ? ['- The company was reorganised into teams — review Teams/ and the new charters'] : []),
          ...(modelUse.needsYou ? [modelUse.needsYou] : []),
          ...(mockedServicesRow(mocked) ? [mockedServicesRow(mocked)!] : []),
          ...moneyFacts.needsYou,
        ];
        const facts = [
          `Elapsed: ${Number.isFinite(state.elapsedHours) ? state.elapsedHours!.toFixed(1) + ' h' : 'first heartbeat'}`,
          ...(state.planPending ? ['Planning: PENDING — the team plans have not finished this cycle; the previous plan stands.'] : []),
          // Ahead of every other planning line, because when it is true none of them can be: the four planning
          // steps did not run at all (ruling S-1), so "skipped", "paused" and "pending" would all be inventions.
          ...(hasApprovedBrief(vault) ? [] : ['Planning: waiting for the founder brief — nothing is planned until you adopt one.']),
          // Its own line for the same reason the estimate one is: a discovery job that ran long delayed the
          // reading, not the planning, and the plan this cycle wrote was written without it.
          ...(state.discoveryPending ? ['Discovery: still running — your material was not read in time, so this cycle planned without it; the founder brief will follow.'] : []),
          // Its own line, and never the planning one: an estimate the finance office has not returned delays the
          // board session, not the plan, and a brief that said "Planning: PENDING" about it would be wrong. The
          // board reads at most one card a cycle and on this path may have read none, so the line names the card
          // it sat on rather than implying it got through the ready ones.
          ...(state.estimatesPending ? [`Ideas: an estimate is still pending — the finance office has not priced every new card, so the board ${state.ideaJudged ? `chose from the ones that were priced in time and sat on ${state.ideaJudged}` : 'had no priced card to sit on and judged nothing this cycle'}.`] : []),
          ...(state.planSkipped ? [`Planning: skipped — the plan from ${state.planSkipped.planDate} stands and ${state.planSkipped.open} job${state.planSkipped.open === 1 ? ' is' : 's are'} still open`] : []),
          // A plan can be waiting for the owner (`planWaiting`, filed by an earlier cycle) and still be ruled on
          // by this one, so the "paused" line only stands while the verdict has not come through.
          ...(state.planWaiting && state.verdict !== 'approved' ? [`Planning: paused — a plan is waiting for your verdict (${state.planWaiting})`] : []),
          // The line above already says this for a plan an earlier cycle filed, and both were printed on the
          // same brief (Task 6 review, minor 4). This one is for the plan *this* cycle wrote.
          ...(state.verdict === 'pending' && !state.planWaiting ? ['Planning: this cycle\'s plan is waiting for your verdict; work already approved keeps running'] : []),
          ...(state.verdict === 'rejected' ? ['Planning: the plan was rejected; the CEO rewrites it next cycle and no new work was queued'] : []),
          // One line, every cycle, whether or not anything moved. The owner should never have to open a file to
          // find out whether the company can still pay for itself.
          moneyFacts.line,
          modelUse.fact,
          ...(deps.env ? [`Outbound services: ${(['deploy', 'email', 'analytics'] as const).map((s) => `${s} ${mocked.includes(s) ? 'mock' : 'live'}`).join(', ')}`] : []),
          `Owner edits: ${state.ownerEdits?.length ? state.ownerEdits.join(', ') : 'none'}`,
          `Finished jobs: ${state.finished?.length ? state.finished.map((f) => `${f.title} (${f.status})`).join('; ') : 'none'}`,
          `Queued next: ${queued.map((j) => `${j.assigned}: ${j.title}`).join('; ') || 'nothing'}`,
          `Blocked: ${blocked.map((j) => `${j.id} on ${j.blocked_on?.kind ?? '?'}`).join('; ') || 'none'}`,
          `Needs owner: ${needsYou.length ? needsYou.join(' | ') : 'nothing'}`,
          `Plan: ${(vault.readTextOrNull('Plans/plan.md') ?? '').slice(0, 1500)}`,
        ].join('\n');
        // A dormant company spends nothing, and that includes the strong-tier call this draft costs. The
        // template fallback below already says everything a stopped company has to say.
        let drafted = moneyFacts.dormant ? null : await ask(deps, ceoSystem(vault), `Write the owner's "since you were away" brief from these facts, under 200 words, three sections: ## What happened, ## What's next, ## What needs you. Bullet points only. Do not invent anything not in the facts.\n\n${facts}`, 1200);
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
