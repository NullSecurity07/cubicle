import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import {
  type Vault, type EventLog, type JobFrontmatter, type JobStatus, type RoleFrontmatter, JobResult, InboxFrontmatter,
  readJob, updateJob, setSection, appendToSection, createProposal, findInboxById, nowIso, parseNote, RoleFrontmatter as RoleSchema, createJob,
  loadGates, gatesForRisk, criteriaFor, gateAssignee, gateTier, type GateTable,
  loadOrg, isLead, teamOf, leadOf, resolveRole, officeHolder, type ModelTier,
  ciStatus, listStreams, listInbox, ENGINEERING_JOB_TYPES, RESULT_HEADING,
  trustReviewsFor, trustDecision, trustVerdictFor, recordTrustVerdict, CLASSIFIER_UNAVAILABLE_HOLD,
} from '@cubicle/core';
import { NoModelAvailableError, TIER_RANK, type ModelBudget, type RoutedChatResult, type RouteRequest, type ChatMessage } from '@cubicle/router';
import type { ToolSchema } from '@cubicle/router';
import {
  ToolRegistry, createRoleToolClient, resolveMode, policyFor, proposalKindFor, findAnswer, unreadMessages, renderMessages, listAdrs, isClassifierUnavailable,
  type ToolsConfig, type ToolContext, type SchedulerApi, type MemoryApi, type ToolResult, type RoleToolClient,
} from '@cubicle/tools';
import { assembleContext, type Observation } from './context.js';
import type { MemoryIndex } from './memory.js';

/** Anything that can answer a chat with tools — the Router, or a scripted fake in tests. */
export interface Llm {
  chat(req: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[]; maxTokens?: number }): Promise<RoutedChatResult>;
  /** Per-model prompt budget hint; the Router derives it from config. */
  promptBudget?(req: RouteRequest): number;
}

export interface Guardrail {
  /** Return a reason string to block the call, or null to allow. */
  check(tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string | null> | string | null;
}

export interface HarnessDeps {
  vault: Vault;
  llm: Llm;
  /** The real router (for tools that talk to models themselves, e.g. meetings, classifiers). */
  router?: import('@cubicle/router').Router;
  toolsConfig: ToolsConfig;
  registry: ToolRegistry;
  scheduler: SchedulerApi;
  memory?: MemoryIndex;
  guardrails?: Guardrail[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  summarize?: (text: string) => Promise<string>;
  /** Review gates per job type (spec §3); defaults to config/gates.yaml. */
  gates?: GateTable;
  maxSteps?: number;
  localMaxSteps?: number;
  /** Owner feedback lines addressed to a role (inline %%cubicle: …%% comments, preferences feedback, decision ratings). */
  ownerFeedback?: (roleId: string) => string[];
  /**
   * The division budget this job's calls run against (SP4 §4). Read **once, at job start**, not per call:
   * changing a job's tier halfway through a piece of work makes the output incoherent and the event log
   * unreadable. A division that crosses its quota mid-job finishes at its tier, and the next job drops.
   *
   * `division` is which pool the answer came from — a division id, or `house` for work the reserve pays for
   * (the company's gates). It is stamped on every `router.call` the job makes, so the gauge counts the call
   * against the pool that gated it rather than inferring one from the speaker's role.
   *
   * `jobType` is passed because it is part of the question: a gate is the company's work and the reserve pays
   * for it, while the same reviewer's own team work is their division's (see `houseRoles` in daemon/money.ts).
   */
  modelBudget?: (roleId: string, jobType?: string) => (ModelBudget & { division?: string }) | null | undefined;
}

export type JobOutcome =
  | { status: 'done' | 'failed'; result?: JobResult }
  | { status: 'blocked'; on: { kind: string; id: string } }
  | { status: 'cancelled' }
  | { status: 'requeued'; attempt: number };

const DEFAULT_MAX_STEPS = 40;
const DEFAULT_MEMBER_MAX_STEPS = 25;
const DEFAULT_LOCAL_MAX_STEPS = 15;

export function observationsPath(vault: Vault, jobId: string): string {
  return path.join(vault.cubicleDir, 'jobs', `${jobId}.jsonl`);
}

export function loadObservations(vault: Vault, jobId: string): Observation[] {
  const p = observationsPath(vault, jobId);
  if (existsSync(p)) return readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Observation]; } catch { return []; } });
  // Cache wiped: rebuild a coarse transcript from the note's Checkpoint log (vault is the source of truth).
  const note = readJob(vault, jobId);
  if (!note || note.data.checkpoint_step === 0) return [];
  const log = note.body.split('## Checkpoint log')[1]?.split('\n## ')[0] ?? '';
  const out: Observation[] = [];
  for (const line of log.split('\n')) {
    const m = line.match(/^- step (\d+): ([\w.]+)(?:\(([^)]*)\))? → (.*)$/);
    if (m) out.push({ step: Number(m[1]), kind: 'tool', tool: m[2], args: {}, result: `(from checkpoint log) ${m[4]}`, ok: !/FAILED|BLOCKED/.test(m[4]), ts: note.data.updated });
  }
  return out;
}

/** Archive attempt N's transcript so a retry starts clean. */
function archiveObservations(vault: Vault, jobId: string, attempt: number): void {
  const p = observationsPath(vault, jobId);
  if (existsSync(p)) renameSync(p, p.replace(/\.jsonl$/, `.attempt${attempt}.jsonl`));
}

/** Append one transcript entry. The daemon uses it too, to tell a job something happened while it sat blocked. */
export function appendObservation(vault: Vault, jobId: string, o: Observation): void {
  const p = observationsPath(vault, jobId);
  mkdirSync(path.dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(o) + '\n');
}

export function idempotencyKey(job: JobFrontmatter, step: number): string {
  return `${job.id}:${job.attempt}:${step}`;
}

/**
 * A job may ask for a cheaper tier than its charter (the four intelligence sweeps do): a recurring, bounded
 * job should not spend the analyst's medium-tier budget every cycle. It may only route at or below the
 * charter's tier — never above it, since the charter is the ceiling the coordinator approved for that role.
 */
export function effectiveTier(jobTier: ModelTier | undefined, roleTier: ModelTier): ModelTier {
  return jobTier && TIER_RANK[jobTier] <= TIER_RANK[roleTier] ? jobTier : roleTier;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

/** True when the owner has approved a `threat_model` proposal filed for this job. */
export function approvedThreatModel(vault: Vault, jobId: string): boolean {
  return listInbox(vault).some((n) => n.data.kind === 'threat_model' && n.data.job === jobId && n.data.approved === true);
}

/**
 * True when the owner has rejected a `threat_model` proposal filed for this job. Distinct from "not yet
 * approved" (§27, fix round 1 / Minor 6): once the owner has answered, `shipRefusal` must say what the answer
 * was rather than repeating the same "call proposal.create" instruction forever — nothing changes by asking
 * the same question again.
 */
export function rejectedThreatModel(vault: Vault, jobId: string): boolean {
  return listInbox(vault).some((n) => n.data.kind === 'threat_model' && n.data.job === jobId && n.data.approved === false);
}

/**
 * True when an ADR in `Docs/adr/` is dated on or after the day the job was created. ADRs record only a
 * calendar date (toolchain §8's `adr.create` stamps `date: nowIso().slice(0, 10)`), so "on or after the job's
 * created timestamp" is necessarily day-granular: an ADR written earlier the same day the job was created still
 * counts, since it cannot be dated more precisely than that.
 */
function hasArchitectureAdrSince(vault: Vault, jobCreated: string): boolean {
  const sinceDay = jobCreated.slice(0, 10);
  return listAdrs(vault).some((a) => a.date >= sinceDay);
}

/**
 * Why an engineering job may not report success yet, or null when it may.
 *
 * Three rules, all from the owner's operating model. §17: a change is not shipped until the pipeline has
 * validated it, so an `engineer.ship` needs a green CI record newer than every source file in its stream. §8: a
 * change that alters the architecture needs an ADR recorded, or the decision is lost the moment the job's
 * context is — the team:qa.review gate also checks for one, but a ship must not need a human reviewer to catch a
 * missing decision record before it can even finish. §27: the higher the risk, the stronger the human
 * governance, so a `high` risk change also needs a threat model the owner has approved — a decision no role
 * can be assigned, which is why it is a proposal rather than a gate.
 *
 * Failed and blocked results are never refused: a job that could not build must be able to say so.
 */
export function shipRefusal(vault: Vault, job: JobFrontmatter, result: JobResult): string | null {
  if (result.status !== 'done') return null;
  if (!(ENGINEERING_JOB_TYPES as readonly string[]).includes(job.type)) return null;
  if (!job.stream) {
    const known = listStreams(vault).map((s) => s.slug);
    return `this ${job.type} has no stream, so CI cannot be checked. Set the job's stream to one of: ${known.join(', ') || 'none yet — the product manager creates Streams/<slug>.md first'}. Ask your lead to re-queue it with the right stream, or finish with status failed and say the stream is missing.`;
  }
  const ci = ciStatus(vault, job.stream);
  if (!ci.ok) return `not shipped: ${ci.reason} (operating model §17 — a change is validated by the pipeline, not by looking at it).`;
  if (result.architecture_change && !hasArchitectureAdrSince(vault, job.created)) {
    return `this change altered the architecture (a new dependency, a new service, a new data store, a changed boundary — toolchain §8), so it needs an ADR recorded before it can finish. Call adr.create({ title: "...", context: "...", decision: "...", alternatives: [...], consequences: "..." }) and finish again.`;
  }
  if (job.risk === 'high') {
    if (rejectedThreatModel(vault, job.id)) {
      return `the owner rejected the threat model for this change (§27); it may not ship as designed. Do not file another threat_model repeating the same plan — reduce scope so it is no longer high risk, change the approach, or finish with status failed and say the change cannot proceed as designed.`;
    }
    if (!approvedThreatModel(vault, job.id)) {
      return `this is a high-risk change (${job.risk}: auth, money, destructive migrations, core infrastructure), so it needs a threat model the owner approves before it can finish (§27). Call proposal.create({ kind: "threat_model", title: "Threat model: <what changes>", body: "<assets, entry points, what an attacker would try, what stops them, what you are accepting>" }) and wait for the answer.`;
    }
  }
  return null;
}

/**
 * Run (or resume) one job to completion, a block, or the step limit. Every tool call is a checkpoint:
 * `checkpoint_step`, the Checkpoint log, and `side_effects_done` are written to the job note before the
 * next model call, so a kill at any instant resumes without repeating an external side effect.
 */
export async function runJob(deps: HarnessDeps, jobId: string, opts: { onStep?: (step: number, tool: string) => void } = {}): Promise<JobOutcome> {
  const vault = deps.vault;
  const events = vault.events;
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const gates = deps.gates ?? loadGates();

  let jobNote = readJob(vault, jobId);
  if (!jobNote) throw new Error(`job not found: ${jobId}`);
  let job = jobNote.data;
  if (job.status === 'cancelled') return { status: 'cancelled' };
  if (job.status === 'done') return { status: 'done' };
  if (job.status === 'failed') return { status: 'failed' };
  if (job.status === 'in_review') return { status: 'done' };
  if (job.status === 'blocked' && (!job.blocked_on || job.blocked_on.kind === 'owner') && job.approval !== 'pending') return { status: 'blocked', on: job.blocked_on ?? { kind: 'owner', id: jobId } };

  const roleNote = vault.readNoteOrNull(`Roles/${job.assigned}.md`);
  if (!roleNote) { updateJob(vault, jobId, { status: 'failed' }, 'daemon', `- ${nowIso()}: no charter for role ${job.assigned}`); return { status: 'failed' }; }
  const role = RoleSchema.parse(roleNote.data);
  const roleBody = roleNote.body;
  const roleId = role.role;
  const org = loadOrg(vault);

  const constitution = vault.constitution();
  const privacy: 'cloud' | 'local' = constitution.pii_local_only && (job.type === 'growth.outreach' || /Customers\//.test(jobNote.body) || role.tools.some((t) => t.startsWith('email.'))) ? 'local' : job.privacy;
  // A job may only route at or below its charter's tier, never above (see effectiveTier); privacy rules
  // below still force local routing regardless of tier.
  const tier = effectiveTier(job.model_tier, role.model_tier);
  // Read once, here, and reused by every call this job makes: `routeReq` is built before the step loop and
  // handed to the router unchanged each step, so a division that crosses its quota mid-job finishes the job at
  // the tier it started on and only its *next* job drops. A budget re-read per call would swap models halfway
  // through a piece of work, which makes the output incoherent and the event log unreadable.
  // `budget` is narrowed to what `budgetedTier` reads; which pool it was travels in its own field, because a
  // stray extra key on the request is a thing nothing reads and everything can be confused by.
  const budget = deps.modelBudget?.(roleId, job.type) ?? undefined;
  const routeReq: RouteRequest = { tier, needsTools: true, privacy, roleId, budget: budget ? { used: budget.used, quota: budget.quota } : undefined, budgetDivision: budget?.division };
  const isLeadOrCeo = isLead(org, roleId) || roleId === officeHolder(org, 'chief_executive');
  const maxSteps = privacy === 'local' || tier === 'local' ? (deps.localMaxSteps ?? DEFAULT_LOCAL_MAX_STEPS) : (deps.maxSteps ?? (isLeadOrCeo ? DEFAULT_MAX_STEPS : DEFAULT_MEMBER_MAX_STEPS));
  const promptBudget = deps.llm.promptBudget?.(routeReq) ?? 6000;

  const memoryApi: MemoryApi | undefined = deps.memory ? { search: (q, k, dirs) => deps.memory!.search(q, k, dirs), indexFile: (rel) => deps.memory!.indexFile(rel).then(() => undefined) } : undefined;
  const baseCtx: ToolContext = {
    vault, events, roleId, role, jobId, config: deps.toolsConfig, env, scheduler: deps.scheduler, memory: memoryApi, router: deps.router,
    workspace: `.cubicle/workspace/${jobId}`, now,
    // The MCP wrapper re-checks these. The pre-checks below block *before* calling the client, so a call
    // the loop refuses never reaches the wrapper and `guardrail.blocked` is emitted exactly once.
    guardrails: deps.guardrails,
  };
  const defs = deps.registry.forRole(role, deps.toolsConfig);
  const client = await createRoleToolClient(defs, baseCtx);
  const prefs = vault.ownerPreferences();

  const observations = loadObservations(vault, jobId);
  const record = (o: Omit<Observation, 'ts'>) => { const full = { ...o, ts: nowIso() }; observations.push(full); appendObservation(vault, jobId, full); };
  const refresh = () => {
    const n = readJob(vault, jobId);
    if (n) { jobNote = n; job = n.data; }
    else events.emit({ type: 'daemon.warning', agent: roleId, job: jobId, payload: { reason: 'job note unreadable mid-run (owner editing?); keeping last good copy' } });
    return job;
  };
  const cancelled = () => refresh().status === 'cancelled';

  /**
   * Extract the **last** `## Result` JSON block written into a job's body (survives the sub-job's own writes to
   * that section). Last, not first: the agent-supplied `## Research request` section is rendered above it, so a
   * requester could otherwise forge the result a gate reads by putting a heading and a fence in their question.
   * Length-checked because `split` on a body with no heading returns the whole body.
   */
  const resultFrom = (body: string): JobResult => {
    const parts = body.split(RESULT_HEADING);
    const raw = parts.length > 1 ? parts[parts.length - 1].match(/```json\n([\s\S]*?)\n```/)?.[1] : undefined;
    if (!raw) return JobResult.parse({ status: 'done' });
    try { return JobResult.parse(JSON.parse(raw)); } catch { return JobResult.parse({ status: 'done' }); }
  };

  const finishWith = async (result: JobResult, step: number): Promise<JobOutcome> => {
    const isGateJob = /\.(review|verify)$/.test(job.type) && !!job.parent;
    const chain = gatesForRisk(gates, job.type, job.risk);
    const gateIndex = Number(job.gate_index ?? 0);
    const nextGate = result.status === 'done' && !isGateJob ? chain[gateIndex] : undefined;
    const finalStatus: JobStatus = result.status === 'done' ? (nextGate ? 'in_review' : 'done') : result.status === 'blocked' ? 'blocked' : 'failed';
    vault.updateNote(`Jobs/${jobId}.md`, (n) => ({
      data: { ...n.data, status: finalStatus, checkpoint_step: step, updated: nowIso(), ...(result.status === 'blocked' ? { blocked_on: { kind: 'owner', id: jobId, since: nowIso() } } : {}) },
      body: setSection(n.body, '## Result', '```json\n' + JSON.stringify(result, null, 2) + '\n```'),
    }), roleId, { job: jobId });
    if (finalStatus === 'in_review') {
      events.emit({ type: 'job.checkpoint', agent: roleId, job: jobId, payload: { in_review: nextGate, summary: result.summary } });
      enqueueGate(nextGate!, job, result);
    } else {
      events.emit({ type: finalStatus === 'done' ? 'job.done' : finalStatus === 'blocked' ? 'job.blocked' : 'job.failed', agent: roleId, job: jobId, payload: { status: result.status, summary: result.summary, artifacts: result.artifacts, blockers: result.blockers, metrics: result.metrics, lessons: result.lessons, verdict: result.verdict } });
    }
    if (isGateJob && result.status === 'done') applyVerdict(job.parent!, job.type, result);
    // A gate job that fails (explicit finish(failed), or step_limit/no_tool_calls/invalid_tool_json exhausting
    // attempts via failOrRequeue) must not strand the parent in in_review forever: treat it as a return.
    if (isGateJob && result.status === 'failed') {
      const findings = result.blockers.length ? result.blockers : result.summary ? [result.summary] : ['reviewer could not complete the review'];
      applyVerdict(job.parent!, job.type, { ...result, verdict: 'return', findings });
    }
    // SP5: a trust review gates a *call*, not a job's gate chain, so it carries no `parent`, `isGateJob` is false
    // and `applyVerdict` never sees it. `trustVerdictFor` turns this Result block into the one record that counts,
    // and makes a review that ran out of steps a *return* — a review that did not happen is not a pass.
    const trustVerdict = trustVerdictFor(job, result);
    if (trustVerdict) recordTrustVerdict(vault, trustVerdict);
    // Skills loop (spec §9.3): a failed job counts a failure against every skill it loaded; two failures archive the skill.
    if (result.status === 'failed') {
      const loaded = [...new Set(observations.filter((o) => o.kind === 'tool' && o.tool === 'skills.load' && o.ok !== false).map((o) => String(o.args?.name ?? '')))].filter(Boolean);
      for (const name of loaded) {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
        const rel = `Skills/${slug}.md`;
        const note = vault.readNoteOrNull<{ failures?: number; name?: string }>(rel);
        if (!note) continue;
        const failures = Number(note.data.failures ?? 0) + 1;
        if (failures >= 2) {
          vault.move(rel, `Skills/archive/${slug}-${nowIso().slice(0, 10)}.md`, 'daemon', { job: jobId });
          vault.appendText('Memory/lessons.md', `- [${nowIso().slice(0, 10)}] [[${jobId}]] skill "${note.data.name ?? slug}" failed twice and was archived (coo)\n`, 'daemon', { job: jobId });
          events.emit({ type: 'daemon.warning', agent: 'coo', job: jobId, payload: { where: 'skills', message: `skill ${slug} archived after 2 failures` } });
        } else {
          vault.writeNote(rel, { ...note.data, failures }, note.body, 'daemon', { job: jobId });
        }
      }
    }
    // Lessons loop (spec §9.1): every reported lesson lands in Memory/lessons.md, one line, deduplicated per job.
    // Each line is tagged with its team so assembleContext can filter out other teams' lessons.
    const lessons = (result.lessons ?? []).map((l) => l.trim()).filter(Boolean);
    if (lessons.length) {
      const teamTag = job.team ?? teamOf(org, roleId)?.id ?? 'company';
      const existing = vault.readTextOrNull('Memory/lessons.md') ?? '# Lessons\n';
      const lines = lessons.filter((l) => !existing.includes(`[[${jobId}]] ${l}`)).map((l) => `- [${nowIso().slice(0, 10)}] [[${jobId}]] ${l} (${roleId}) #team:${teamTag}`);
      if (lines.length) vault.appendText('Memory/lessons.md', lines.join('\n') + '\n', roleId, { job: jobId });
    }
    await client.close();
    return { status: finalStatus === 'in_review' ? 'done' : finalStatus, result } as JobOutcome;
  };

  /**
   * The room a gate's name points at, with the `office:`/`team:` prefix stripped. Gates are named by office
   * (`office:operations.verify`) or by room (`team:qa.review`); the pre-office names (`qa.review`) carry the
   * room id bare. Everything downstream of the assignee — the second-pair-of-eyes search, above all — wants
   * that bare id, not the prefixed one.
   */
  const gateRoom = (gate: string): string => {
    const dot = gate.lastIndexOf('.');
    const head = dot === -1 ? gate : gate.slice(0, dot);
    return head.replace(/^(?:office|team):/, '');
  };

  /** True when `gate` is the QA review, under its office-era name or the pre-office one. */
  const isQaGate = (gate: string) => gate === 'team:qa.review' || gate === 'qa.review';
  /** True when `gate` is the security review, under either name. */
  const isSecurityGate = (gate: string) => gate === 'office:security.review' || gate === 'security.review';
  /** True when `gate` is the operations verification (`office:operations.verify` / `coo.verify`). */
  const isVerifyGate = (gate: string) => gate.endsWith('.verify');

  /**
   * A gate is a second pair of eyes (spec §4), so nobody reviews their own work. When the resolved assignee is
   * the job's own author — the shape `research.review` has by default, since both the `research` job and its
   * gate resolve to the research team's lead — hand the gate to someone else, in the brief's order: an active
   * member of the gate's team (the research lead's team for `research.review`), then that lead's own lead (the
   * COO for Research), then the CEO. Returns null when the author is genuinely the only person who could look.
   */
  const secondPairOfEyes = (gate: string, assignee: string, author: string): string | null => {
    const team = org.teams[gateRoom(gate)] ?? teamOf(org, assignee);
    const candidates = [...(team?.members ?? []), team?.lead ?? '', leadOf(org, assignee) ?? '', officeHolder(org, 'chief_executive')];
    return candidates.find((c) => c && c !== author && org.roles[c]) ?? null;
  };

  /** Create the review job for one gate of `parent`. */
  const enqueueGate = (gate: string, parent: JobFrontmatter, result: JobResult): void => {
    let assignee = resolveRole(org, gateAssignee(gate, parent, org));
    // The named assignee may have no active worker (role fired/deactivated, or a `for`/owner_role naming an
    // unknown role): fall back to its lead so the parent never sits in_review forever (F1).
    if (!org.roles[assignee]) {
      const chief = officeHolder(org, 'chief_executive');
      const fallback = leadOf(org, assignee) ?? (gate === 'requester.review' ? (leadOf(org, parent.owner_role ?? '') ?? chief) : chief);
      events.emit({ type: 'daemon.warning', agent: roleId, job: parent.id, payload: { where: 'enqueueGate', message: `gate ${gate} assignee "${assignee}" has no active worker; reassigned to ${fallback}` } });
      assignee = fallback;
    }
    // C1/M9: the author is not their own reviewer. research_manager both authors `research` jobs and leads the
    // team `research.review` resolves to, and `requester.review` falls back to the same lead when the decision
    // owner went inactive — either way the gate would have been a self-review and the spec's quality gate would
    // do nothing.
    if (assignee === parent.assigned) {
      const other = secondPairOfEyes(gate, assignee, parent.assigned);
      if (other) {
        events.emit({ type: 'daemon.warning', agent: roleId, job: parent.id, payload: { where: 'enqueueGate', message: `gate ${gate} resolved to the job's own author ${assignee}; reassigned to ${other}` } });
        assignee = other;
      }
    }
    const criteria = criteriaFor(gates, parent.type);
    // The gate's *own* criteria, when it has one (research.review's §35 checklist, team:qa.review's "cite a file").
    // `gates[gate]` is read directly rather than through criteriaFor so a gate with no entry stays silent
    // instead of inheriting the `custom` fallback meant for the job under review.
    const gateCriteria = gates[gate]?.criteria ?? '';
    deps.scheduler.enqueue({
      type: gate, title: `${isVerifyGate(gate) ? 'Verify' : 'Review'}: ${parent.title}`, assigned: assignee, priority: 4, parent: parent.id, links: [`[[${parent.id}]]`], privacy: parent.privacy,
      // A review runs at the gate's tier — medium unless `config/gates.yaml` says otherwise — not at the
      // reviewer's charter tier. Reviewers are leads and office holders, so without this every gate was a
      // strong-tier call: the owner's first live run burnt eleven of a ~60-a-day free allowance on reviews in
      // one minute (FR-7). `effectiveTier` still clamps this to the charter, so a cheap charter reviews cheap.
      model_tier: gateTier(gates, gate),
      team: parent.team, owner_role: parent.owner_role, for: parent.for,
      // The reviewer needs the change's stream — where the CI records and the code are — or a team:qa.review cannot
      // tell a fresh green run from a stale one. The parent's *risk* is passed in the goal below rather than
      // set on the gate job: a gate type's own chain is empty, and `gatesForRisk` would read a carried-over
      // `high` as "this review is itself reviewed by office:security.review".
      stream: parent.stream,
      goal: `Review job [[${parent.id}]] (${parent.type}) as the ${gate} gate. What good looks like: ${criteria}${gateCriteria ? `\nAs the ${gate} reviewer, check: ${gateCriteria}` : ''}\nDone when (author's): ${parent.done_when ?? 'not stated'}\nAuthor's summary: ${result.summary}${isQaGate(gate) && parent.stream ? `\nThe CI record for stream "${parent.stream}" is at Workspace/${parent.stream}/.cubicle-ci/ — read the newest one; a green record older than the change is not a pass. If this change altered the architecture (a new dependency, a new service, a new data store, a changed boundary) there must be an ADR in Docs/adr/; return it if there is not.` : ''}${isSecurityGate(gate) ? `\nThis change is ${parent.risk} risk. Name the data, credentials and permissions it touches and judge each one.` : ''}${gate === 'research.review' ? `\nThe requester asked for ${parent.research?.required_confidence ?? 'an unstated'} confidence on a ${parent.research?.portfolio ?? 'an unstated'} bet: judge the evidence against that bar, not against your own. Under-confidence stated honestly passes; confidence the evidence does not carry does not.` : ''}\nRead its Result block and artifacts, check with evidence, then finish with status done and verdict pass, or verdict return with findings that name a file or an output line${isVerifyGate(gate) ? ', plus exactly one lesson in finish.lessons' : ''}. A job may be returned once per gate; a second return fails it.`,
    });
  };

  /** A gate job finished: advance or return the parent. */
  const applyVerdict = (parentId: string, gate: string, result: JobResult): void => {
    const p = readJob(vault, parentId); if (!p || p.data.status !== 'in_review') return;
    const chain = gatesForRisk(gates, p.data.type, p.data.risk);
    const idx = Number(p.data.gate_index ?? 0);
    if (result.verdict !== 'return') {
      events.emit({ type: 'review.passed', agent: roleId, job: parentId, payload: { gate, findings: result.findings } });
      const next = chain[idx + 1];
      if (next) {
        updateJob(vault, parentId, { gate_index: idx + 1 }, 'daemon', `- ${nowIso()}: ${gate} passed; next gate ${next}`);
        enqueueGate(next, readJob(vault, parentId)!.data, resultFrom(p.body));
      } else {
        updateJob(vault, parentId, { status: 'done' }, 'daemon', `- ${nowIso()}: all gates passed`);
        events.emit({ type: 'job.done', agent: p.data.assigned, job: parentId, payload: { status: 'done', summary: `passed ${chain.join(' → ')}` } });
        if (p.data.type === 'research') events.emit({ type: 'research.delivered', agent: p.data.assigned, job: parentId, payload: {} });
      }
      return;
    }
    const returns = { ...p.data.returns, [gate]: (p.data.returns[gate] ?? 0) + 1 };
    if (returns[gate] > 1) {
      updateJob(vault, parentId, { status: 'failed', returns }, 'daemon', `- ${nowIso()}: returned twice by ${gate}; failed`);
      events.emit({ type: 'job.failed', agent: p.data.assigned, job: parentId, payload: { reason: `returned twice by ${gate}`, findings: result.findings } });
      return;
    }
    vault.updateNote(`Jobs/${parentId}.md`, (n) => ({
      // A returned job resumes from its checkpoint (the observations are kept) but must get a fresh step budget,
      // not the remainder of the attempt that already reached the gate (F3): budget_from anchors maxSteps to the
      // step the job was at when it was returned, instead of the loop comparing step against a bare maxSteps.
      data: { ...n.data, status: 'queued', attempt: Number(n.data.attempt ?? 1) + 1, returns, gate_index: idx, budget_from: n.data.checkpoint_step, updated: nowIso() },
      body: appendToSection(n.body, '## Review findings', `- ${nowIso().slice(0, 16)} ${gate}: ${result.findings.join('; ') || result.summary}`),
    }), 'daemon', { job: parentId });
    events.emit({ type: 'review.returned', agent: roleId, job: parentId, payload: { gate, findings: result.findings } });
  };

  /** Non-explicit failures (step limit, bad JSON, no tool calls) retry while attempts remain; explicit finish(failed) is final. */
  const failOrRequeue = async (step: number, reason: string, summary: string): Promise<JobOutcome> => {
    if (job.attempt < job.max_attempts) {
      archiveObservations(vault, jobId, job.attempt);
      // A fresh attempt starts its transcript over at step 0, so any budget_from anchored to a stale checkpoint
      // (e.g. a prior gate return) must be cleared, or this attempt would get more than its own maxSteps.
      updateJob(vault, jobId, { status: 'queued', attempt: job.attempt + 1, checkpoint_step: 0, budget_from: 0 }, roleId, `- ${nowIso()}: ${reason} at step ${step}; requeued as attempt ${job.attempt + 1}`);
      events.emit({ type: 'job.failed', agent: roleId, job: jobId, payload: { reason, requeued: true, attempt: job.attempt + 1 } });
      await client.close();
      return { status: 'requeued', attempt: job.attempt + 1 };
    }
    return finishWith(JobResult.parse({ status: 'failed', summary, blockers: [reason] }), step);
  };
  const failStepLimit = (step: number) => failOrRequeue(step, 'step_limit', `Step limit (${maxSteps}) reached without finishing.`);

  // ---- resume handling: pending proposal, answered question, finished sub-job ----
  // The dispatcher requeues such jobs as `queued` while leaving `blocked_on` in place, so key on blocked_on, not status.
  if (job.blocked_on && job.blocked_on.kind !== 'owner' && job.blocked_on.kind !== 'quota') {
    const b = job.blocked_on;
    const stillBlocked = async (): Promise<JobOutcome> => {
      if (job.status !== 'blocked') updateJob(vault, jobId, { status: 'blocked' }, roleId);
      await client.close();
      return { status: 'blocked', on: b };
    };
    if (b.kind === 'proposal') {
      const prop = findInboxById(vault, b.id);
      const call = prop?.data.call;
      /**
       * Spec §3: whether the two offices have cleared the stored call, or `null` when it owes them nothing.
       * Read once, here, because both answers below turn on it: an approved call whose reviews are still out is
       * held (nothing is spent while they are out), and a returned call is refused whether or not the owner ever
       * answered. The dispatcher holds the proposal for the same reason, and the tool layer would refuse the call
       * regardless — but only after the key had been spent, and the at-most-once ledger is append-only, so this
       * check is what keeps a verdict that lands ten minutes later still able to send.
       */
      const trust = call ? trustDecision(events, deps.toolsConfig.tools[call.tool], call) : null;
      if (prop && prop.data.approved === true && !call && prop.data.kind === 'threat_model') {
        // A threat_model the owner approves carries no stored call — it is a plain decision, not something to
        // execute — so the answer itself is the unblock. Without this the job sat blocked forever. Narrowed to
        // `threat_model` specifically (fix round 1 / Important 4) rather than "any call-less approved
        // proposal": today it is the only kind whose tool result sets `block: { kind: 'proposal' }` without a
        // `call` (`packages/tools/src/tools/proposal.ts`), and a future kind that does the same must extend
        // this condition deliberately rather than inherit an unblock it was never designed for.
        record({ step: job.checkpoint_step, kind: 'system', text: `The owner approved ${prop.data.kind} ${b.id}. You may continue.` });
        updateJob(vault, jobId, { status: 'running', approval: 'approved', blocked_on: undefined }, roleId, `- ${nowIso()}: ${prop.data.kind} ${b.id} approved by the owner`);
      } else if (prop && prop.data.approved === true && call) {
        const step = job.checkpoint_step; // the pending call owns this step
        const key = call.idempotency_key;
        if (trust?.kind === 'hold') return stillBlocked();
        // The approval is older than the config: the tool's mode may have moved to `never` — in tools.yaml, in
        // this charter, or in the owner's preferences — while the job sat blocked. Preferences are re-read here
        // rather than reused from `prefs` above, which is the snapshot taken when the run started. Checking
        // before the call keeps the idempotency key unspent, so re-approving works once the mode is relaxed;
        // without it the wrapper refused the call only after the key was burned. Mirrors the dispatcher (D3/M1).
        // A returned review takes the same path a revoked mode does: the refusal and its findings are recorded,
        // the key stays unspent, and the job runs on and may file a fresh call.
        const revoked = trust?.kind === 'returned'
          ? trust.reason
          : resolveMode(call.tool, deps.toolsConfig, role, vault.ownerPreferences()) === 'never'
            ? `${call.tool} is set to mode never; the owner's configuration outranks this approval`
            : null;
        const alreadyDone = job.side_effects_done.includes(key);
        let vetoed: string | null = revoked;
        // Not for a call that already ran: the classifier is a model round trip with its own twenty-second
        // bound, and spending it to re-judge a send that is already out is twenty seconds of nothing.
        if (!vetoed && !alreadyDone) for (const g of deps.guardrails ?? []) { vetoed = await g.check(call.tool, call.args, baseCtx); if (vetoed) break; }
        if (alreadyDone) {
          record({ step, kind: 'tool', tool: call.tool, args: call.args, result: 'already executed before the interruption (idempotency key recorded)', ok: true });
        } else if (vetoed && isClassifierUnavailable(vetoed)) {
          // Nobody checked this call, so nobody refused it either. Recording a block here would spend the
          // owner's approval on a twenty-second model outage — the round-1 Critical, on the path the
          // classifier actually takes (re-review 1). Stay blocked on the proposal exactly as a pending trust
          // review does: the key is unspent and the job's `blocked_on` stands.
          //
          // And leave the dispatcher's own marker on the note, because by the time this runs the note is
          // usually **resolved** — that is the window this branch exists for — and without the marker
          // `requeueUnblocked` would wake this job on the very next tick, only for this branch to put it
          // back, once per tick, for the whole outage (re-review 2, I1). Written once: a second pass through
          // here would say nothing new, and every line of it is an autocommitted vault write.
          const alreadyHeld = (prop.data as { refused?: string }).refused === CLASSIFIER_UNAVAILABLE_HOLD;
          if (!alreadyHeld) {
            vault.updateNote(prop.path, (n) => ({ data: { ...n.data, refused: CLASSIFIER_UNAVAILABLE_HOLD, refused_at: nowIso() }, body: n.body }), 'daemon');
            events.emit({ type: 'guardrail.deferred', agent: roleId, job: jobId, payload: { tool: call.tool, reason: vetoed, step, approved: true } });
            updateJob(vault, jobId, {}, roleId, `- step ${step}: ${call.tool} waiting for the constitution guardrail: ${vetoed}`);
          }
          return stillBlocked();
        } else if (vetoed) {
          events.emit({ type: 'guardrail.blocked', agent: roleId, job: jobId, payload: { tool: call.tool, reason: vetoed, step, approved: true } });
          record({ step, kind: 'tool', tool: call.tool, args: call.args, result: `blocked even though approved: ${vetoed}`, ok: false });
          updateJob(vault, jobId, {}, roleId, `- step ${step}: ${call.tool} BLOCKED even though approved: ${vetoed}`);
        } else {
          // The guardrail answered, so whatever hold a previous pass left on the note is over. Clearing it
          // keeps a resolved note from carrying a stale marker that says the company is still waiting.
          if ((prop.data as { refused?: string }).refused === CLASSIFIER_UNAVAILABLE_HOLD) {
            vault.updateNote(prop.path, (n) => { const { refused: _r, refused_at: _a, ...rest } = n.data as Record<string, unknown>; return { data: rest, body: n.body }; }, 'daemon');
          }
          // At-most-once: record the key before the external call (a kill mid-call must not replay it).
          updateJob(vault, jobId, { side_effects_done: [...job.side_effects_done, key] }, roleId, `- step ${step}: ${call.tool} ATTEMPTING after owner approval (${key})`);
          const res = await client.call(call.tool, call.args, { idempotencyKey: key });
          updateJob(vault, jobId, {}, roleId, `- step ${step}: ${call.tool} → ${res.ok ? 'ok' : 'failed'}`);
          record({ step, kind: 'tool', tool: call.tool, args: call.args, result: `(approved by owner) ${res.text}`, ok: res.ok });
          events.emit({ type: 'agent.tool_result', agent: roleId, job: jobId, payload: { tool: call.tool, ok: res.ok, step, approved: true } });
        }
        updateJob(vault, jobId, { status: 'running', approval: 'approved', blocked_on: undefined }, roleId);
      } else if (prop && prop.data.approved == null && call && trust?.kind === 'returned') {
        // The offices returned the call while the owner was still deciding. A return outranks an approval on
        // every path, so an approval that arrives now could not send it either: waiting on the owner is waiting
        // for an answer that cannot help. The refusal is recorded with the review's own words, the key is never
        // spent, and the job finishes blocked. (The daemon's sweep closes the proposal note itself.)
        const step = job.checkpoint_step;
        const reason = trust.reason;
        events.emit({ type: 'guardrail.blocked', agent: roleId, job: jobId, payload: { tool: call.tool, reason, step, approved: false } });
        record({ step, kind: 'tool', tool: call.tool, args: call.args, result: `blocked: ${reason}`, ok: false });
        updateJob(vault, jobId, { approval: 'rejected', blocked_on: undefined }, roleId, `- step ${step}: ${call.tool} BLOCKED by the trust review before the owner answered: ${reason}`);
        refresh();
        return finishWith(JobResult.parse({ status: 'blocked', summary: reason, blockers: [reason] }), step);
      } else if (prop && prop.data.approved === false) {
        record({ step: job.checkpoint_step, kind: 'tool', tool: call?.tool ?? 'unknown', args: call?.args ?? {}, result: 'rejected by owner. Do not retry this action; adapt or finish.', ok: false });
        updateJob(vault, jobId, { status: 'running', approval: 'rejected', blocked_on: undefined }, roleId, `- step ${job.checkpoint_step}: ${call?.tool ?? 'call'} rejected by owner`);
      } else {
        return stillBlocked();
      }
    } else if (b.kind === 'message') {
      const answer = findAnswer(vault, roleId, b.id) ?? (() => {
        const n = findInboxById(vault, b.id);
        return n && n.data.answered ? { from: 'owner', body: (n.body.split('## Owner')[1] ?? n.body).trim() } : null;
      })();
      if (!answer) return stillBlocked();
      record({ step: job.checkpoint_step, kind: 'system', text: `Answer from ${answer.from} to your question ${b.id}:\n${answer.body}` });
      updateJob(vault, jobId, { status: 'running', blocked_on: undefined }, roleId, `- ${nowIso()}: question ${b.id} answered by ${answer.from}`);
    } else if (b.kind === 'job') {
      const sub = readJob(vault, b.id);
      if (!sub || !['done', 'failed', 'cancelled'].includes(sub.data.status)) return stillBlocked();
      record({ step: job.checkpoint_step, kind: 'system', text: `Sub-job ${b.id} finished with status ${sub.data.status}.\n${sub.body.split('## Result')[1]?.trim() ?? ''}` });
      updateJob(vault, jobId, { status: 'running', blocked_on: undefined }, roleId);
    }
    refresh();
  }

  if (job.status !== 'running') {
    updateJob(vault, jobId, { status: 'running' }, roleId, `- ${nowIso()}: started (attempt ${job.attempt}, from step ${job.checkpoint_step})`);
    events.emit({ type: 'job.started', agent: roleId, job: jobId, payload: { type: job.type, title: job.title, attempt: job.attempt, from_step: job.checkpoint_step, resumed: job.checkpoint_step > 0 } });
    refresh();
  }

  const toolSchemas = await client.listTools();
  const ownerEditsSince = events.last('heartbeat.completed')?.ts;
  let step = job.checkpoint_step;
  // A job resumed after a gate return gets a fresh budget of maxSteps from the checkpoint it was returned at
  // (F3), not the bare maxSteps its remaining attempt would otherwise be squeezed into.
  const stepLimit = (job.budget_from ?? 0) + maxSteps;
  let noToolStreak = 0;
  let jsonRetries = 0;
  let blockedPushedBack = false;

  let ownerEditCache: { at: number; list: ReturnType<typeof events.query> } | null = null;
  while (step < stepLimit) {
    if (cancelled()) { events.emit({ type: 'job.cancelled', agent: roleId, job: jobId, payload: { at_step: step } }); await client.close(); return { status: 'cancelled' }; }
    // Colleague messages are persisted into the transcript first, then marked read (survive kills and turns).
    const unread = unreadMessages(vault, roleId, false);
    if (unread.length) { record({ step, kind: 'system', text: `New messages for you:\n${renderMessages(unread)}` }); unreadMessages(vault, roleId, true); }
    if (!ownerEditCache || Date.now() - ownerEditCache.at > 30_000) ownerEditCache = { at: Date.now(), list: events.query({ types: ['owner.edited'], from: ownerEditsSince, limit: 200 }).slice(-50) };
    const feedback = deps.ownerFeedback?.(roleId) ?? [];
    const extraSystem = [
      feedback.length ? `# Owner feedback for you (the owner's instructions outrank your own plans)\n${feedback.slice(0, 20).join('\n')}` : '',
      noToolStreak >= 2 ? 'You have replied twice without calling a tool. You MUST call a tool now, or call `finish`.' : '',
    ].filter(Boolean).join('\n\n');
    const messages = await assembleContext({
      vault, role, roleBody, job, jobBody: jobNote.body, observations, memory: deps.memory, maxPromptTokens: promptBudget,
      ownerEdits: ownerEditCache.list, summarize: deps.summarize, maxSteps, org, gates,
      extraSystem: extraSystem || undefined,
    });
    events.emit({ type: 'agent.thinking', agent: roleId, job: jobId, payload: { step } });
    let reply: RoutedChatResult;
    try {
      reply = await deps.llm.chat(routeReq, { messages, tools: toolSchemas, maxTokens: 1500 });
    } catch (err) {
      if (!(err instanceof NoModelAvailableError)) { await client.close().catch(() => undefined); throw err; }
      const msg = (err as Error).message;
      const prevRetries = job.blocked_on?.kind === 'quota' ? Number((job.blocked_on as { retries?: number }).retries ?? 0) : 0;
      updateJob(vault, jobId, { status: 'blocked', blocked_on: { kind: 'quota', id: 'all-providers', since: nowIso(), retries: prevRetries } as JobFrontmatter['blocked_on'] }, roleId, prevRetries ? undefined : `- ${nowIso()}: no model available (${msg.slice(0, 120)}); blocked on quota`);
      events.emit({ type: 'job.blocked', agent: roleId, job: jobId, payload: { reason: 'quota', message: msg.slice(0, 200) } });
      await client.close();
      return { status: 'blocked', on: { kind: 'quota', id: 'all-providers' } };
    }
    if (reply.jsonParseError) {
      jsonRetries++;
      record({ step, kind: 'system', text: `Your reply was not a single JSON object (${reply.jsonParseError}). Reply again with exactly one JSON object: {"tool": ..., "args": {...}} or {"final": "..."}.` });
      if (jsonRetries >= 3) return failOrRequeue(step, 'invalid_tool_json', 'Model could not produce a valid tool call after 3 attempts.');
      continue;
    }
    jsonRetries = 0;
    if (reply.parsedToolCalls.length === 0 && reply.finalAnswer && defs.some((d) => d.name === 'finish')) {
      // JSON-mode models signal completion with {"final": ...}; treat it as finish(done).
      reply.parsedToolCalls = [{ name: 'finish', args: { status: 'done', summary: reply.content.slice(0, 2000) } }];
    }
    if (reply.parsedToolCalls.length === 0) {
      noToolStreak++;
      record({ step, kind: 'assistant', text: reply.content || '(empty reply)' });
      if (noToolStreak >= 4) return failOrRequeue(step, 'no_tool_calls', `Model stopped calling tools. Last reply: ${reply.content.slice(0, 300)}`);
      continue;
    }
    noToolStreak = 0;

    for (const call of reply.parsedToolCalls) {
      if (cancelled()) { events.emit({ type: 'job.cancelled', agent: roleId, job: jobId, payload: { at_step: step } }); await client.close(); return { status: 'cancelled' }; }
      step++;
      opts.onStep?.(step, call.name);
      const toolName = call.name;
      const args = call.args ?? {};
      const policy = policyFor(deps.toolsConfig, toolName);
      const key = idempotencyKey(job, step);
      events.emit({ type: 'agent.tool_call', agent: roleId, job: jobId, payload: { tool: toolName, summary: summarizeArgs(args), step } });

      if (!defs.some((d) => d.name === toolName)) {
        record({ step, kind: 'tool', tool: toolName, args, result: `unknown tool "${toolName}". Available: ${defs.map((d) => d.name).join(', ')}`, ok: false });
        updateJob(vault, jobId, { checkpoint_step: step }, roleId, `- step ${step}: unknown tool ${toolName}`);
        continue;
      }
      // Resume: outbound side effect already done for this exact step
      if (policy.outbound && job.side_effects_done.includes(key)) {
        record({ step, kind: 'tool', tool: toolName, args, result: 'already executed before the interruption (idempotency key recorded); continue.', ok: true });
        updateJob(vault, jobId, { checkpoint_step: step }, roleId, `- step ${step}: ${toolName} skipped (idempotency ${key})`);
        continue;
      }
      // Guardrails (constitution etc.)
      let blockedReason: string | null = null;
      for (const g of deps.guardrails ?? []) { blockedReason = await g.check(toolName, args, baseCtx); if (blockedReason) break; }
      let mode = blockedReason ? 'never' : resolveMode(toolName, deps.toolsConfig, role, prefs);
      // R17: tools marked first_time_only (deploy.site) need approval once; after a recorded completion the
      // relaxation below drops them to `auto`, unless the owner pinned a stricter mode in owner_preferences.
      // "Automatic" stops there for a leaving call: since SP5 Decision 6 the trust raise a few lines down puts
      // every live deploy back to `propose`, so it is filed and read by the two offices however this resolves.
      if (mode === 'propose' && policy.first_time_only && !prefs.approvals[toolName]) {
        // Only a *live* deploy spends the first-time approval: since progressive delivery landed, the first
        // deploy.site call is a preview, and a preview must not buy the production deploy its approval.
        // A deploy.done from before stages existed always went to the production branch, so it counts as live.
        const isLive = (e: { payload: Record<string, unknown> }) => (e.payload.stage ?? 'live') === 'live';
        const deploys = events.query({ types: ['deploy.done'], limit: 500, order: 'desc' });
        const liveDone = deploys.some((e) => e.payload.mode === 'live' && isLive(e));
        const brandUrl = /^url:\s*["']?https?:\/\//m.test(vault.readTextOrNull('Brand/name.md') ?? '');
        const anyDone = deploys.some(isLive);
        // Mock deploys do not count once live keys exist: the first *live* deploy still needs approval.
        const live = !!(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID);
        if ((live ? liveDone || brandUrl : anyDone)) mode = 'auto';
      }
      // Spec §3 / Decision 6: a leaving call is never executed in the same breath as it is made. `auto` is raised
      // to `propose` so the agent is not simply refused mid-job — the call is filed, the job carries on, and the
      // send happens after the owner's approval and both reviews. `ask` and `propose` behave as they always did.
      // The raise is guarded on `policy.outbound` because the whole mechanism is keyed on the idempotency key,
      // which only an outbound tool gets; in `config/tools.yaml` every `trust_review` tool is outbound.
      //
      // It runs *after* the `first_time_only` relaxation above, not before: that relaxation is what turns a live
      // `deploy.site` into an `auto` call, and an `auto` leaving call executes — spending the key on something the
      // tool layer refuses. The at-most-once ledger is append-only, so a key spent that way is spent for good and
      // no verdict landing later could send the call. Raising last is what keeps the key unspent.
      const trustGates = trustReviewsFor(policy, toolName, args);
      const trustRaised = trustGates.length > 0 && policy.outbound && mode === 'auto';
      if (trustRaised) mode = 'propose';
      const trustBody = trustGates.length
        ? `\n\n${trustGates.join(' and ')} read the exact text above before it goes out; a return closes it unsent.${trustRaised ? ` (You set \`${toolName}\` to run automatically. It is filed here anyway because it leaves the company.)` : ''}`
        : '';
      if (mode === 'never') {
        const reason = blockedReason ?? 'approval mode is never';
        events.emit({ type: 'guardrail.blocked', agent: roleId, job: jobId, payload: { tool: toolName, reason, step } });
        record({ step, kind: 'tool', tool: toolName, args, result: `blocked: ${reason}`, ok: false });
        updateJob(vault, jobId, { checkpoint_step: step }, roleId, `- step ${step}: ${toolName} BLOCKED (${reason})`);
        continue;
      }
      if (mode === 'ask') {
        const kind = proposalKindFor(deps.toolsConfig, toolName);
        const { id } = createProposal(vault, {
          kind, from: roleId, job: jobId, title: `${roleId} asks to run ${toolName}`,
          body: `Job [[${jobId}]] (${job.title}) wants to call \`${toolName}\`:\n\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\`\n\nSet \`approved: true\` to run it, \`approved: false\` to refuse.${trustBody}`,
          call: { tool: toolName, args, idempotency_key: key, job: jobId, role: roleId },
        }, roleId);
        updateJob(vault, jobId, { status: 'blocked', approval: 'pending', checkpoint_step: step, blocked_on: { kind: 'proposal', id, since: nowIso() } }, roleId, `- step ${step}: ${toolName} awaits owner approval (${id})`);
        record({ step, kind: 'system', text: `Call to ${toolName} is waiting for the owner's approval (${id}).` });
        events.emit({ type: 'job.blocked', agent: roleId, job: jobId, payload: { reason: 'approval', proposal: id, tool: toolName } });
        await client.close();
        return { status: 'blocked', on: { kind: 'proposal', id } };
      }
      if (mode === 'propose' && policy.outbound) {
        const kind = proposalKindFor(deps.toolsConfig, toolName);
        const { id } = createProposal(vault, {
          kind, from: roleId, job: jobId, title: `${roleId} proposes ${toolName}`,
          body: `Job [[${jobId}]] (${job.title}) proposes to run \`${toolName}\`:\n\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\`\n\nSet \`approved: true\` and the daemon runs it once.${trustBody}`,
          call: { tool: toolName, args, idempotency_key: key, job: jobId, role: roleId },
        }, roleId);
        const text = `proposed: ${toolName} was filed as proposal ${id} for the owner; it runs after approval. Continue with the rest of the job.`;
        record({ step, kind: 'tool', tool: toolName, args, result: text, ok: true });
        updateJob(vault, jobId, { checkpoint_step: step }, roleId, `- step ${step}: ${toolName} → proposal ${id}`);
        continue;
      }
      // auto (or propose on a non-outbound tool, which handles its own proposal logic)
      if (policy.outbound) {
        // At-most-once: the key and the step are committed to the note BEFORE the external call.
        updateJob(vault, jobId, { checkpoint_step: step, side_effects_done: [...job.side_effects_done, key] }, roleId, `- step ${step}: ${toolName} ATTEMPTING (${key})`);
        refresh();
      }
      const res: ToolResult = await client.call(toolName, args, { idempotencyKey: key });
      // finish(blocked) parks the job in the brief's "needs you" list until the owner edits its status. Live runs
      // (2026-09-03 → 09-10) showed models reaching for it after a refused tool call ("cto may not schedule cto",
      // "Cannot schedule self") — nothing the owner can decide unblocks that, so the job just rots. Push back once
      // with what blocked actually means; a second finish(blocked) is taken at its word.
      if (res.finished && !blockedPushedBack && (res.data as { status?: string } | undefined)?.status === 'blocked') {
        blockedPushedBack = true;
        const text = 'finish(blocked) refused: "blocked" means the job waits on the owner for something only they can give (a key, an approval, a decision), and nothing here does. A refused tool call or a colleague who has not answered is not an owner decision. Do the work another way (hand off to a teammate, proceed on a stated assumption), or finish with status failed and say why. If you truly need the owner, call finish(blocked) again and name exactly what you need in blockers.';
        record({ step, kind: 'tool', tool: toolName, args, result: text, ok: false });
        events.emit({ type: 'agent.tool_result', agent: roleId, job: jobId, payload: { tool: toolName, ok: false, step, summary: text.slice(0, 200) } });
        updateJob(vault, jobId, { checkpoint_step: step }, roleId, `- step ${step}: finish(blocked) pushed back once (nothing waits on the owner)`);
        refresh();
        continue;
      }
      const sideEffects = !policy.outbound && res.sideEffectKey ? [...job.side_effects_done, res.sideEffectKey] : job.side_effects_done;
      record({ step, kind: 'tool', tool: toolName, args, result: res.text, ok: res.ok });
      events.emit({ type: 'agent.tool_result', agent: roleId, job: jobId, payload: { tool: toolName, ok: res.ok, step, summary: res.text.slice(0, 200) } });
      const patch: Partial<JobFrontmatter> = { checkpoint_step: step, side_effects_done: sideEffects };
      if (res.block) patch.status = 'blocked', patch.blocked_on = { ...res.block, since: nowIso() };
      updateJob(vault, jobId, patch, roleId, `- step ${step}: ${toolName}(${summarizeArgs(args)}) → ${res.ok ? 'ok' : 'FAILED'}${res.block ? ` [blocked on ${res.block.kind} ${res.block.id}]` : ''}`);
      refresh();
      if (res.finished) {
        const parsed = JobResult.safeParse(res.data);
        const result = parsed.success ? parsed.data : JobResult.parse({ status: 'done', summary: res.text });
        // The refusal repeats on every attempt to finish rather than being pushed back once, because unlike
        // finish(blocked) there is a concrete action that clears it — run CI, or file the threat model — and the
        // step budget already bounds the loop.
        const refusal = shipRefusal(vault, job, result);
        if (refusal) {
          record({ step, kind: 'tool', tool: toolName, args, result: `finish refused: ${refusal}`, ok: false });
          // "every refused call, never silent" (docs/events.md's contract for guardrail.blocked): a ship
          // refusal is exactly that, so it is announced the same way the `never`-mode and vetoed-approval
          // refusals above are, not just recorded into the job's own transcript.
          events.emit({ type: 'guardrail.blocked', agent: roleId, job: jobId, payload: { tool: toolName, reason: refusal, step } });
          events.emit({ type: 'agent.tool_result', agent: roleId, job: jobId, payload: { tool: toolName, ok: false, step, summary: refusal.slice(0, 200) } });
          updateJob(vault, jobId, { checkpoint_step: step }, roleId, `- step ${step}: finish refused (${refusal.slice(0, 120)})`);
          refresh();
          continue;
        }
        return finishWith(result, step);
      }
      if (res.block) {
        events.emit({ type: 'job.blocked', agent: roleId, job: jobId, payload: { reason: res.block.kind, id: res.block.id } });
        await client.close();
        return { status: 'blocked', on: res.block };
      }
    }
  }
  return failStepLimit(step);
}

/** Convenience scheduler backed by the vault (the daemon supplies a richer one). */
export function vaultScheduler(vault: Vault, by = 'daemon'): SchedulerApi {
  return {
    enqueue: (j) => createJob(vault, j, by),
    reprioritize: (id, priority) => { updateJob(vault, id, { priority }, by); },
  };
}

export { type InboxFrontmatter, type ToolsConfig };
