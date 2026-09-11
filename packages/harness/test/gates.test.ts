import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, listJobs, createStream, writeCiRecord } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { runJob, vaultScheduler, type Llm } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-gates-'));
  vault = (await scaffoldVault(dir)).vault;
  // An engineer.ship may not finish without a green CI record for its stream (§17), so every ship job below
  // names this stream and ships on this record.
  createStream(vault, { name: 'Checkout', problem: 'p', customers: 'c', outcome_metric: '72 % to 82 %', owner_team: 'dev' }, 'product_manager');
  writeCiRecord(vault, 'checkout', { stream: 'checkout', started: '2026-09-11T09:59:00.000Z', finished: '2026-09-11T10:00:00.000Z', green: true, commit: null, steps: [{ name: 'test', code: 0, ok: true, duration_ms: 5, output: 'ok' }] }, 'backend_engineer');
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });
const finishing = (args: Record<string, unknown>): Llm => ({ async chat(_r: RouteRequest, _c: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> { return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [{ name: 'finish', args }] }; }, promptBudget: () => 6000 });
const deps = (llm: Llm, extra: { maxSteps?: number } = {}) => ({ vault, llm, toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })), scheduler: vaultScheduler(vault), env: {}, ...extra });
/** Calls a harmless tool `n` times, then finishes. */
const stepsThenFinish = (n: number, args: Record<string, unknown>): Llm => {
  let i = 0;
  return {
    async chat(_r: RouteRequest, _c: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      const base = { content: '', toolCalls: [], finishReason: 'stop' as const, usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium' as const, downgraded: false };
      const call = i < n ? { name: 'vault.read', args: { path: 'Plans/plan.md' } } : { name: 'finish', args };
      i++;
      return { ...base, parsedToolCalls: [call] };
    },
    promptBudget: () => 6000,
  };
};

describe('review gates (spec §3)', () => {
  it('engineer.ship → in_review with a qa.review job; pass → coo.verify; pass → done', async () => {
    const id = createJob(vault, { type: 'engineer.ship', stream: 'checkout', title: 'Build', assigned: 'backend_engineer', goal: 'g', team: 'dev', owner_role: 'dev_manager' }, 'dev_manager');
    await runJob(deps(finishing({ status: 'done', summary: 'built' })), id);
    expect(readJob(vault, id)!.data.status).toBe('in_review');
    const qa = listJobs(vault).find((j) => j.type === 'qa.review')!;
    expect(qa).toMatchObject({ assigned: 'qa_lead', parent: id, team: 'dev', owner_role: 'dev_manager' });
    await runJob(deps(finishing({ status: 'done', summary: 'looks good', verdict: 'pass' })), qa.id);
    expect(readJob(vault, id)!.data.status).toBe('in_review');
    const coo = listJobs(vault).find((j) => j.type === 'coo.verify' && j.parent === id)!;
    expect(coo.assigned).toBe('coo');
    await runJob(deps(finishing({ status: 'done', summary: 'verified', verdict: 'pass', lessons: ['ok'] })), coo.id);
    expect(readJob(vault, id)!.data.status).toBe('done');
    expect(vault.events.count('review.passed')).toBe(2);
    expect(vault.events.query({ types: ['job.done'] }).some((e) => e.job === id)).toBe(true);
  });
  it('return sends the job back once with findings; a second return fails it', async () => {
    const id = createJob(vault, { type: 'engineer.ship', stream: 'checkout', title: 'Build', assigned: 'backend_engineer', goal: 'g', team: 'dev', owner_role: 'dev_manager' }, 'dev_manager');
    await runJob(deps(finishing({ status: 'done', summary: 'built' })), id);
    let qa = listJobs(vault).find((j) => j.type === 'qa.review')!;
    await runJob(deps(finishing({ status: 'done', summary: 'nope', verdict: 'return', findings: ['index.html has no title'] })), qa.id);
    const back = readJob(vault, id)!;
    expect(back.data.status).toBe('queued'); expect(back.data.attempt).toBe(2); expect(back.data.returns).toEqual({ 'qa.review': 1 });
    expect(back.body).toContain('## Review findings'); expect(back.body).toContain('index.html has no title');
    expect(vault.events.count('review.returned')).toBe(1);
    await runJob(deps(finishing({ status: 'done', summary: 'built again' })), id);
    qa = listJobs(vault).filter((j) => j.type === 'qa.review').sort((a, b) => a.created.localeCompare(b.created)).at(-1)!;
    await runJob(deps(finishing({ status: 'done', summary: 'still no', verdict: 'return', findings: ['still no title'] })), qa.id);
    expect(readJob(vault, id)!.data.status).toBe('failed');
  });
  it('research passes research.review before the requester; ungated types finish directly; blocked/failed skip gates', async () => {
    const r = createJob(vault, { type: 'research', title: 'R', assigned: 'researcher', goal: 'g', for: 'cfo', owner_role: 'cfo' }, 'cfo');
    await runJob(deps(finishing({ status: 'done', summary: 'report' })), r);
    const quality = listJobs(vault).find((j) => j.type === 'research.review')!;
    expect(quality.assigned).toBe('research_manager');
    // `goal` lives in the job note's body (under "## Goal"), not in frontmatter — this is the gate's own criteria
    // (§35: evidence sufficiency) appended to the goal enqueueGate hands the reviewer.
    expect(readJob(vault, quality.id)!.body).toMatch(/evidence sufficiency/i);
    expect(listJobs(vault).some((j) => j.type === 'requester.review')).toBe(false); // not yet: one gate at a time
    await runJob(deps(finishing({ status: 'done', summary: 'sound', verdict: 'pass' })), quality.id);
    expect(listJobs(vault).find((j) => j.type === 'requester.review')!.assigned).toBe('cfo');

    const t = createJob(vault, { type: 'team.plan', title: 'P', assigned: 'cto', goal: 'g' }, 'ceo');
    await runJob(deps(finishing({ status: 'done', summary: 'planned' })), t);
    expect(readJob(vault, t)!.data.status).toBe('done');
    const f = createJob(vault, { type: 'engineer.ship', stream: 'checkout', title: 'F', assigned: 'backend_engineer', goal: 'g' }, 'dev_manager');
    await runJob(deps(finishing({ status: 'failed', summary: 'no' })), f);
    expect(readJob(vault, f)!.data.status).toBe('failed'); expect(listJobs(vault).some((j) => j.parent === f)).toBe(false);
  });
  it('a failed gate job returns the parent (not stranded); a second gate failure fails the parent', async () => {
    const id = createJob(vault, { type: 'engineer.ship', stream: 'checkout', title: 'Build', assigned: 'backend_engineer', goal: 'g', team: 'dev', owner_role: 'dev_manager' }, 'dev_manager');
    await runJob(deps(finishing({ status: 'done', summary: 'built' })), id);
    let qa = listJobs(vault).find((j) => j.type === 'qa.review')!;
    await runJob(deps(finishing({ status: 'failed', summary: 'could not run the build', blockers: ['docker down'] })), qa.id);
    const back = readJob(vault, id)!;
    expect(back.data.status).toBe('queued'); expect(back.data.attempt).toBe(2); expect(back.data.returns).toEqual({ 'qa.review': 1 });
    expect(back.body).toContain('## Review findings'); expect(back.body).toContain('docker down');
    expect(vault.events.count('review.returned')).toBe(1);
    await runJob(deps(finishing({ status: 'done', summary: 'built again' })), id);
    qa = listJobs(vault).filter((j) => j.type === 'qa.review').sort((a, b) => a.created.localeCompare(b.created)).at(-1)!;
    await runJob(deps(finishing({ status: 'failed', summary: 'could not run the build again', blockers: ['docker down'] })), qa.id);
    expect(readJob(vault, id)!.data.status).toBe('failed');
  });
  it('a gate assignee with no active worker falls back to its lead, with a warning (F1)', async () => {
    const id = createJob(vault, { type: 'engineer.ship', stream: 'checkout', title: 'Build', assigned: 'backend_engineer', goal: 'g', team: 'dev', owner_role: 'dev_manager' }, 'dev_manager');
    // Deactivate the QA lead's charter directly (still a Teams/qa.md lead, unlike a fire) so the qa.review gate
    // about to be enqueued names a role with no active worker. `resolveRole` then leaves the gate's `qa` alone
    // (its alias qa_lead is gone too) and the QA room has no active lead left, so the fallback is the CEO.
    // Sub-project 2's escalation to the division lead will make this the CTO again.
    vault.updateNote('Roles/qa_lead.md', (n) => ({ data: { ...n.data, active: false }, body: n.body }), 'daemon');
    await runJob(deps(finishing({ status: 'done', summary: 'built' })), id);
    const qa = listJobs(vault).find((j) => j.type === 'qa.review')!;
    expect(qa.assigned).toBe('ceo'); // the qa room's only lead is gone
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => /qa\.review/.test(String(e.payload.message)) && /ceo/.test(String(e.payload.message)))).toBe(true);
  });
  it('a job returned at a high checkpoint step still gets a fresh maxSteps budget, not the remainder (F3)', async () => {
    const maxSteps = 5;
    const id = createJob(vault, { type: 'engineer.ship', stream: 'checkout', title: 'Build', assigned: 'backend_engineer', goal: 'g', team: 'dev', owner_role: 'dev_manager' }, 'dev_manager');
    await runJob(deps(finishing({ status: 'done', summary: 'built' }), { maxSteps }), id);
    const qa = listJobs(vault).find((j) => j.type === 'qa.review')!;
    // Simulate the job having already used most of its budget by the time it reached the gate.
    vault.updateNote(`Jobs/${id}.md`, (n) => ({ data: { ...n.data, checkpoint_step: maxSteps - 1 }, body: n.body }), 'daemon');
    await runJob(deps(finishing({ status: 'done', summary: 'nope', verdict: 'return', findings: ['needs work'] })), qa.id);
    const back = readJob(vault, id)!.data;
    expect(back.status).toBe('queued');
    expect(back.budget_from).toBe(maxSteps - 1);
    // Old (buggy) behaviour: while (step < maxSteps) with step already at maxSteps-1 allows only ONE more step
    // before step_limit. New behaviour: while (step < budget_from + maxSteps) allows a full fresh maxSteps.
    const resumed = await runJob(deps(stepsThenFinish(maxSteps - 1, { status: 'done', summary: 'built again' }), { maxSteps }), id);
    expect(resumed.status).not.toBe('failed');
    expect(readJob(vault, id)!.data.checkpoint_step).toBe((maxSteps - 1) + maxSteps);
  });
});
