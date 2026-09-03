import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, listJobs } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { runJob, vaultScheduler, type Llm } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-gates-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });
const finishing = (args: Record<string, unknown>): Llm => ({ async chat(_r: RouteRequest, _c: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> { return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [{ name: 'finish', args }] }; }, promptBudget: () => 6000 });
const deps = (llm: Llm) => ({ vault, llm, toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })), scheduler: vaultScheduler(vault), env: {} });

describe('review gates (spec §3)', () => {
  it('engineer.ship → in_review with a qa.review job; pass → coo.verify; pass → done', async () => {
    const id = createJob(vault, { type: 'engineer.ship', title: 'Build', assigned: 'engineer', goal: 'g', team: 'engineering', owner_role: 'cto' }, 'cto');
    await runJob(deps(finishing({ status: 'done', summary: 'built' })), id);
    expect(readJob(vault, id)!.data.status).toBe('in_review');
    const qa = listJobs(vault).find((j) => j.type === 'qa.review')!;
    expect(qa).toMatchObject({ assigned: 'qa', parent: id, team: 'engineering', owner_role: 'cto' });
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
    const id = createJob(vault, { type: 'engineer.ship', title: 'Build', assigned: 'engineer', goal: 'g', team: 'engineering', owner_role: 'cto' }, 'cto');
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
  it('research goes to the requester; ungated types finish directly; blocked/failed skip gates', async () => {
    const r = createJob(vault, { type: 'research', title: 'R', assigned: 'research_analyst', goal: 'g', for: 'head_of_growth', owner_role: 'head_of_growth' }, 'head_of_growth');
    await runJob(deps(finishing({ status: 'done', summary: 'report' })), r);
    expect(listJobs(vault).find((j) => j.type === 'requester.review')!.assigned).toBe('head_of_growth');
    const t = createJob(vault, { type: 'team.plan', title: 'P', assigned: 'cto', goal: 'g' }, 'ceo');
    await runJob(deps(finishing({ status: 'done', summary: 'planned' })), t);
    expect(readJob(vault, t)!.data.status).toBe('done');
    const f = createJob(vault, { type: 'engineer.ship', title: 'F', assigned: 'engineer', goal: 'g' }, 'cto');
    await runJob(deps(finishing({ status: 'failed', summary: 'no' })), f);
    expect(readJob(vault, f)!.data.status).toBe('failed'); expect(listJobs(vault).some((j) => j.parent === f)).toBe(false);
  });
  it('a failed gate job returns the parent (not stranded); a second gate failure fails the parent', async () => {
    const id = createJob(vault, { type: 'engineer.ship', title: 'Build', assigned: 'engineer', goal: 'g', team: 'engineering', owner_role: 'cto' }, 'cto');
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
    const id = createJob(vault, { type: 'engineer.ship', title: 'Build', assigned: 'engineer', goal: 'g', team: 'engineering', owner_role: 'cto' }, 'cto');
    // Deactivate QA's charter directly (still a Teams/engineering.md member, unlike a fire) so the qa.review
    // gate about to be enqueued names a role with no active worker.
    vault.updateNote('Roles/qa.md', (n) => ({ data: { ...n.data, active: false }, body: n.body }), 'daemon');
    await runJob(deps(finishing({ status: 'done', summary: 'built' })), id);
    const qa = listJobs(vault).find((j) => j.type === 'qa.review')!;
    expect(qa.assigned).toBe('cto'); // qa's lead
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => /qa\.review/.test(String(e.payload.message)) && /cto/.test(String(e.payload.message)))).toBe(true);
  });
});
