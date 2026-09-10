import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, RoleFrontmatter, listInbox } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools, type ToolContext } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault; let reg: ToolRegistry;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-guards-')); vault = (await scaffoldVault(dir)).vault; reg = new ToolRegistry().registerAll(phase3Tools({ includeMock: true })); });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });
const role = (id: string) => RoleFrontmatter.parse(vault.readNoteOrNull(`Roles/${id}.md`)!.data);
const ctx = (roleId: string, jobId: string | null = 'job_t'): ToolContext => ({ vault, events: vault.events, roleId, role: role(roleId), jobId, config: cfg, env: {}, workspace: '.cubicle/workspace/job_t', now: () => new Date(), scheduler: { enqueue: (j) => createJob(vault, j, roleId) } });
const call = (tool: string, roleId: string, args: Record<string, unknown>) => reg.get(tool)!.handler(args as never, ctx(roleId));

describe('scheduler.request through the org (spec §2)', () => {
  it('a lead schedules a member with done_when and the job carries team and owner_role', async () => {
    const r = await call('scheduler.request', 'cto', { type: 'engineer.ship', title: 'Build', assigned: 'engineer', goal: 'g', done_when: 'it builds' });
    expect(r.ok).toBe(true);
    const j = readJob(vault, (r.data as { id: string }).id)!.data;
    expect(j).toMatchObject({ team: 'engineering', owner_role: 'cto', done_when: 'it builds' });
  });
  it('a lead without done_when is refused; a lead outside its team is refused; a member may only hand off to a teammate', async () => {
    expect((await call('scheduler.request', 'cto', { type: 'engineer.ship', title: 'B', assigned: 'engineer', goal: 'g' })).ok).toBe(false);
    expect((await call('scheduler.request', 'cto', { title: 'B', assigned: 'head_of_growth', goal: 'g', done_when: 'x' })).text).toMatch(/may not schedule/);
    expect((await call('scheduler.request', 'engineer', { title: 'B', assigned: 'qa', goal: 'g' })).ok).toBe(true);
    expect((await call('scheduler.request', 'engineer', { title: 'B', assigned: 'head_of_growth', goal: 'g' })).ok).toBe(false);
    const m = await call('scheduler.request', 'engineer', { title: 'B', assigned: 'qa', goal: 'g' });
    expect(readJob(vault, (m.data as { id: string }).id)!.data.owner_role).toBe('cto'); // a member's handoff is owned by its lead
  });
  it('cto.plan is reserved for the daemon (via ceo), not schedulable through the tool', async () => {
    expect((await call('scheduler.request', 'cto', { type: 'cto.plan', title: 'x', assigned: 'engineer', goal: 'g', done_when: 'd' })).ok).toBe(false);
  });
  it('research goes through research_request and lands on the analyst with `for`', async () => {
    const ok = await call('scheduler.request', 'head_of_growth', { type: 'research', title: 'Channels', assigned: 'research_analyst', goal: 'g', done_when: 'report', for: 'head_of_growth' });
    expect(ok.ok).toBe(true); expect(readJob(vault, (ok.data as { id: string }).id)!.data.for).toBe('head_of_growth');
    expect((await call('scheduler.request', 'engineer', { type: 'research', title: 'X', assigned: 'research_analyst', goal: 'g' })).ok).toBe(false);
  });
  it('`for` naming a team id (or any non-role string) instead of an active role is refused (F1)', async () => {
    const r = await call('scheduler.request', 'head_of_growth', { type: 'research', title: 'Channels', assigned: 'research_analyst', goal: 'g', done_when: 'report', for: 'engineering' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/for must be an active role id/);
  });
  it('reprioritize is scoped to the caller\'s team unless CEO', async () => {
    const g = createJob(vault, { type: 'growth.post', title: 'p', assigned: 'head_of_growth', goal: 'g', team: 'growth' }, 'ceo');
    expect((await call('scheduler.request', 'cto', { title: '-', assigned: 'engineer', goal: '-', reprioritize: { job: g, priority: 1 } })).ok).toBe(false);
    expect((await call('scheduler.request', 'ceo', { title: '-', assigned: 'engineer', goal: '-', reprioritize: { job: g, priority: 1 } })).ok).toBe(true);
  });
});

describe('proposal.create, meeting.open, colleague.message, finish', () => {
  it('reorg is CEO-only and needs a fenced yaml teams block; hire/fire go through the resolver', async () => {
    const body = '## Proposed content\n\n```yaml\nteams:\n  engineering: { lead: cto, members: [tech_lead, engineer, qa, devops] }\n```\n';
    expect((await call('proposal.create', 'cto', { kind: 'reorg', title: 'Move devops', body })).ok).toBe(false);
    expect((await call('proposal.create', 'ceo', { kind: 'reorg', title: 'Move devops', body: 'no yaml here' })).ok).toBe(false);
    expect((await call('proposal.create', 'ceo', { kind: 'reorg', title: 'Move devops', body })).ok).toBe(true);
    expect(listInbox(vault).some((n) => n.data.kind === 'reorg')).toBe(true);
    expect((await call('proposal.create', 'cto', { kind: 'fire', title: 'x', body: 'role: qa', target: 'Roles/qa.md' })).text).toMatch(/may not/);
  });
  it('meeting.open requires the meeting permission; handoff only to a teammate; finish takes a verdict', async () => {
    expect((await call('meeting.open', 'engineer', { participants: ['qa'], agenda: 'a' })).text).toMatch(/may not open meetings/);
    const spokeBefore = vault.events.count('agent.spoke');
    expect((await call('colleague.message', 'engineer', { to: 'head_of_growth', kind: 'handoff', body: 'take this' })).ok).toBe(false);
    expect(vault.readTextOrNull('Messages/head_of_growth.md') ?? '').not.toContain('take this'); // refused handoff has no side effect
    expect(vault.events.count('agent.spoke')).toBe(spokeBefore);
    expect((await call('colleague.message', 'engineer', { to: 'qa', kind: 'handoff', body: 'take this' })).ok).toBe(true);
    const f = await call('finish', 'qa', { status: 'done', summary: 's', verdict: 'return', findings: ['no tests'] });
    expect((f.data as { verdict: string; findings: string[] })).toMatchObject({ verdict: 'return', findings: ['no tests'] });
  });
});

describe('scheduler.request refusals tell the caller what it may do instead', () => {
  it('a lead scheduling outside its team is told who it may schedule', async () => {
    const r = await call('scheduler.request', 'cto', { type: 'growth.outreach', title: 'B', assigned: 'cto', goal: 'g', done_when: 'x' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/may not schedule cto/);
    expect(r.text).toMatch(/tech_lead, engineer, qa/);
    expect(r.text).toMatch(/yourself/i);
  });
  it('a lead whose team has no members is told there is nobody to schedule and what to do instead', async () => {
    const r = await call('scheduler.request', 'head_of_growth', { type: 'engineer.ship', title: 'B', assigned: 'engineer', goal: 'g', done_when: 'x' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/growth has no members/);
    expect(r.text).toMatch(/do the work in this job/i);
    expect(r.text).toMatch(/research_analyst/);
  });
});
