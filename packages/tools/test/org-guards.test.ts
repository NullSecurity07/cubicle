import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, updateJob, createStream, RoleFrontmatter, listInbox, listJobs, loadOrg, GATE_JOB_TYPES } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, createRoleToolClient, phase3Tools, systemTypes, type ToolContext } from '../src/index.js';
// Relative, not a package dependency: @cubicle/daemon already depends on @cubicle/tools, so declaring the reverse
// in package.json would make `pnpm -r build` a cycle. This reaches into its source only to check the invariant below.
import { NON_WORK_TYPES } from '../../daemon/src/heartbeat.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault; let reg: ToolRegistry;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-guards-'));
  vault = (await scaffoldVault(dir)).vault;
  reg = new ToolRegistry().registerAll(phase3Tools({ includeMock: true }));
  // Ruling S-6: an engineering job with no stream is refused at the queue. These tests are about the org rules,
  // so the company has the one stream its work serves and `scheduler.request` defaults to it.
  createStream(vault, { name: 'Checkout', problem: 'p', customers: 'c', outcome_metric: 'm', owner_team: 'dev' }, 'product_manager');
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });
const role = (id: string) => RoleFrontmatter.parse(vault.readNoteOrNull(`Roles/${id}.md`)!.data);
const ctx = (roleId: string, jobId: string | null = 'job_t'): ToolContext => ({ vault, events: vault.events, roleId, role: role(roleId), jobId, config: cfg, env: {}, workspace: '.cubicle/workspace/job_t', now: () => new Date(), scheduler: { enqueue: (j) => createJob(vault, j, roleId) } });
const call = (tool: string, roleId: string, args: Record<string, unknown>) => reg.get(tool)!.handler(args as never, ctx(roleId));

describe('scheduler.request through the org (spec §2)', () => {
  it('a lead schedules a member with done_when and the job carries team and owner_role', async () => {
    const r = await call('scheduler.request', 'dev_manager', { type: 'engineer.ship', title: 'Build', assigned: 'backend_engineer', goal: 'g', done_when: 'it builds', risk: 'low' });
    expect(r.ok).toBe(true);
    const j = readJob(vault, (r.data as { id: string }).id)!.data;
    expect(j).toMatchObject({ team: 'dev', owner_role: 'dev_manager', done_when: 'it builds' });
  });
  it('a lead without done_when is refused; a lead outside its team is refused; a member may only hand off to a teammate', async () => {
    expect((await call('scheduler.request', 'dev_manager', { type: 'engineer.ship', title: 'B', assigned: 'backend_engineer', goal: 'g' })).ok).toBe(false);
    expect((await call('scheduler.request', 'dev_manager', { title: 'B', assigned: 'cmo', goal: 'g', done_when: 'x' })).text).toMatch(/may not schedule/);
    expect((await call('scheduler.request', 'backend_engineer', { title: 'B', assigned: 'frontend_engineer', goal: 'g' })).ok).toBe(true);
    expect((await call('scheduler.request', 'backend_engineer', { title: 'B', assigned: 'cmo', goal: 'g' })).ok).toBe(false);
    const m = await call('scheduler.request', 'backend_engineer', { title: 'B2', assigned: 'frontend_engineer', goal: 'g' }); // 'B' again would be a duplicate of the open job above
    expect(readJob(vault, (m.data as { id: string }).id)!.data.owner_role).toBe('dev_manager'); // a member's handoff is owned by its lead
  });
  it('cto.plan is reserved for the daemon (via ceo), not schedulable through the tool', async () => {
    expect((await call('scheduler.request', 'cto', { type: 'cto.plan', title: 'x', assigned: 'dev_manager', goal: 'g', done_when: 'd' })).ok).toBe(false);
  });
  it('the office and room gate types are reserved too, and so are the planning rounds', async () => {
    for (const type of ['team:qa.review', 'office:operations.verify', 'office:security.review', 'division.plan', 'board.premortem', 'requester.review']) {
      const r = await call('scheduler.request', 'dev_manager', { type, title: `sneak ${type}`, assigned: 'backend_engineer', goal: 'g', done_when: 'd' });
      expect(r.ok, type).toBe(false);
      expect(r.text, type).toMatch(/reserved for the daemon/);
    }
    // …and the offices that do run them are named by office, not by role id: the CTO may hand-queue a QA review.
    expect((await call('scheduler.request', 'cto', { type: 'team:qa.review', title: 'QA this', assigned: 'qa_lead', goal: 'g', done_when: 'd' })).ok).toBe(true);
  });
  it('the daemon\'s standing research sweeps are reserved too: nobody hand-queues intelligence or research.measure', async () => {
    for (const roleId of ['ceo', 'research_manager']) {   // both may schedule intelligence_analyst, so only the type can refuse them
      for (const type of ['intelligence', 'research.measure']) {
        const r = await call('scheduler.request', roleId, { type, title: `sweep ${roleId} ${type}`, assigned: 'intelligence_analyst', goal: 'g', done_when: 'd' });
        expect(r.ok, `${roleId} / ${type}`).toBe(false);
        expect(r.text).toMatch(/reserved for the daemon/);
      }
    }
  });
  const request = {
    decision: 'Ship the pricing page or keep the waitlist',
    decision_owner: 'cfo',
    question: 'Does a public price reduce signups?',
    hypothesis: 'A public price cuts signups by more than 20%',
    known_evidence: 'Two competitors publish prices',
    unknowns: 'Whether our visitors are price-sensitive',
    constraints: 'No paid tooling',
    deadline: '2026-09-25',
    required_confidence: 'medium',
    potential_decisions: ['Publish the price', 'Keep the waitlist'],
    portfolio: 'incremental',
    impact: 4, uncertainty: 4, cost_of_being_wrong: 4,
  };

  it('research goes through research_request, lands on the research lead with `for`, and carries the request', async () => {
    const ok = await call('scheduler.request', 'cfo', { type: 'research', title: 'Channels', assigned: 'research_manager', goal: 'g', done_when: 'report', for: 'cfo', research: request });
    expect(ok.ok).toBe(true);
    const j = readJob(vault, (ok.data as { id: string }).id)!;
    expect(j.data.for).toBe('cfo');
    expect(j.data.research).toMatchObject({ portfolio: 'incremental', required_confidence: 'medium' });
    expect(j.data.priority).toBe(1);                      // 4 x 4 x 4 = 64
    expect(j.body).toMatch(/## Research request/);
    expect((await call('scheduler.request', 'backend_engineer', { type: 'research', title: 'X', assigned: 'research_manager', goal: 'g', research: request })).ok).toBe(false);
  });

  it('an incomplete research request is refused by name, and nothing is queued', async () => {
    const before = listJobs(vault).length;
    const r = await call('scheduler.request', 'cfo', { type: 'research', title: 'Half a brief', assigned: 'research_manager', goal: 'g', done_when: 'report', for: 'cfo', research: { question: 'Is it worth it?' } });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Missing: decision, .*required_confidence/);
    expect(r.text).toMatch(/- decision: the decision this research informs/);
    expect(r.text).toMatch(/Nothing was queued/);
    expect(listJobs(vault).length).toBe(before);
    expect((await call('scheduler.request', 'cfo', { type: 'research', title: 'No brief', assigned: 'research_manager', goal: 'g', done_when: 'report', for: 'cfo' })).text).toMatch(/Missing: decision/);
  });

  it('`for` must name an active role: a report addressed to nobody is refused and nothing is queued', async () => {
    const before = listJobs(vault).length;
    const r = await call('scheduler.request', 'cfo', { type: 'research', title: 'For a ghost', assigned: 'research_manager', goal: 'g', done_when: 'report', for: 'chief_vibes_officer', research: request });
    expect(r.ok).toBe(false);
    expect(r.text).toBe('for must be an active role id');
    expect(listJobs(vault).length).toBe(before);
  });

  it('the decision owner defaults to `for` when the request omits it', async () => {
    const { decision_owner: _omitted, ...rest } = request;
    const ok = await call('scheduler.request', 'cto', { type: 'research', title: 'Runtime choice', assigned: 'research_manager', goal: 'g', done_when: 'report', for: 'cto', research: rest });
    expect(ok.ok).toBe(true);
    expect(readJob(vault, (ok.data as { id: string }).id)!.data.research!.decision_owner).toBe('cto');
  });
  it('reprioritize is scoped to the caller\'s team unless CEO', async () => {
    const g = createJob(vault, { type: 'growth.post', title: 'p', assigned: 'cmo', goal: 'g', team: 'revenue' }, 'ceo');
    expect((await call('scheduler.request', 'cto', { title: '-', assigned: 'dev_manager', goal: '-', reprioritize: { job: g, priority: 1 } })).ok).toBe(false);
    expect((await call('scheduler.request', 'ceo', { title: '-', assigned: 'dev_manager', goal: '-', reprioritize: { job: g, priority: 1 } })).ok).toBe(true);
  });
});

describe('proposal.create, meeting.open, colleague.message, finish', () => {
  it('reorg is CEO-only and needs a fenced yaml teams block; hire/fire go through the resolver', async () => {
    const body = '## Proposed content\n\n```yaml\nteams:\n  qa: { lead: qa_lead, members: [qa_automation, qa_exploratory, qa_performance, qa_release, devops] }\n```\n';
    expect((await call('proposal.create', 'cto', { kind: 'reorg', title: 'Move devops', body })).ok).toBe(false);
    expect((await call('proposal.create', 'ceo', { kind: 'reorg', title: 'Move devops', body: 'no yaml here' })).ok).toBe(false);
    expect((await call('proposal.create', 'ceo', { kind: 'reorg', title: 'Move devops', body })).ok).toBe(true);
    expect(listInbox(vault).some((n) => n.data.kind === 'reorg')).toBe(true);
    expect((await call('proposal.create', 'cto', { kind: 'fire', title: 'x', body: 'role: qa_lead', target: 'Roles/qa_lead.md' })).text).toMatch(/may not/);
  });
  it('meeting.open requires the meeting permission; handoff only to a teammate; finish takes a verdict', async () => {
    expect((await call('meeting.open', 'backend_engineer', { participants: ['frontend_engineer'], agenda: 'a' })).text).toMatch(/may not open meetings/);
    const spokeBefore = vault.events.count('agent.spoke');
    expect((await call('colleague.message', 'backend_engineer', { to: 'cmo', kind: 'handoff', body: 'take this' })).ok).toBe(false);
    expect(vault.readTextOrNull('Messages/cmo.md') ?? '').not.toContain('take this'); // refused handoff has no side effect
    expect(vault.events.count('agent.spoke')).toBe(spokeBefore);
    expect((await call('colleague.message', 'backend_engineer', { to: 'frontend_engineer', kind: 'handoff', body: 'take this' })).ok).toBe(true);
    const f = await call('finish', 'qa_lead', { status: 'done', summary: 's', verdict: 'return', findings: ['no tests'] });
    expect((f.data as { verdict: string; findings: string[] })).toMatchObject({ verdict: 'return', findings: ['no tests'] });
  });
  it('the two system-owned proposal kinds cannot be hand-written by an agent', async () => {
    // A hand-written plan_verdict would be read by the next heartbeat as a plan waiting for the owner's ruling,
    // and would hold the company's planning back until somebody noticed.
    for (const kind of ['outbound_batch', 'plan_verdict']) {
      const r = await call('proposal.create', 'ceo', { kind, title: 'x', body: 'y' });
      expect(r.ok, kind).toBe(false);
      expect(r.text).toMatch(/not directly|filed by the heartbeat/);
    }
    expect(listInbox(vault).some((n) => n.data.kind === 'plan_verdict' || n.data.kind === 'outbound_batch')).toBe(false);
  });
});

describe('tools and harness stop naming people (spec org engine)', () => {
  it('the reorg refusal names the chief-executive office, not a hard-coded CEO', async () => {
    const r = await call('proposal.create', 'cto', { kind: 'reorg', title: 'Move devops', body: '```yaml\nteams:\n  dev:\n    lead: dev_manager\n```' });
    expect(r.ok).toBe(false);
    expect(r.text).toBe('reorg proposals are filed by the chief executive (ceo)');
  });

  it('a division lead may schedule into the rooms under it, and a room member still may not cross rooms', async () => {
    expect((await call('scheduler.request', 'cto', { title: 'Ship the first cut', assigned: 'backend_engineer', goal: 'g', done_when: 'the page is live' })).ok).toBe(true);
    expect((await call('scheduler.request', 'cto', { title: 'Write the launch post', assigned: 'cmo', goal: 'g', done_when: 'x' })).ok).toBe(false);
    const r = await call('scheduler.request', 'backend_engineer', { title: 'Test it', assigned: 'qa_automation', goal: 'g' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('You may schedule:');
  });

  it('every gate job type and every heartbeat non-work type is reserved in systemTypes, per the comment on it', () => {
    const org = loadOrg(vault);
    const reserved = systemTypes(org);
    for (const type of [...GATE_JOB_TYPES, ...NON_WORK_TYPES]) expect(reserved, type).toHaveProperty(type);
  });

  // One gate, one access list (final review M3): the engineering office could hand-queue the pre-office
  // `security.review` but not the renamed `office:security.review` — a rename artefact, not a policy.
  it('a gate and its pre-office name grant the same offices', () => {
    const reserved = systemTypes(loadOrg(vault));
    for (const [renamed, old] of [['office:security.review', 'security.review'], ['office:operations.verify', 'coo.verify'], ['team:qa.review', 'qa.review']]) {
      expect([...reserved[renamed]].sort(), renamed).toEqual([...reserved[old]].sort());
    }
  });
});

describe('scheduler.request refusals tell the caller what it may do instead', () => {
  it('a lead scheduling outside its team is told who it may schedule', async () => {
    const r = await call('scheduler.request', 'cto', { type: 'growth.outreach', title: 'B', assigned: 'cto', goal: 'g', done_when: 'x' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/may not schedule cto/);
    // A lead now reaches its whole subtree (org.ts `can`): the CTO's list is the Dev and QA rooms under
    // Technology, not just their two leads.
    expect(r.text).toMatch(/dev_manager/);
    expect(r.text).toMatch(/qa_lead/);
    expect(r.text).toMatch(/backend_engineer/);
    expect(r.text).toMatch(/yourself/i);
  });
  it('a lead whose team has no members is told there is nobody to schedule and what to do instead', async () => {
    const r = await call('scheduler.request', 'ciso', { type: 'engineer.ship', title: 'B', assigned: 'backend_engineer', goal: 'g', done_when: 'x' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/security has no members/);
    expect(r.text).toMatch(/do the work in this job/i);
    expect(r.text).toMatch(/research_manager/);
  });
});

describe('live-run failures: team ids, duplicate titles, finish aliases', () => {
  it('scheduler.request naming a team id says it is a team, names the lead and members, and does not redirect', async () => {
    const r = await call('scheduler.request', 'ceo', { title: 'Plan Security', assigned: 'security', goal: 'g', done_when: 'x' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/security is a team, not a role/);
    expect(r.text).toMatch(/lead is ciso/);
    expect(r.text).toMatch(/members: \(none\)/);
    expect(r.text).toMatch(/Use a role id/);
    expect(readJob(vault, 'security')).toBeNull();
    const e = await call('scheduler.request', 'ceo', { title: 'Ship', assigned: 'dev', goal: 'g', done_when: 'x' });
    expect(e.text).toMatch(/dev is a team, not a role\. Its lead is dev_manager; members: product_manager, product_designer, backend_engineer, frontend_engineer, fullstack_engineer, platform_engineer, sre\. Use a role id/);
  });
  it('scheduler.request with an unknown role lists the active role ids', async () => {
    const r = await call('scheduler.request', 'ceo', { title: 'x', assigned: 'nobody', goal: 'g', done_when: 'x' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/unknown or inactive role: nobody/);
    expect(r.text).toMatch(/active roles: .*cmo.*/);
  });
  it('colleague.message to a team id is refused with the lead and members; unknown roles list the active ids', async () => {
    const r = await call('colleague.message', 'cto', { to: 'security', body: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/security is a team, not a role\. Its lead is ciso; members: \(none\)\. Use a role id/);
    expect(vault.readTextOrNull('Messages/security.md') ?? '').not.toContain('hi'); // refused: nothing delivered
    const u = await call('colleague.message', 'cto', { to: 'nobody', body: 'hi' });
    expect(u.ok).toBe(false);
    expect(u.text).toMatch(/unknown role: nobody.*active roles: .*cto/);
  });
  it('a second open job with the same assignee and (normalised) title is refused; closed jobs and system types are not', async () => {
    const first = await call('scheduler.request', 'dev_manager', { type: 'engineer.ship', title: 'Define Target Segments', assigned: 'backend_engineer', goal: 'g', done_when: 'x', risk: 'low' });
    expect(first.ok).toBe(true);
    const id = (first.data as { id: string }).id;
    const dup = await call('scheduler.request', 'dev_manager', { type: 'engineer.ship', title: '  define target   SEGMENTS ', assigned: 'backend_engineer', goal: 'other', done_when: 'x', risk: 'low' });
    expect(dup.ok).toBe(false);
    expect(dup.text).toBe(`a job with this title is already open for backend_engineer: ${id} (queued). Wait for it, or give the new job a different title if it really is different work`);
    // same title for someone else, or a different title, is fine
    expect((await call('scheduler.request', 'dev_manager', { type: 'engineer.ship', title: 'Define Target Segments', assigned: 'frontend_engineer', goal: 'g', done_when: 'x', risk: 'low' })).ok).toBe(true);
    expect((await call('scheduler.request', 'dev_manager', { type: 'engineer.ship', title: 'Define Target Segments v2', assigned: 'backend_engineer', goal: 'g', done_when: 'x', risk: 'low' })).ok).toBe(true);
    // once the first is closed the title is free again
    updateJob(vault, id, { status: 'done' }, 'dev_manager');
    expect((await call('scheduler.request', 'dev_manager', { type: 'engineer.ship', title: 'Define Target Segments', assigned: 'backend_engineer', goal: 'g', done_when: 'x', risk: 'low' })).ok).toBe(true);
    // daemon system types are exempt (the daemon schedules e.g. team.plan every cycle)
    expect((await call('scheduler.request', 'ceo', { type: 'team.plan', title: 'Plan Revenue', assigned: 'cfo', goal: 'g', done_when: 'x' })).ok).toBe(true);
    expect((await call('scheduler.request', 'ceo', { type: 'team.plan', title: 'Plan Revenue', assigned: 'cfo', goal: 'g', done_when: 'x' })).ok).toBe(true);
  });
  it('a replayed step (same idempotency key) returns the job it already queued instead of a duplicate refusal', async () => {
    const c = { ...ctx('dev_manager'), idempotencyKey: 'job_t:1:1' };
    const args = { type: 'engineer.ship', title: 'Replayed', assigned: 'backend_engineer', goal: 'g', done_when: 'x', risk: 'low' };
    const a = await reg.get('scheduler.request')!.handler(args as never, c);
    const b = await reg.get('scheduler.request')!.handler(args as never, c);
    expect(a.ok).toBe(true); expect(b.ok).toBe(true);
    expect((b.data as { id: string }).id).toBe((a.data as { id: string }).id);
  });
  it('finish accepts status return/pass as an alias for done + verdict', async () => {
    const ret = await call('finish', 'qa_lead', { status: 'return', summary: 's', findings: ['no tests'] });
    expect(ret.ok).toBe(true); expect(ret.finished).toBe(true);
    expect(ret.data).toMatchObject({ status: 'done', verdict: 'return', findings: ['no tests'] });
    const pass = await call('finish', 'qa_lead', { status: 'pass', summary: 's' });
    expect(pass.data).toMatchObject({ status: 'done', verdict: 'pass' });
    // an explicit verdict wins over the alias
    const explicit = await call('finish', 'qa_lead', { status: 'return', verdict: 'pass', summary: 's' });
    expect(explicit.data).toMatchObject({ status: 'done', verdict: 'pass' });
    expect((await call('finish', 'qa_lead', { status: 'done', summary: 's' })).data).not.toHaveProperty('verdict');
  });
  it('finish status alias round-trips through the MCP schema', async () => {
    const client = await createRoleToolClient(reg.forRole({ ...role('qa_lead'), tools: ['finish'] } as RoleFrontmatter, cfg), ctx('qa_lead'));
    try {
      const r = await client.call('finish', { status: 'return', summary: 's', findings: ['f'] });
      expect(r.ok).toBe(true);
      expect(r.data).toMatchObject({ status: 'done', verdict: 'return' });
    } finally { await client.close(); }
  });
});
