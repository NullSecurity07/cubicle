import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, listInbox, listJobs, createJob, createProposal, findInboxById, updateJob } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler, type Llm } from '@cubicle/harness';
import { verdictOutcome, openPlanVerdict, planVerdictId, planVerdictBody, dispatchProposals, runHeartbeat, createHeartbeatJob, HEARTBEAT_STEPS } from '../src/index.js';

const root = path.resolve(__dirname, '../../..');
const toolsConfig = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-verdict-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const ownerEdit = (rel: string, f: (t: string) => string) => writeFileSync(path.join(dir, rel), f(readFileSync(path.join(dir, rel), 'utf8')));
const deps = () => ({ vault, registry: new ToolRegistry().registerAll(phase3Tools()), toolsConfig, scheduler: vaultScheduler(vault), env: {} });

describe('the owner rules on the plan (program design §4)', () => {
  it('an owner decision always wins', () => {
    const base = { created: hoursAgo(1), now: new Date(), boardVerdict: 'pass' as const, decidesAfterHours: 6 };
    expect(verdictOutcome({ ...base, approved: true })).toBe('approved');
    expect(verdictOutcome({ ...base, approved: false })).toBe('rejected');
  });

  it('with the switch off (the default) the plan waits for the owner however long that takes', () => {
    expect(verdictOutcome({ approved: null, created: hoursAgo(1), now: new Date(), boardVerdict: 'pass', decidesAfterHours: 0 })).toBe('pending');
    expect(verdictOutcome({ approved: null, created: hoursAgo(500), now: new Date(), boardVerdict: 'pass', decidesAfterHours: 0 })).toBe('pending');
    expect(verdictOutcome({ approved: null, created: hoursAgo(500), now: new Date(), boardVerdict: 'return', decidesAfterHours: 0 })).toBe('pending');
  });

  it('while the owner has not answered and the switch has not elapsed, the plan is pending', () => {
    expect(verdictOutcome({ approved: null, created: hoursAgo(1), now: new Date(), boardVerdict: 'pass', decidesAfterHours: 6 })).toBe('pending');
    expect(verdictOutcome({ approved: null, created: 'not a date', now: new Date(), boardVerdict: 'pass', decidesAfterHours: 6 })).toBe('pending');
  });

  it('once the owner has set a number of hours and they pass, the board\'s own verdict stands', () => {
    expect(verdictOutcome({ approved: null, created: hoursAgo(7), now: new Date(), boardVerdict: 'pass', decidesAfterHours: 6 })).toBe('approved');
    expect(verdictOutcome({ approved: null, created: hoursAgo(7), now: new Date(), boardVerdict: 'return', decidesAfterHours: 6 })).toBe('rejected');
    expect(verdictOutcome({ approved: null, created: hoursAgo(1), now: new Date(), boardVerdict: 'pass', decidesAfterHours: 0.5 })).toBe('approved');
  });

  it('a plan_verdict stays open until it is fanned out, and a rejected one closes at once', () => {
    expect(openPlanVerdict(vault)).toBeNull();
    const { id, path: rel } = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'Approve this cycle\'s plan', body: 'x' }, 'ceo');
    expect(openPlanVerdict(vault)?.data.id).toBe(id);
    // The owner approves and the dispatcher resolves the note: it is still open, because no division has planned
    // against this plan yet — that is what keeps the next heartbeat from writing a new plan over it.
    vault.updateNote(rel, (n) => ({ data: { ...n.data, approved: true, resolved_at: new Date().toISOString() }, body: n.body }), 'daemon');
    expect(openPlanVerdict(vault)?.data.id).toBe(id);
    vault.updateNote(rel, (n) => ({ data: { ...n.data, fanned_out: 'job_hb1' }, body: n.body }), 'daemon');
    expect(openPlanVerdict(vault)).toBeNull();
    // A rejection closes immediately: the CEO rewrites the plan next cycle.
    const second = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'Approve the rewrite', body: 'y' }, 'ceo');
    vault.updateNote(second.path, (n) => ({ data: { ...n.data, approved: false }, body: n.body }), 'owner');
    expect(openPlanVerdict(vault)).toBeNull();
    expect(listInbox(vault).filter((n) => n.data.kind === 'plan_verdict')).toHaveLength(2);
  });

  it('the note the owner reads carries the board\'s verdict, its findings and the plan itself', () => {
    const body = planVerdictBody({
      board: 'return',
      findings: ['The revenue objective has no number.', 'Nobody owns the site.'],
      plan: '# Plan\n\n## Objectives\n\n### dev\n- Ship the first cut',
      decidesAfterHours: 6,
    });
    expect(body).toContain('The board returned this plan');
    expect(body).toContain('- The revenue objective has no number.');
    expect(body).toContain('- Nobody owns the site.');
    expect(body).toContain('### dev');
    expect(body).toContain('approved: true');
    expect(body).toContain('after 6 h the board');
    // With the switch off nothing promises the owner a deadline that will never come.
    expect(planVerdictBody({ board: 'pass', findings: [], plan: '# Plan', decidesAfterHours: 0 })).not.toMatch(/board's verdict stands/);
    expect(planVerdictBody({ board: 'pass', findings: [], plan: '# Plan', decidesAfterHours: 0 })).toContain('The board passed this plan');
    expect(planVerdictBody({ board: 'pass', findings: [], plan: '# Plan', decidesAfterHours: 0 })).toContain('raised nothing');
  });

  it('planVerdictId is stable per heartbeat, so a resumed cycle files no second note', () => {
    expect(planVerdictId('job_hb1')).toBe(planVerdictId('job_hb1'));
    expect(planVerdictId('job_hb1')).not.toBe(planVerdictId('job_hb2'));
    const first = createProposal(vault, { id: planVerdictId('job_hb1'), kind: 'plan_verdict', from: 'ceo', title: 'Approve this cycle\'s plan', body: 'x' }, 'ceo');
    const replay = createProposal(vault, { id: planVerdictId('job_hb1'), kind: 'plan_verdict', from: 'ceo', title: 'Approve this cycle\'s plan', body: 'x' }, 'ceo');
    expect(replay).toEqual(first);
    expect(listInbox(vault).filter((n) => n.data.kind === 'plan_verdict')).toHaveLength(1);
  });

  it('the dispatcher resolves an approved plan_verdict once, and a replay is a no-op', async () => {
    const { id, path: rel } = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'Approve this cycle\'s plan', body: 'The board passed this plan.' }, 'ceo');
    expect(await dispatchProposals(deps())).toBe(0);   // nothing to do while the owner has not ruled
    ownerEdit(rel, (t) => t.replace('approved: null', 'approved: true'));
    expect(await dispatchProposals(deps())).toBe(1);
    const resolved = vault.events.query({ types: ['proposal.resolved'] }).filter((e) => e.payload.id === id);
    expect(resolved).toHaveLength(1);
    expect(String(resolved[0].payload.outcome)).toContain('plan approved');
    const note = findInboxById(vault, id)!;
    expect(note.data.resolved_at).toBeTruthy();
    // Still open for the heartbeat: the divisions have not planned against it yet.
    expect(openPlanVerdict(vault)?.data.id).toBe(id);
    // Replay: the note is already stamped, so the dispatcher walks past it and leaves one resolution behind.
    expect(await dispatchProposals(deps())).toBe(0);
    expect(vault.events.query({ types: ['proposal.resolved'] }).filter((e) => e.payload.id === id)).toHaveLength(1);
    expect(findInboxById(vault, id)!.body.match(/_Resolved /g) ?? []).toHaveLength(1);
  });

  it('the dispatcher resolves a rejected plan_verdict once, and it closes at once', async () => {
    const { id, path: rel } = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'Approve this cycle\'s plan', body: 'The board returned this plan.' }, 'ceo');
    ownerEdit(rel, (t) => t.replace('approved: null', 'approved: false'));
    expect(await dispatchProposals(deps())).toBe(1);
    expect(openPlanVerdict(vault)).toBeNull();
    expect(await dispatchProposals(deps())).toBe(0);
    expect(vault.events.query({ types: ['proposal.resolved'] }).filter((e) => e.payload.id === id)).toHaveLength(1);
  });

  // A heartbeat that blocks on the plan fan-out leaves its checkpoint on `owner_verdict` — `division_plans`
  // returns without advancing it. The cache file under .cubicle/ is not the source of truth, so a resume that
  // has lost it must recover the plan jobs (and the verdict note) from the vault rather than making a second set.
  it('a heartbeat resumed at owner_verdict with no cache file re-plans nothing and files no second verdict note', async () => {
    const llm: Llm = { async chat() { throw new Error('the resumed steps must not call a model'); }, promptBudget: () => 6000 };
    const hbId = createHeartbeatJob(vault, 'test');
    vault.writeText('Plans/plan.md', '---\nupdated: ""\n---\n# Plan\n\n## Objectives\n\n### dev\n- Ship the first cut\n\n### revenue\n- Find ten customers\n', 'ceo');
    const plans = ['dev', 'revenue'].map((team) => createJob(vault, { type: 'team.plan', title: `Plan ${team}`, assigned: team === 'dev' ? 'dev_manager' : 'cmo', priority: 1, parent: hbId, team, goal: 'g' }, 'ceo'));
    const verdict = createProposal(vault, { id: planVerdictId(hbId), kind: 'plan_verdict', from: 'ceo', job: hbId, title: 'Approve this cycle\'s plan', body: 'The board passed this plan.' }, 'ceo');
    vault.updateNote(verdict.path, (n) => ({ data: { ...n.data, approved: true, board_verdict: 'pass' }, body: n.body }), 'owner');
    updateJob(vault, hbId, { status: 'blocked', checkpoint_step: HEARTBEAT_STEPS.indexOf('owner_verdict'), blocked_on: { kind: 'job', id: plans[0], since: new Date().toISOString() } }, 'daemon');
    rmSync(path.join(dir, '.cubicle/jobs', `${hbId}.heartbeat.json`), { force: true });

    const out = await runHeartbeat({ vault, llm, env: {}, now: () => new Date() }, hbId);
    expect(out.status).toBe('blocked');
    expect(listJobs(vault).filter((j) => j.type === 'team.plan').map((j) => j.id).sort()).toEqual([...plans].sort());
    expect(listInbox(vault).filter((n) => n.data.kind === 'plan_verdict')).toHaveLength(1);
  });
});
