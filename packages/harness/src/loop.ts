import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import {
  type Vault, type EventLog, type JobFrontmatter, type RoleFrontmatter, JobResult, InboxFrontmatter,
  readJob, updateJob, setSection, createProposal, findInboxById, nowIso, parseNote, RoleFrontmatter as RoleSchema, createJob,
} from '@cubicle/core';
import { NoModelAvailableError, type RoutedChatResult, type RouteRequest, type ChatMessage } from '@cubicle/router';
import type { ToolSchema } from '@cubicle/router';
import {
  ToolRegistry, createRoleToolClient, resolveMode, policyFor, proposalKindFor, findAnswer, unreadMessages, renderMessages,
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
  /** Job types that never get a coo.verify follow-up. */
  noVerifyTypes?: string[];
  maxSteps?: number;
  localMaxSteps?: number;
  /** Owner feedback lines addressed to a role (inline %%cubicle: …%% comments, preferences feedback, decision ratings). */
  ownerFeedback?: (roleId: string) => string[];
}

export type JobOutcome =
  | { status: 'done' | 'failed'; result?: JobResult }
  | { status: 'blocked'; on: { kind: string; id: string } }
  | { status: 'cancelled' }
  | { status: 'requeued'; attempt: number };

const DEFAULT_MAX_STEPS = 40;
const DEFAULT_LOCAL_MAX_STEPS = 15;
const NO_VERIFY = ['coo.verify', 'ceo.heartbeat', 'cto.plan'];

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

function appendObservation(vault: Vault, jobId: string, o: Observation): void {
  const p = observationsPath(vault, jobId);
  mkdirSync(path.dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(o) + '\n');
}

export function idempotencyKey(job: JobFrontmatter, step: number): string {
  return `${job.id}:${job.attempt}:${step}`;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
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
  const noVerify = deps.noVerifyTypes ?? NO_VERIFY;

  let jobNote = readJob(vault, jobId);
  if (!jobNote) throw new Error(`job not found: ${jobId}`);
  let job = jobNote.data;
  if (job.status === 'cancelled') return { status: 'cancelled' };
  if (job.status === 'done') return { status: 'done' };
  if (job.status === 'failed') return { status: 'failed' };
  if (job.status === 'blocked' && (!job.blocked_on || job.blocked_on.kind === 'owner') && job.approval !== 'pending') return { status: 'blocked', on: job.blocked_on ?? { kind: 'owner', id: jobId } };

  const roleNote = vault.readNoteOrNull(`Roles/${job.assigned}.md`);
  if (!roleNote) { updateJob(vault, jobId, { status: 'failed' }, 'daemon', `- ${nowIso()}: no charter for role ${job.assigned}`); return { status: 'failed' }; }
  const role = RoleSchema.parse(roleNote.data);
  const roleBody = roleNote.body;
  const roleId = role.role;

  const constitution = vault.constitution();
  const privacy: 'cloud' | 'local' = constitution.pii_local_only && (job.type === 'growth.outreach' || /Customers\//.test(jobNote.body) || role.tools.some((t) => t.startsWith('email.'))) ? 'local' : job.privacy;
  const routeReq: RouteRequest = { tier: role.model_tier, needsTools: true, privacy, roleId };
  const maxSteps = privacy === 'local' || role.model_tier === 'local' ? (deps.localMaxSteps ?? DEFAULT_LOCAL_MAX_STEPS) : (deps.maxSteps ?? DEFAULT_MAX_STEPS);
  const promptBudget = deps.llm.promptBudget?.(routeReq) ?? 6000;

  const memoryApi: MemoryApi | undefined = deps.memory ? { search: (q, k, dirs) => deps.memory!.search(q, k, dirs), indexFile: (rel) => deps.memory!.indexFile(rel).then(() => undefined) } : undefined;
  const baseCtx: ToolContext = {
    vault, events, roleId, role, jobId, config: deps.toolsConfig, env, scheduler: deps.scheduler, memory: memoryApi, router: deps.router,
    workspace: `.cubicle/workspace/${jobId}`, now,
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

  const finishWith = async (result: JobResult, step: number): Promise<JobOutcome> => {
    vault.updateNote(`Jobs/${jobId}.md`, (n) => ({
      data: { ...n.data, status: result.status === 'done' ? 'done' : result.status === 'blocked' ? 'blocked' : 'failed', checkpoint_step: step, updated: nowIso(), ...(result.status === 'blocked' ? { blocked_on: { kind: 'owner', id: jobId, since: nowIso() } } : {}) },
      body: setSection(n.body, '## Result', '```json\n' + JSON.stringify(result, null, 2) + '\n```'),
    }), roleId, { job: jobId });
    events.emit({ type: result.status === 'done' ? 'job.done' : result.status === 'blocked' ? 'job.blocked' : 'job.failed', agent: roleId, job: jobId, payload: { status: result.status, summary: result.summary, artifacts: result.artifacts, blockers: result.blockers, metrics: result.metrics, lessons: result.lessons } });
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
    const lessons = (result.lessons ?? []).map((l) => l.trim()).filter(Boolean);
    if (lessons.length) {
      const existing = vault.readTextOrNull('Memory/lessons.md') ?? '# Lessons\n';
      const lines = lessons.filter((l) => !existing.includes(`[[${jobId}]] ${l}`)).map((l) => `- [${nowIso().slice(0, 10)}] [[${jobId}]] ${l} (${roleId})`);
      if (lines.length) vault.appendText('Memory/lessons.md', lines.join('\n') + '\n', roleId, { job: jobId });
    }
    if (!noVerify.includes(job.type) && result.status !== 'blocked') {
      deps.scheduler.enqueue({ type: 'coo.verify', title: `Verify: ${job.title}`, assigned: 'coo', goal: `Verify job [[${jobId}]] (${job.type}) against its goal. Read its Result block and artifacts, confirm with evidence, append one lesson to Memory/lessons.md, then finish.`, priority: 4, parent: jobId, links: [`[[${jobId}]]`], privacy: job.privacy });
    }
    await client.close();
    return { status: result.status === 'done' ? 'done' : result.status === 'blocked' ? 'blocked' : 'failed', result } as JobOutcome;
  };

  /** Non-explicit failures (step limit, bad JSON, no tool calls) retry while attempts remain; explicit finish(failed) is final. */
  const failOrRequeue = async (step: number, reason: string, summary: string): Promise<JobOutcome> => {
    if (job.attempt < job.max_attempts) {
      archiveObservations(vault, jobId, job.attempt);
      updateJob(vault, jobId, { status: 'queued', attempt: job.attempt + 1, checkpoint_step: 0 }, roleId, `- ${nowIso()}: ${reason} at step ${step}; requeued as attempt ${job.attempt + 1}`);
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
      if (prop && prop.data.approved === true && call) {
        const step = job.checkpoint_step; // the pending call owns this step
        const key = call.idempotency_key;
        if (job.side_effects_done.includes(key)) {
          record({ step, kind: 'tool', tool: call.tool, args: call.args, result: 'already executed before the interruption (idempotency key recorded)', ok: true });
        } else {
          // At-most-once: record the key before the external call (a kill mid-call must not replay it).
          updateJob(vault, jobId, { side_effects_done: [...job.side_effects_done, key] }, roleId, `- step ${step}: ${call.tool} ATTEMPTING after owner approval (${key})`);
          const res = await client.call(call.tool, call.args, { idempotencyKey: key });
          updateJob(vault, jobId, {}, roleId, `- step ${step}: ${call.tool} → ${res.ok ? 'ok' : 'failed'}`);
          record({ step, kind: 'tool', tool: call.tool, args: call.args, result: `(approved by owner) ${res.text}`, ok: res.ok });
          events.emit({ type: 'agent.tool_result', agent: roleId, job: jobId, payload: { tool: call.tool, ok: res.ok, step, approved: true } });
        }
        updateJob(vault, jobId, { status: 'running', approval: 'approved', blocked_on: undefined }, roleId);
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
  let noToolStreak = 0;
  let jsonRetries = 0;

  let ownerEditCache: { at: number; list: ReturnType<typeof events.query> } | null = null;
  while (step < maxSteps) {
    if (cancelled()) { events.emit({ type: 'job.cancelled', agent: roleId, job: jobId, payload: { at_step: step } }); await client.close(); return { status: 'cancelled' }; }
    // Colleague messages are persisted into the transcript first, then marked read (survive kills and turns).
    const unread = unreadMessages(vault, roleId, false);
    if (unread.length) { record({ step, kind: 'system', text: `New messages for you:\n${renderMessages(unread)}` }); unreadMessages(vault, roleId, true); }
    if (!ownerEditCache || Date.now() - ownerEditCache.at > 30_000) ownerEditCache = { at: Date.now(), list: events.query({ types: ['owner.edited'], from: ownerEditsSince, limit: 200 }).slice(-50) };
    const feedback = deps.ownerFeedback?.(roleId) ?? [];
    const extraSystem = [
      feedback.length ? `# Owner feedback for you (act on it; it outranks your own plans)\n${feedback.slice(0, 20).join('\n')}` : '',
      noToolStreak >= 2 ? 'You have replied twice without calling a tool. You MUST call a tool now, or call `finish`.' : '',
    ].filter(Boolean).join('\n\n');
    const messages = await assembleContext({
      vault, role, roleBody, job, jobBody: jobNote.body, observations, memory: deps.memory, maxPromptTokens: promptBudget,
      ownerEdits: ownerEditCache.list, summarize: deps.summarize, maxSteps,
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
      // R17: tools marked first_time_only (deploy.site) need approval once; after a recorded completion they run automatically
      // unless the owner pinned a stricter mode in owner_preferences.
      if (mode === 'propose' && policy.first_time_only && !prefs.approvals[toolName] && events.count('deploy.done') > 0) mode = 'auto';
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
          body: `Job [[${jobId}]] (${job.title}) wants to call \`${toolName}\`:\n\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\`\n\nSet \`approved: true\` to run it, \`approved: false\` to refuse.`,
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
          body: `Job [[${jobId}]] (${job.title}) proposes to run \`${toolName}\`:\n\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\`\n\nSet \`approved: true\` and the daemon runs it once.`,
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
      const sideEffects = !policy.outbound && res.sideEffectKey ? [...job.side_effects_done, res.sideEffectKey] : job.side_effects_done;
      record({ step, kind: 'tool', tool: toolName, args, result: res.text, ok: res.ok });
      events.emit({ type: 'agent.tool_result', agent: roleId, job: jobId, payload: { tool: toolName, ok: res.ok, step, summary: res.text.slice(0, 200) } });
      const patch: Partial<JobFrontmatter> = { checkpoint_step: step, side_effects_done: sideEffects };
      if (res.block) patch.status = 'blocked', patch.blocked_on = { ...res.block, since: nowIso() };
      updateJob(vault, jobId, patch, roleId, `- step ${step}: ${toolName}(${summarizeArgs(args)}) → ${res.ok ? 'ok' : 'FAILED'}${res.block ? ` [blocked on ${res.block.kind} ${res.block.id}]` : ''}`);
      refresh();
      if (res.finished) {
        const parsed = JobResult.safeParse(res.data);
        return finishWith(parsed.success ? parsed.data : JobResult.parse({ status: 'done', summary: res.text }), step);
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
