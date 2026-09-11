import {
  type Vault, type JobFrontmatter, readJob, updateJob, createJob, listJobs, listInbox, nowIso, stampForFilename,
  autoCommit, parseNote, stringifyNote, setSection, createProposal, idFromKey, type CubicleEvent,
  loadOrg, expandProcess, childrenOf, resolveTeamSection, writeDecision, repoRoot, type TeamFrontmatter,
  resolveRole, teamOf, researchLead, listStreams, officeHolder, type Org,
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
 * The cycle, in order. A step with no `case` in the loop below is walked through without doing anything:
 * `owner_verdict` is named here because the board pre-mortem already stores the verdict it rules on
 * (`state.boardVerdict`), but the owner's ruling itself is not wired yet.
 */
export const HEARTBEAT_STEPS = ['gather', 'reconcile_brand', 'answer_owner', 'meeting', 'company_plan', 'board_premortem', 'owner_verdict', 'division_plans', 'brief', 'commit'] as const;
/** How long a heartbeat waits for company.plan/team.plan before writing the brief with "planning pending" (R33). */
export const PLAN_WAIT_BUDGET_MS = 40 * 90_000;

/** Planning and gate job types never count toward the "N jobs completed" heartbeat trigger — otherwise a single
 *  cycle's own planning/gate sub-jobs (company.plan, board.premortem, team.plan, plus every `GATE_JOB_TYPES`
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
 * company.plan → the board pre-mortem → one team.plan per lead → gates (≈16 model calls) before any work, and on the
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

/**
 * The goal text of a lead's `team.plan` job. A lead with no members (the shipped `operations` team is only the
 * COO) used to be told to "do the work yourself as a custom job assigned to you" and then tried
 * `scheduler.request` on itself every cycle, which the org guards refuse; say instead how such a lead gets work
 * onto the queue — through the CEO, or as research.
 */
export function teamPlanGoal(t: TeamFrontmatter, objectives: string, lastNextAction: string, researchTo = 'research_manager', budgets: string[] = []): string {
  const alone = t.members.length === 0;
  const budget = budgets.length ? `\n\nError budgets for your streams (operating model §23):\n${budgets.map((b) => `- ${b}`).join('\n')}` : '';
  return `Your team's objectives this cycle:\n${objectives}${budget}\n\nNext action from the last brief: ${lastNextAction}\n\nDo: (1) vault.read Plans/plan.md and vault.list Jobs to see open work; (2) enqueue at most 4 jobs with scheduler.request for your members (${t.members.join(', ') || 'none'}), each finishable in one sitting, each with done_when, each naming its stream and its risk; research needs go to ${researchTo} with for: ${t.lead}; (3) vault.append the job ids under your "### ${t.id}" section in Plans/plan.md; (4) finish with a one-paragraph summary.${alone ? ` Your team has no members: plan work you will do yourself in follow-up jobs assigned to you by the CEO (ask with colleague.message), or request research from ${researchTo}; do not call scheduler.request for yourself.` : ''}`;
}

/**
 * Every `### <team>` section in `Plans/plan.md`: its team id and its full body text (everything up to the next
 * `### ` header or the end of the plan), trimmed. Splits on the header line instead of using a lazy
 * `[\s\S]*?` + lookahead match (Task 9 review round 2: that lookahead was `(?=^### |\s*$)` — under the `m` flag,
 * `\s*$` matches the end of ANY line, not just a real section boundary, so the old regex silently truncated
 * every section to just its first line whenever a section had more than one line of content. This broke both
 * `planIsSubstantive` below on multi-bullet sections and the goal text `team_plans` sends a lead — a second
 * objective bullet, or a `process:` line after the first bullet, was silently dropped).
 *
 * The header itself is kept as written (`Engineering`, `Growth team`, `growth`, …) rather than filtered to a
 * bare `\w+` team-id shape (F4): a CEO-written plan header is prose, not a machine key, and dropping a
 * multi-word or differently-cased header here silently lost the whole section for both `planIsSubstantive` and
 * `team_plans`. Resolving the header to an actual team id is the caller's job (`resolveTeamSection`).
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
 * The id `team_plans` should (re-)block on: the first of `ids` whose status is not done/failed/cancelled, or the
 * last id if every one of them already looks finished (defensive — the caller only asks for this while at least
 * one of `state.teamPlanJobs` is still open, so that shouldn't happen). Always returning `ids[0]` regardless of
 * its status (Task 9 review finding 2) meant that once the first team.plan finished, `requeueUnblocked` would see its
 * `blocked_on` target as satisfied on every dispatcher tick even while other team plans were still running,
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
 */
export async function runBoardSession(deps: HeartbeatDeps, org: Org, plan: string): Promise<{ verdict: 'pass' | 'return'; findings: string[]; advisors: string[]; transcript: string }> {
  const vault = deps.vault;
  const board = org.teams.board;
  const advisors = [board.lead, ...board.members].filter((r) => org.roles[r]).slice(0, 3);
  const notes: string[] = [];
  for (const a of advisors) {
    const text = await askAs(deps, a, advisorSystem(vault, a), `This cycle's plan:\n\n${plan.slice(0, 4000)}\n\nImagine the cycle has already failed. Write at most three bullets: the failure mode you see and the one change that would prevent it. One line each, concrete, no preamble.`, 500);
    notes.push(`### ${advisorName(vault, a)}\n${text ?? '(no answer: no model was available)'}`);
  }
  const transcript = notes.join('\n\n');
  const merged = await askAs(deps, board.lead, advisorSystem(vault, board.lead), `You chair the board. Your advisors wrote:\n\n${transcript}\n\nMerge them into ONE verdict for the owner. First line exactly "VERDICT: pass" or "VERDICT: return". Then at most four bullets, each a failure mode this plan does not answer and the change that fixes it. Return the plan only if running it as written would waste the cycle; you cannot delay.`, 600);
  return { ...mergeBoardVerdict(merged ?? ''), advisors, transcript };
}

/**
 * The board's pre-mortem as a `Decisions/premortem-<heartbeat id>.md` note: `adopted` when the plan survived,
 * `proposed` when the board returned it (the plan it judged is not the plan that will run). The findings are the
 * failure modes the board foresaw, which is what makes the note worth reading a cycle later.
 */
export function writeBoardPremortemDecision(vault: Vault, hbId: string, boardJobId: string, verdict: 'pass' | 'return', findings: string[], decidedBy: string, now: Date): string {
  const risks = findings.length ? findings.map((f) => `- ${f}`).join('\n') : '- The board found nothing in this plan likely to sink the cycle.';
  const review = new Date(now.getTime() + 7 * 24 * 3600_000).toISOString().slice(0, 10);
  return writeDecision(vault, `premortem-${hbId}`, {
    decided_by: decidedBy, cycle: hbId, status: verdict === 'pass' ? 'adopted' : 'proposed', inputs: ['[[Plans/plan]]'],
  }, {
    context: `Pre-mortem for heartbeat ${hbId}: the board read this cycle's \`Plans/plan.md\` and imagined the cycle had already failed. The advisors' own words are in [[${boardJobId}]].`,
    options: '- Run the plan as the CEO wrote it\n- Return it to the CEO to rewrite before the owner rules on it',
    chosen: verdict === 'pass' ? 'Run the plan as written.' : 'Return the plan to the CEO for one rewrite.',
    why: verdict === 'pass' ? 'The plan survived the pre-mortem.' : 'The board found failure modes the plan does not answer.',
    expected_effect: `Most likely ways this cycle fails, and what would prevent each:\n\n${risks}`,
    review_date: review,
  }, decidedBy);
}

/** Create the `ceo.heartbeat` job note (the heartbeat is a job so R9/R10/R12 apply). */
export function createHeartbeatJob(vault: Vault, trigger: string): string {
  return createJob(vault, {
    type: 'ceo.heartbeat', title: `Heartbeat (${trigger})`, assigned: 'ceo', priority: 1,
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

/** One tool-less completion spoken by `roleId`. Returns null on any failure: no step blocks on a model. */
async function askAs(deps: HeartbeatDeps, roleId: string, system: string, user: string, maxTokens = 800): Promise<string | null> {
  try {
    const r = await deps.llm.chat({ tier: 'strong', needsTools: false, roleId }, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens });
    return r.content.trim() || null;
  } catch {
    return null;
  }
}

/** The same, spoken by whoever holds the chief executive's office. */
async function ask(deps: HeartbeatDeps, system: string, user: string, maxTokens = 800): Promise<string | null> {
  return askAs(deps, officeHolder(loadOrg(deps.vault), 'chief_executive'), system, user, maxTokens);
}

function ceoSystem(vault: Vault): string {
  const constitution = vault.readTextOrNull('Memory/constitution.md') ?? '';
  const charter = vault.readNoteOrNull('Roles/ceo.md')?.body ?? '';
  const prefs = vault.readTextOrNull('Memory/owner_preferences.md') ?? '';
  const lessons = vault.readTextOrNull('Memory/lessons.md') ?? '';
  return `# Constitution\n${constitution}\n\n# Your charter (CEO)\n${charter}\n\n# Owner preferences\n${prefs}\n\n# Lessons\n${lessons.slice(-3000)}\n\nAnswer in plain markdown, no preamble.`;
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
  const loadState = (): Partial<Gathered & { companyPlanJob?: string; boardJob?: string; boardVerdict?: 'pass' | 'return'; boardFindings?: string[]; vetoes?: number; planWaiting?: string; teamPlanJobs?: string[]; runPath?: string; heartbeatId: string; planPending?: boolean; planSkipped?: { planDate: string; open: number }; feedbackShas?: string[]; commentBaselines?: Record<string, string[]> }> => { try { return JSON.parse(vault.readTextOrNull(stateRel) ?? '{}'); } catch { return {}; } };
  const saveState = (s: object) => { const { atomicWriteSync } = require_core(); atomicWriteSync(vault.abs(stateRel), JSON.stringify(s, null, 2)); };
  let state = loadState();
  const hbId = jobId;
  // The vault is the source of truth: recover what the cache may have lost.
  if (job.blocked_on?.kind === 'job') {
    const atStep = HEARTBEAT_STEPS[job.checkpoint_step];
    if (atStep === 'company_plan' && !state.companyPlanJob) state = { ...state, companyPlanJob: job.blocked_on.id };
    if (atStep === 'division_plans' && !state.teamPlanJobs) {
      const ids = listJobs(vault).filter((j) => j.parent === jobId && j.type === 'team.plan').map((j) => j.id);
      if (ids.length) state = { ...state, teamPlanJobs: ids };
    }
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
  // What the last brief told a team to do next, so this cycle's plan can build on it instead of starting cold.
  const lastNextAction = (teamId: string): string => {
    const last = vault.list('Runs', { ext: '.md' }).sort().at(-1);
    if (!last) return 'none recorded';
    const section = (vault.readTextOrNull(last) ?? '').split('## Next action per team')[1];
    if (!section) return 'none recorded';
    const line = section.split('\n').find((l) => l.trim().startsWith(`- ${teamId}:`));
    return line ? line.trim().slice(`- ${teamId}:`.length).trim() : 'none recorded';
  };

  if (job.checkpoint_step > 0 && !state.finished) {
    const m = readJob(vault, jobId)?.body.match(/## Plan\s*\n+```json\n([\s\S]*?)\n```/);
    if (m) { try { const f = JSON.parse(m[1]); state = { ...state, since: f.since, gathered_at: f.gathered_at, elapsedHours: f.elapsedHours ?? Infinity, ownerEdits: f.ownerEdits ?? [], finished: f.finished ?? [], mail: [], analytics: f.analytics ?? null, unansweredOwnerMessages: [] }; } catch { /* fall through with defaults */ } }
  }
  for (let i = job.checkpoint_step; i < HEARTBEAT_STEPS.length; i++) {
    if (cancelled()) return { status: 'cancelled' };
    const step = HEARTBEAT_STEPS[i];
    // Block the heartbeat on a single sub-job (company.plan, team.plan): resumes when it finishes (R33).
    const block = (id: string, log: string): HeartbeatOutcome => {
      updateJob(vault, jobId, { status: 'blocked', blocked_on: { kind: 'job', id, since: nowIso() } }, 'ceo', `- step ${i + 1} ${step}: ${log}`);
      vault.events.emit({ type: 'job.blocked', agent: 'ceo', job: jobId, payload: { reason: 'job', id } });
      return { status: 'blocked', on: { kind: 'job', id } };
    };
    // Block on the first of several sub-jobs (team.plan fan-out); the step re-checks the rest on each revisit.
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
            const id = createJob(vault, { type: 'engineer.ship', title: 'Reconcile site with brand', assigned: resolveRole(loadOrg(vault), 'engineer'), priority: 2, goal: `The owner edited ${touched.join(', ')}. Read every file in Brand/ and update Site/ so it matches the brand kit. Never revert owner edits under Site/. Finish with the list of files you changed.` }, 'ceo');
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
          // Re-planning gate: a fresh, substantive plan with work still open stands (see planningGate). "Owner
          // asked" is read broadly — an unanswered message, any owner edit, or an owner-/forced-triggered
          // heartbeat — because skipping wrongly costs a cycle of stale direction while planning wrongly costs
          // only quota. A board return (state.vetoes) is a rewrite request and is never skipped.
          const openJobs = listJobs(vault, { status: ['queued', 'running'] }).filter((j) => !NON_WORK_TYPES.includes(j.type)).length;
          const ownerAsked = (state.unansweredOwnerMessages?.length ?? 0) > 0 || (state.ownerEdits?.length ?? 0) > 0 || /owner|forced/i.test(job.title);
          const gate = planningGate({ plan: vault.readTextOrNull('Plans/plan.md') ?? '', now: now(), maxAgeDays: deps.planMaxAgeDays, openJobs, ownerAsked, rewrite: (state.vetoes ?? 0) > 0 });
          if (gate.skip) {
            state = { ...state, planSkipped: { planDate: gate.planDate, open: openJobs } }; saveState(state);
            const note = `planning skipped — the plan from ${gate.planDate} stands and ${openJobs} job${openJobs === 1 ? ' is' : 's are'} still open`;
            deps.log?.(`heartbeat ${hbId}: ${note}`);
            done(i, note);
            break;
          }
          archivePlan();
          const org = loadOrg(vault);
          const teams = Object.values(org.teams).filter((t) => t.lead !== 'ceo' || t.members.length).map((t) => `${t.id} (lead ${t.lead}: ${t.mission})`).join('; ');
          const streams = listStreams(vault).filter((s) => s.status === 'active').map((s) => `${s.slug} (${s.outcome_metric}, owned by ${s.owner_team})`).join('; ') || 'none yet — the product manager writes Streams/<slug>.md before the first objective';
          const findings = state.boardFindings?.length ? `\n\nThe board returned the previous draft with these findings; address each one:\n${state.boardFindings.map((f) => `- ${f}`).join('\n')}` : '';
          const id = createJob(vault, {
            type: 'company.plan', title: state.vetoes ? 'Rewrite the plan after the board' : 'Write the company plan', assigned: 'ceo', priority: 1, parent: jobId, team: teamOf(org, 'ceo')?.id ?? 'executive', owner_role: 'ceo',
            goal: `Write this cycle's objectives per team, not jobs.\n\nSituation:\n${situationSummary()}\n\nTeams: ${teams}.\n\nStreams: ${streams}.\n\nDo: (1) vault.read Plans/plan.md, Memory/lessons.md, the latest Runs/ note, Docs/engineering-handbook.md and Docs/tech-radar.md if present; (2) rewrite Plans/plan.md via vault.write with "# Plan", "## Objectives" and one "### <team id>" subsection per team that has work this cycle (a bullet per objective; every objective for a product team ends with "stream: <slug>" naming a note under Streams/, and states an outcome with a number rather than a feature list; add a line "process: <name>" under an objective that needs a cross-team pipeline from Processes/); teams with nothing to do get no section; (3) finish with a one-paragraph summary. If one role can do it, don't split it.${findings}`,
          }, 'ceo');
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
        // A pre-mortem is a decision the company should be able to look back on (spec §4.1), so the heartbeat
        // writes it as a validated Decisions/ note rather than trusting the board to hand-roll the frontmatter
        // and the six sections. Written BEFORE the verdict becomes durable in the state file: a crash in the
        // other order resumes into the "already run" branch above and the cycle loses its pre-mortem for good.
        try { writeBoardPremortemDecision(vault, hbId, boardJob, session.verdict, session.findings, board.lead, now()); }
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
      case 'division_plans': {
        // The leads already planned against this plan last cycle and their jobs are the open work the gate saw.
        if (state.planSkipped && !state.teamPlanJobs) { done(i, 'team plans skipped — the plan was not rewritten'); break; }
        const org = loadOrg(vault);
        if (!state.teamPlanJobs) {
          const plan = vault.readTextOrNull('Plans/plan.md') ?? '';
          const sections = parseObjectiveSections(plan).filter((s) => s.text);
          const ids: string[] = [];
          for (const s of sections) {
            // Match the section header against a team's id or name, case-insensitively and tolerant of a
            // trailing "team" (F4) — a CEO-written plan header ("### Engineering", "### Growth team") is prose,
            // not a machine key. An unmatched header warns instead of silently dropping the whole section.
            const teamId = resolveTeamSection(org, s.team);
            const t = teamId ? org.teams[teamId] : undefined;
            if (!t) { vault.events.emit({ type: 'daemon.warning', payload: { where: 'team_plans', message: `no team matches section "${s.team}"` } }); continue; }
            for (const m of s.text.matchAll(/^process:\s*(\w+)/gm)) {
              // Process-expanded jobs (parent = this heartbeat, like team.plan) can run for hours across several
              // roles, so the heartbeat must not wait on them — only on the team.plan jobs pushed below (Task 9
              // review round 2: waiting on rollup() of every child, including these, delayed the brief for hours).
              try { expandProcess(vault, m[1], s.text.split('\n')[0].replace(/^- /, ''), { parent: jobId, by: 'ceo', team: t.id, owner_role: t.lead }); }
              catch (err) { vault.events.emit({ type: 'daemon.warning', payload: { where: 'team_plans', message: String((err as Error).message) } }); }
            }
            if (t.lead === 'ceo') continue;
            ids.push(createJob(vault, {
              type: 'team.plan', title: `Plan ${t.name}`, assigned: t.lead, priority: 1, parent: jobId, team: t.id, owner_role: t.lead,
              goal: teamPlanGoal(t, s.text, lastNextAction(t.id), researchLead(org) ?? 'research_manager', budgetLines(vault, t.id)),
            }, 'ceo'));
          }
          state = { ...state, teamPlanJobs: ids }; saveState(state);
          if (!ids.length) { done(i, 'no team plans needed'); break; }
          return blockMany(ids, `waiting for ${ids.length} team plan(s)`);
        }
        const emitTeamPlanned = () => {
          for (const id of state.teamPlanJobs!) {
            const j = readJob(vault, id);
            if (j?.data.type === 'team.plan' && j.data.status === 'done') vault.events.emit({ type: 'team.planned', agent: j.data.assigned, job: id, payload: { team: j.data.team, jobs: childrenOf(vault, id).map((c) => c.id) } });
          }
        };
        // Readiness comes solely from the team.plan jobs themselves, not rollup() of every heartbeat child — a
        // process: line's expanded jobs (parent = this heartbeat too) are not among state.teamPlanJobs, so they
        // never gate this step (Task 9 review round 2).
        const openTeamPlans = state.teamPlanJobs.filter((id) => { const s = readJob(vault, id)?.data.status; return !s || !['done', 'failed', 'cancelled'].includes(s); });
        if (openTeamPlans.length) {
          // Re-block on whichever job is still actually open (firstOpenJob), not always ids[0] — see its doc
          // comment for the busy-loop this fixes (Task 9 review finding 2).
          const blockOn = firstOpenJob(state.teamPlanJobs, (id) => readJob(vault, id)?.data.status);
          const w = waitOrGiveUp(blockOn, (min) => `${openTeamPlans.length} team plan(s) still open after ${min} min — planning pending`);
          if (w) return w;
          emitTeamPlanned(); // waitOrGiveUp already advanced the checkpoint on give-up
          break;
        }
        if (job.status !== 'running') updateJob(vault, jobId, { status: 'running', blocked_on: undefined }, 'ceo');
        emitTeamPlanned();
        done(i, `${state.teamPlanJobs.length} team plan(s) finished`);
        break;
      }
      case 'brief': {
        // D8: heartbeat #1 must leave the company with a site, an offer and a channel to work on, whatever the
        // plan turned out to say. Runs after team_plans (every exit path of it, including the give-up one) so a
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
