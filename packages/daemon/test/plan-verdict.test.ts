import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, listInbox, listJobs, createJob, readJob, createProposal, findInboxById, updateJob, ownerInstruction } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler, type Llm } from '@cubicle/harness';
import { verdictOutcome, openPlanVerdict, rejectedPlanVerdict, planVerdictId, planVerdictBody, dispatchProposals, runHeartbeat, createHeartbeatJob, HEARTBEAT_STEPS } from '../src/index.js';
import { letTheBoardDecide } from './helpers/board-switch.js';
import { adoptFounderBrief } from './helpers/brief.js';

const root = path.resolve(__dirname, '../../..');
const toolsConfig = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));

let dir: string; let vault: Vault;
// Ruling S-1: the plan steps wait for an adopted founder brief, and every case here is about the plan verdict.
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-verdict-')); vault = (await scaffoldVault(dir)).vault; adoptFounderBrief(vault); });
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
    expect(body).toContain(ownerInstruction('plan_verdict'));
    expect(body).toContain("The board's verdict stands after 6 h");
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
    const plans = ['technology', 'revenue'].map((team) => createJob(vault, { type: 'division.plan', title: `Plan ${team}`, assigned: team === 'technology' ? 'cto' : 'cfo', priority: 1, parent: hbId, team, goal: 'g' }, 'ceo'));
    const verdict = createProposal(vault, { id: planVerdictId(hbId), kind: 'plan_verdict', from: 'ceo', job: hbId, title: 'Approve this cycle\'s plan', body: 'The board passed this plan.' }, 'ceo');
    vault.updateNote(verdict.path, (n) => ({ data: { ...n.data, approved: true, board_verdict: 'pass' }, body: n.body }), 'owner');
    updateJob(vault, hbId, { status: 'blocked', checkpoint_step: HEARTBEAT_STEPS.indexOf('owner_verdict'), blocked_on: { kind: 'job', id: plans[0], since: new Date().toISOString() } }, 'daemon');
    rmSync(path.join(dir, '.cubicle/jobs', `${hbId}.heartbeat.json`), { force: true });

    const out = await runHeartbeat({ vault, llm, env: {}, now: () => new Date() }, hbId);
    expect(out.status).toBe('blocked');
    expect(listJobs(vault).filter((j) => j.type === 'division.plan').map((j) => j.id).sort()).toEqual([...plans].sort());
    expect(listInbox(vault).filter((n) => n.data.kind === 'plan_verdict')).toHaveLength(1);
  });
});

describe('approved work continues, new work waits (Task 5 review I1/I2/M1)', () => {
  /** No model is needed by owner_verdict, division_plans, brief (it falls back to the template) or commit. */
  const mute: Llm = { async chat() { throw new Error('no model'); }, promptBudget: () => 6000 };
  const parkAt = (hbId: string, step: (typeof HEARTBEAT_STEPS)[number]) => updateJob(vault, hbId, { checkpoint_step: HEARTBEAT_STEPS.indexOf(step) }, 'daemon');
  const FRESH_PLAN = `---\nupdated: "${new Date().toISOString().slice(0, 10)}"\ncycle: 3\n---\n# Plan\n\n## Objectives\n\n### dev\n- Ship the first cut\n`;

  it('a plan nobody has ruled on fans out nothing, and the work an approved plan already queued keeps running', async () => {
    const hbId = createHeartbeatJob(vault, 'test');
    vault.writeText('Plans/plan.md', FRESH_PLAN, 'ceo');
    // Work the previous, approved plan already put on the queue: a pending verdict must not touch it.
    const inFlight = createJob(vault, { type: 'engineer.ship', title: 'Scaffold the site', assigned: 'backend_engineer', priority: 3, goal: 'g', team: 'dev' }, 'cto');
    const v = createProposal(vault, { id: planVerdictId(hbId), kind: 'plan_verdict', from: 'ceo', job: hbId, title: 'Approve this cycle\'s plan', body: 'The board passed this plan.' }, 'ceo');
    vault.updateNote(v.path, (n) => ({ data: { ...n.data, board_verdict: 'pass' }, body: n.body }), 'daemon');
    parkAt(hbId, 'owner_verdict');   // the switch ships off, so nothing but the owner can close this

    expect((await runHeartbeat({ vault, llm: mute, env: {}, now: () => new Date() }, hbId)).status).toBe('done');
    expect(listJobs(vault).filter((j) => j.type === 'division.plan')).toHaveLength(0);
    expect(readJob(vault, inFlight)!.data.status).toBe('queued');
    const note = findInboxById(vault, v.id)!;
    expect(note.data.approved).toBeNull();
    expect((note.data as { fanned_out?: string }).fanned_out).toBeUndefined();   // nothing was fanned out, so nothing is spent
    expect(openPlanVerdict(vault)?.data.id).toBe(v.id);                          // still the plan the next cycle must run
  });

  it('a plan with no objective is never filed for a verdict: an empty page must not park the company for ever', async () => {
    const hbId = createHeartbeatJob(vault, 'test');
    vault.writeText('Plans/plan.md', '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n', 'ceo');
    parkAt(hbId, 'owner_verdict');
    expect((await runHeartbeat({ vault, llm: mute, env: {}, now: () => new Date() }, hbId)).status).toBe('done');
    expect(listInbox(vault).filter((n) => n.data.kind === 'plan_verdict')).toHaveLength(0);
    expect(openPlanVerdict(vault)).toBeNull();   // so the next cycle plans instead of waiting on nothing
  });

  // …and "file no verdict" must not become "proceed as if approved" (Task 6 review, finding 1).
  // `planIsSubstantive` is false for an empty page but also for any plan whose every bullet starts with
  // verify/reconcile — a plausible Operations-only cycle, and the wording the brief's own fixture uses. Left to
  // the old behaviour the COO got a `division.plan` and could schedule up to four jobs nobody had ruled on.
  it('a plan whose only bullets are verify/reconcile busywork files no verdict AND fans nothing out', async () => {
    const hbId = createHeartbeatJob(vault, 'test');
    vault.writeText('Plans/plan.md', '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### operations\n- Verify what shipped and write the lesson\n- Reconcile Site/ with Brand/\n', 'ceo');
    parkAt(hbId, 'owner_verdict');
    expect((await runHeartbeat({ vault, llm: mute, env: {}, now: () => new Date() }, hbId)).status).toBe('done');
    expect(listInbox(vault).filter((n) => n.data.kind === 'plan_verdict')).toHaveLength(0);
    expect(listJobs(vault).filter((j) => j.type === 'division.plan')).toHaveLength(0);
    expect(readJob(vault, hbId)!.body).toContain('nothing to fan out: the plan has no objective');
    expect(openPlanVerdict(vault)).toBeNull();   // and the next cycle still plans rather than waiting on nothing
  });

  // The rejection is the owner's "no". Spending it before the rewrite exists meant a kill in between left the
  // note spent with no rewrite queued, and the resumed step — no rejection on file, a fresh plan, open work —
  // could let the re-planning gate stand the old plan down (Task 6 review, minor 5).
  it('the rejection is spent only once the rewrite\'s company.plan job exists', async () => {
    vault.writeText('Plans/plan.md', FRESH_PLAN, 'ceo');
    createJob(vault, { type: 'engineer.ship', title: 'Open work from that plan', assigned: 'backend_engineer', priority: 3, goal: 'g', team: 'dev' }, 'cto');
    const rejected = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'Approve this cycle\'s plan', body: 'The board returned this plan.' }, 'ceo');
    vault.updateNote(rejected.path, (n) => ({ data: { ...n.data, approved: false, resolved_at: new Date().toISOString() }, body: n.body }), 'owner');
    const hbId = createHeartbeatJob(vault, 'test');
    parkAt(hbId, 'company_plan');
    expect((await runHeartbeat({ vault, llm: mute, env: {}, now: () => new Date(), planMaxAgeDays: 3 }, hbId)).status).toBe('blocked');

    const planJob = listJobs(vault).find((j) => j.type === 'company.plan')!;
    expect((findInboxById(vault, rejected.id)!.data as { fanned_out?: string }).fanned_out).toBe(hbId);
    // The order the two writes actually landed in, from the event log: the rewrite's job note first, the stamp
    // that spends the rejection second. Anything killed between them leaves a rejection still asking for a
    // rewrite, which is the safe half of the pair to repeat.
    const writes = vault.events.query({ types: ['vault.wrote'] }).map((e) => String(e.payload.path));
    expect(writes).toContain(`Jobs/${planJob.id}.md`);
    expect(writes.lastIndexOf(rejected.path)).toBeGreaterThan(writes.indexOf(`Jobs/${planJob.id}.md`));
  });

  // The brief's `## Next action per team` lines are keyed on the team a queued job carries, and every job a
  // division lead schedules carries the *room's* id — so a division's own line reads "nothing queued" almost
  // every cycle and the continuity the goal promises was structurally blank (Task 6 review, finding 3).
  it('a division lead\'s "next action from the last brief" falls back to its rooms', async () => {
    const hbId = createHeartbeatJob(vault, 'test');
    vault.writeText('Plans/plan.md', '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### technology\n- Ship the first cut\n', 'ceo');
    vault.writeText('Runs/2026-09-10-0900.md', '# Since you were away\n\n## Next action per team\n\n- technology: nothing queued\n- dev: Scaffold the site from Brand/\n- revenue: nothing queued\n', 'ceo');
    const v = createProposal(vault, { id: planVerdictId(hbId), kind: 'plan_verdict', from: 'ceo', job: hbId, title: 'Approve this cycle\'s plan', body: 'The board passed this plan.' }, 'ceo');
    vault.updateNote(v.path, (n) => ({ data: { ...n.data, approved: true, board_verdict: 'pass' }, body: n.body }), 'owner');
    parkAt(hbId, 'owner_verdict');

    expect((await runHeartbeat({ vault, llm: mute, env: {}, now: () => new Date() }, hbId)).status).toBe('blocked');
    const divisionPlan = listJobs(vault).find((j) => j.type === 'division.plan' && j.team === 'technology')!;
    expect(readJob(vault, divisionPlan.id)!.body).toContain('Next action from the last brief: Scaffold the site from Brand/ (dev)');
  });

  // Live run, fresh vault: the owner approved the `plan_verdict` note while the daemon was down. On the restart
  // the dispatch resolved it and three division.plan jobs fanned out correctly — but a heartbeat that started in
  // the same startup logged "planning paused — the plan is waiting for your verdict" about the note that had
  // just been approved. The ordering is not the dispatch: `openPlanVerdict` matches on
  // `approved !== false && !fanned_out`, so it keeps returning an approved note until a cycle fans it out, and
  // this heartbeat read it before that stamp. Pausing is right; calling a verdict the owner has given "waiting"
  // is not.
  it('a plan the owner already approved is never reported as waiting for their verdict', async () => {
    const approved = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'Approve this cycle\'s plan', body: 'The board passed this plan.' }, 'ceo');
    vault.updateNote(approved.path, (n) => ({ data: { ...n.data, approved: true, board_verdict: 'pass', resolved_at: new Date().toISOString() }, body: n.body }), 'owner');
    vault.writeText('Plans/plan.md', '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### technology\n- Ship the first cut\n\n### revenue\n- Find ten customers\n', 'ceo');
    const hbId = createHeartbeatJob(vault, 'test');
    parkAt(hbId, 'company_plan');

    // Blocked on the fan-out: this cycle is the one that acts on that approval.
    expect((await runHeartbeat({ vault, llm: mute, env: {}, now: () => new Date() }, hbId)).status).toBe('blocked');
    const log = readJob(vault, hbId)!.body;
    expect(log).toContain('planning paused');
    expect(log).toContain('was approved; the divisions plan against it this cycle');
    expect(log).not.toContain('is waiting for your verdict');
    expect(listJobs(vault).filter((j) => j.type === 'division.plan')).toHaveLength(2);
    // And the note is spent, so the next cycle plans afresh instead of pausing on it again.
    expect((findInboxById(vault, approved.id)!.data as { fanned_out?: string }).fanned_out).toBe(hbId);
    expect(openPlanVerdict(vault)).toBeNull();
  });

  // Two facts lines said the same thing on a cycle that both inherited a waiting plan and left it waiting
  // (Task 6 review, minor 4).
  it('the brief says "waiting for your verdict" once, not twice', async () => {
    createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'Approve this cycle\'s plan', body: 'The board passed this plan.' }, 'ceo');
    vault.writeText('Plans/plan.md', FRESH_PLAN, 'ceo');
    const hbId = createHeartbeatJob(vault, 'test');
    parkAt(hbId, 'company_plan');

    expect((await runHeartbeat({ vault, llm: mute, env: {}, now: () => new Date() }, hbId)).status).toBe('done');
    const facts = vault.readText(vault.list('Runs', { ext: '.md' }).sort().at(-1)!).split('_Facts used:_')[1];
    expect(facts).toContain('Planning: paused — a plan is waiting for your verdict');
    expect(facts.match(/waiting for your verdict/g)).toHaveLength(1);
  });

  it('a note whose board session never got stamped reads as a return, not a pass, when the switch elapses', async () => {
    letTheBoardDecide(vault, 6);
    const hbId = createHeartbeatJob(vault, 'test');
    vault.writeText('Plans/plan.md', FRESH_PLAN, 'ceo');
    // A crash between createProposal and the updateNote that stamps `board_verdict` leaves exactly this note.
    const v = createProposal(vault, { id: planVerdictId(hbId), kind: 'plan_verdict', from: 'ceo', job: hbId, title: 'Approve this cycle\'s plan', body: 'The board read the plan.' }, 'ceo');
    vault.updateNote(v.path, (n) => ({ data: { ...n.data, created: hoursAgo(10) }, body: n.body }), 'daemon');
    parkAt(hbId, 'owner_verdict');

    await runHeartbeat({ vault, llm: mute, env: {}, now: () => new Date() }, hbId);
    const note = findInboxById(vault, v.id)!;
    expect(note.data.approved).toBe(false);
    expect(note.data.decided_by).toBe('board');
    expect(listJobs(vault).filter((j) => j.type === 'division.plan')).toHaveLength(0);
  });

  it('rejectedPlanVerdict is the newest rejection nobody has acted on', () => {
    const old = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'a', body: 'a' }, 'ceo');
    const spent = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'b', body: 'b' }, 'ceo');
    const open = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'c', body: 'c' }, 'ceo');
    vault.updateNote(old.path, (n) => ({ data: { ...n.data, approved: false, created: hoursAgo(9) }, body: n.body }), 'owner');
    vault.updateNote(spent.path, (n) => ({ data: { ...n.data, approved: false, created: hoursAgo(1), fanned_out: 'job_x' }, body: n.body }), 'owner');
    expect(rejectedPlanVerdict(vault)?.data.id).toBe(old.id);
    const newer = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'd', body: 'd' }, 'ceo');
    vault.updateNote(newer.path, (n) => ({ data: { ...n.data, approved: false }, body: n.body }), 'owner');
    expect(rejectedPlanVerdict(vault)?.data.id).toBe(newer.id);
    expect(openPlanVerdict(vault)?.data.id).toBe(open.id);   // a pending note is not a rejection
  });

  it('a rejection is a rewrite request: the next cycle re-plans even against a fresh plan, and spends the rejection', async () => {
    vault.writeText('Plans/plan.md', FRESH_PLAN, 'ceo');
    createJob(vault, { type: 'engineer.ship', title: 'Open work from that plan', assigned: 'backend_engineer', priority: 3, goal: 'g', team: 'dev' }, 'cto');
    const hb1 = createHeartbeatJob(vault, 'test');
    parkAt(hb1, 'company_plan');
    // Control: a fresh, substantive plan with open work and nobody complaining — the gate stands it down.
    await runHeartbeat({ vault, llm: mute, env: {}, now: () => new Date(), planMaxAgeDays: 3 }, hb1);
    expect(listJobs(vault).filter((j) => j.type === 'company.plan')).toHaveLength(0);

    const rejected = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'Approve this cycle\'s plan', body: 'The board returned this plan.' }, 'ceo');
    vault.updateNote(rejected.path, (n) => ({ data: { ...n.data, approved: false, resolved_at: new Date().toISOString() }, body: n.body }), 'owner');
    const hb2 = createHeartbeatJob(vault, 'test');
    parkAt(hb2, 'company_plan');
    const out = await runHeartbeat({ vault, llm: mute, env: {}, now: () => new Date(), planMaxAgeDays: 3 }, hb2);
    expect(out.status).toBe('blocked');
    expect(listJobs(vault).filter((j) => j.type === 'company.plan')).toHaveLength(1);
    // One rejection buys one rewrite: the note is spent, so the cycle after this one is not forced to re-plan again.
    expect((findInboxById(vault, rejected.id)!.data as { fanned_out?: string }).fanned_out).toBe(hb2);
    expect(rejectedPlanVerdict(vault)).toBeNull();
  });
});
