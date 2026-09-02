import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type Vault, type EventLog, type JobFrontmatter, type RoleFrontmatter, JobResult, InboxFrontmatter,
  readJob, updateJob, setSection, createProposal, findInboxById, nowIso, parseNote, RoleFrontmatter as RoleSchema, createJob,
} from '@cubicle/core';
import { NoModelAvailableError, type RoutedChatResult, type RouteRequest, type ChatMessage } from '@cubicle/router';
import type { ToolSchema } from '@cubicle/router';
import {
  ToolRegistry, createRoleToolClient, resolveMode, policyFor, proposalKindFor, findAnswer,
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
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Observation]; } catch { return []; } });
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
    vault, events, roleId, role, jobId, config: deps.toolsConfig, env, scheduler: deps.scheduler, memory: memoryApi,
    workspace: `.cubicle/workspace/${jobId}`, now,
  };
  const defs = deps.registry.forRole(role, deps.toolsConfig);
  const client = await createRoleToolClient(defs, baseCtx);
  const prefs = vault.ownerPreferences();

  const observations = loadObservations(vault, jobId);
  const record = (o: Omit<Observation, 'ts'>) => { const full = { ...o, ts: nowIso() }; observations.push(full); appendObservation(vault, jobId, full); };
  const refresh = () => { jobNote = readJob(vault, jobId)!; job = jobNote.data; return job; };
  const cancelled = () => refresh().status === 'cancelled';

  const finishWith = async (result: JobResult, step: number): Promise<JobOutcome> => {
    const body = setSection(jobNote!.body, '## Result', '```json\n' + JSON.stringify(result, null, 2) + '\n```');
    vault.updateNote(`Jobs/${jobId}.md`, (n) => ({ data: { ...n.data, status: result.status === 'done' ? 'done' : result.status === 'blocked' ? 'blocked' : 'failed', checkpoint_step: step, updated: nowIso() }, body }), roleId, { job: jobId });
    events.emit({ type: result.status === 'done' ? 'job.done' : result.status === 'blocked' ? 'job.blocked' : 'job.failed', agent: roleId, job: jobId, payload: { status: result.status, summary: result.summary, artifacts: result.artifacts, blockers: result.blockers, metrics: result.metrics, lessons: result.lessons } });
    if (!noVerify.includes(job.type) && result.status !== 'blocked') {
      deps.scheduler.enqueue({ type: 'coo.verify', title: `Verify: ${job.title}`, assigned: 'coo', goal: `Verify job [[${jobId}]] (${job.type}) against its goal. Read its Result block and artifacts, confirm with evidence, append one lesson to Memory/lessons.md, then finish.`, priority: 4, parent: jobId, links: [`[[${jobId}]]`], privacy: job.privacy });
    }
    await client.close();
    return { status: result.status === 'done' ? 'done' : result.status === 'blocked' ? 'blocked' : 'failed', result } as JobOutcome;
  };

  const failStepLimit = async (step: number): Promise<JobOutcome> => {
    if (job.attempt < job.max_attempts) {
      updateJob(vault, jobId, { status: 'queued', attempt: job.attempt + 1, checkpoint_step: 0 }, roleId, `- ${nowIso()}: step limit ${maxSteps} reached at step ${step}; requeued as attempt ${job.attempt + 1}`);
      events.emit({ type: 'job.failed', agent: roleId, job: jobId, payload: { reason: 'step_limit', requeued: true, attempt: job.attempt + 1 } });
      await client.close();
      return { status: 'requeued', attempt: job.attempt + 1 };
    }
    return finishWith(JobResult.parse({ status: 'failed', summary: `Step limit (${maxSteps}) reached without finishing.`, blockers: ['step limit'] }), step);
  };

  // ---- resume handling: pending proposal or answered question ----
  if (job.status === 'blocked' && job.blocked_on) {
    const b = job.blocked_on;
    if (b.kind === 'proposal') {
      const prop = findInboxById(vault, b.id);
      const call = prop?.data.call;
      if (prop && prop.data.approved === true && call) {
        const step = job.checkpoint_step; // the pending call owns this step
        const key = call.idempotency_key;
        if (job.side_effects_done.includes(key)) {
          record({ step, kind: 'tool', tool: call.tool, args: call.args, result: 'already executed before the interruption (idempotency key recorded)', ok: true });
        } else {
          const res = await client.call(call.tool, call.args, { idempotencyKey: key });
          const sideEffects = [...job.side_effects_done, key];
          updateJob(vault, jobId, { side_effects_done: sideEffects }, roleId, `- step ${step}: ${call.tool} executed after owner approval → ${res.ok ? 'ok' : 'failed'}`);
          record({ step, kind: 'tool', tool: call.tool, args: call.args, result: `(approved by owner) ${res.text}`, ok: res.ok });
          events.emit({ type: 'agent.tool_result', agent: roleId, job: jobId, payload: { tool: call.tool, ok: res.ok, step, approved: true } });
        }
        updateJob(vault, jobId, { status: 'running', approval: 'approved', blocked_on: undefined }, roleId);
      } else if (prop && prop.data.approved === false) {
        record({ step: job.checkpoint_step, kind: 'tool', tool: call?.tool ?? 'unknown', args: call?.args ?? {}, result: 'rejected by owner. Do not retry this action; adapt or finish.', ok: false });
        updateJob(vault, jobId, { status: 'running', approval: 'rejected', blocked_on: undefined }, roleId, `- step ${job.checkpoint_step}: ${call?.tool ?? 'call'} rejected by owner`);
      } else {
        await client.close();
        return { status: 'blocked', on: b };
      }
    } else if (b.kind === 'message') {
      const answer = findAnswer(vault, roleId, b.id) ?? (() => {
        const n = findInboxById(vault, b.id);
        return n && n.data.answered ? { from: 'owner', body: (n.body.split('## Owner')[1] ?? n.body).trim() } : null;
      })();
      if (!answer) { await client.close(); return { status: 'blocked', on: b }; }
      record({ step: job.checkpoint_step, kind: 'system', text: `Answer from ${answer.from} to your question ${b.id}:\n${answer.body}` });
      updateJob(vault, jobId, { status: 'running', blocked_on: undefined }, roleId, `- ${nowIso()}: question ${b.id} answered by ${answer.from}`);
    } else if (b.kind === 'job') {
      const sub = readJob(vault, b.id);
      if (!sub || !['done', 'failed', 'cancelled'].includes(sub.data.status)) { await client.close(); return { status: 'blocked', on: b }; }
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

  while (step < maxSteps) {
    if (cancelled()) { events.emit({ type: 'job.cancelled', agent: roleId, job: jobId, payload: { at_step: step } }); await client.close(); return { status: 'cancelled' }; }
    const messages = await assembleContext({
      vault, role, roleBody, job, jobBody: jobNote.body, observations, memory: deps.memory, maxPromptTokens: promptBudget,
      ownerEdits: events.query({ types: ['owner.edited'], from: ownerEditsSince }), summarize: deps.summarize,
      extraSystem: noToolStreak >= 2 ? 'You have replied twice without calling a tool. You MUST call a tool now, or call `finish`.' : undefined,
    });
    events.emit({ type: 'agent.thinking', agent: roleId, job: jobId, payload: { step } });
    let reply: RoutedChatResult;
    try {
      reply = await deps.llm.chat(routeReq, { messages, tools: toolSchemas, maxTokens: 1500 });
    } catch (err) {
      if (!(err instanceof NoModelAvailableError)) { await client.close().catch(() => undefined); throw err; }
      const msg = (err as Error).message;
      updateJob(vault, jobId, { status: 'blocked', blocked_on: { kind: 'quota', id: 'all-providers', since: nowIso() } }, roleId, `- ${nowIso()}: no model available (${msg.slice(0, 120)}); blocked on quota`);
      events.emit({ type: 'job.blocked', agent: roleId, job: jobId, payload: { reason: 'quota', message: msg.slice(0, 200) } });
      await client.close();
      return { status: 'blocked', on: { kind: 'quota', id: 'all-providers' } };
    }
    if (reply.jsonParseError) {
      jsonRetries++;
      record({ step, kind: 'system', text: `Your reply was not a single JSON object (${reply.jsonParseError}). Reply again with exactly one JSON object: {"tool": ..., "args": {...}} or {"final": "..."}.` });
      if (jsonRetries >= 3) return finishWith(JobResult.parse({ status: 'failed', summary: 'Model could not produce a valid tool call after 3 attempts.', blockers: ['invalid tool JSON'] }), step);
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
      if (noToolStreak >= 4) return finishWith(JobResult.parse({ status: 'failed', summary: `Model stopped calling tools. Last reply: ${reply.content.slice(0, 300)}`, blockers: ['no tool calls'] }), step);
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
      const mode = blockedReason ? 'never' : resolveMode(toolName, deps.toolsConfig, role, prefs);
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
      const res: ToolResult = await client.call(toolName, args, { idempotencyKey: key });
      const sideEffects = policy.outbound || res.sideEffectKey ? [...job.side_effects_done, res.sideEffectKey ?? key] : job.side_effects_done;
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
