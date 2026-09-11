import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, listJobs, listInbox, readJob, loadOrg, resolveTeamSection, listDecisions, DecisionFrontmatter, createJob, updateJob, setSection, createStream, writeCiRecord } from '@cubicle/core';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig, HEARTBEAT_STEPS, planIsSubstantive, firstOpenJob, parseObjectiveSections, mergeBoardVerdict } from '../src/index.js';
import { orgLlm } from '../../../scripts/lib/org-llm.js';
import { letTheBoardDecide, planUntilFannedOut } from './helpers/board-switch.js';

const root = path.resolve(__dirname, '../../..');
let dir: string;
// Every heartbeat here needs a company to plan for: nothing runs before the owner has given one an idea
// (spec §12, C1). The brand name is the inert way to say so — an inbox message would also land in the brief.
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-plan-'));
  const { vault } = await scaffoldVault(dir);
  vault.updateNote('Brand/name.md', (n) => ({ data: { ...n.data, name: 'PlateReady' }, body: n.body }), 'owner');
  // Nobody is at the keyboard here and `board_decides_after_hours` ships off, so a plan would wait for the owner
  // for ever and no division would ever plan. Hand the board the ruling after a fraction of an hour instead.
  letTheBoardDecide(vault);
  // An engineer.ship cannot finish without a green CI record for its stream (§17), so the scripted dev plan
  // ships against this one. Nothing lives under Workspace/site, so the record never goes stale.
  createStream(vault, { slug: 'site', name: 'Site', problem: 'The company has no site.', customers: 'Everyone who hears about us', outcome_metric: 'a first cut exists', owner_team: 'dev' }, 'ceo');
  writeCiRecord(vault, 'site', { stream: 'site', started: '2026-09-11T09:59:00.000Z', finished: '2026-09-11T10:00:00.000Z', green: true, commit: null, steps: [{ name: 'test', code: 0, ok: true, duration_ms: 5, output: 'ok' }] }, 'backend_engineer');
  vault.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const daemonFor = (llm: Llm) => new Daemon(defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 300, maxConcurrentJobs: 3, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined });
async function waitFor(pred: () => boolean, ms = 30000): Promise<void> { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); } }

describe('mergeBoardVerdict', () => {
  it('reads the chair\'s verdict line and its bullets, and fails open to pass', () => {
    expect(mergeBoardVerdict('VERDICT: return\n- no metric on the growth objective\n- nobody owns the deploy')).toEqual({ verdict: 'return', findings: ['no metric on the growth objective', 'nobody owns the deploy'] });
    expect(mergeBoardVerdict('verdict: PASS\n- watch the free tier')).toEqual({ verdict: 'pass', findings: ['watch the free tier'] });
    expect(mergeBoardVerdict('')).toEqual({ verdict: 'pass', findings: [] });
    expect(mergeBoardVerdict('The board could not agree.')).toEqual({ verdict: 'pass', findings: [] });
  });
});

describe('planIsSubstantive (Task 9 review finding 1)', () => {
  it('is false for a plan with no ### sections at all', () => {
    expect(planIsSubstantive('---\ncycle: 1\n---\n# Plan\n\n## Objectives\n')).toBe(false);
  });
  it('is false when every section is verify/reconcile-only busywork', () => {
    const plan = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### dev\n- Verify the deployed site\n- Reconcile Site/ with Brand/\n';
    expect(planIsSubstantive(plan)).toBe(false);
  });
  it('is true when a real objective sits alongside a verify/reconcile-only section (the bug: a per-section-scoped regex would stop at the first busywork-only section)', () => {
    const plan = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### dev\n- Verify the deployed site\n\n### revenue\n- Find the first organic channel\n';
    expect(planIsSubstantive(plan)).toBe(true);
  });
});

describe('team section header matching (F4)', () => {
  it('parseObjectiveSections keeps multi-word and differently-cased headers instead of dropping them', () => {
    const plan = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### Dev\n- Ship it\n\n### Revenue team\n- Find channels\n';
    expect(parseObjectiveSections(plan).map((s) => s.team)).toEqual(['Dev', 'Revenue team']);
  });
  it('resolveTeamSection matches a header against a team id or name, case-insensitively and tolerant of a trailing "team"; an unmatched header returns null', async () => {
    const vault = Vault.open(dir);
    try {
      const org = loadOrg(vault);
      expect(resolveTeamSection(org, 'Dev')).toBe('dev');
      expect(resolveTeamSection(org, 'revenue team')).toBe('revenue');
      expect(resolveTeamSection(org, 'REVENUE TEAM')).toBe('revenue');
      expect(resolveTeamSection(org, 'Nonexistent')).toBeNull();
    } finally { vault.close(); }
  });
  it('a plan with differently-cased/multi-word headers still fans out to both divisions; an unmatched header warns and creates no division.plan', async () => {
    const plan = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### Dev\n- Scaffold the site from Brand/\n\n### revenue team\n- Find the first organic channel\n\n### Nonexistent\n- Should warn, not crash\n';
    const llm = orgLlm({ vetoes: 0, plan });
    const d = daemonFor(llm);
    await d.start();
    const v = Vault.open(dir);
    try {
      await planUntilFannedOut(d, v, 2);
      const plans = listJobs(v).filter((j) => j.type === 'division.plan');
      expect(plans.map((j) => j.assigned).sort()).toEqual(['cfo', 'cto']);
      expect(v.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'division_plans' && /Nonexistent/.test(String(e.payload.message)))).toBe(true);
    } finally { v.close(); await d.stop(); }
  });
});

describe('firstOpenJob (Task 9 review finding 2)', () => {
  it('returns the first id that is not done/failed/cancelled', () => {
    const status: Record<string, string> = { a: 'done', b: 'running', c: 'queued' };
    expect(firstOpenJob(['a', 'b', 'c'], (id) => status[id])).toBe('b');
  });
  it('does not keep re-selecting ids[0] once it finishes while a later one is still open (the busy-loop bug)', () => {
    const status: Record<string, string> = { a: 'done', b: 'done', c: 'queued' };
    expect(firstOpenJob(['a', 'b', 'c'], (id) => status[id])).toBe('c');
  });
  it('falls back to the last id when every one already looks finished (defensive; the caller only asks while one is still open)', () => {
    const status: Record<string, string> = { a: 'done', b: 'failed' };
    expect(firstOpenJob(['a', 'b'], (id) => status[id])).toBe('b');
  });
  it('treats an unknown/missing status as open', () => {
    expect(firstOpenJob(['a', 'b'], () => undefined)).toBe('a');
  });
});

describe('two-level planning (spec §3)', () => {
  it('steps are company_plan → board_premortem → division_plans; a return reruns the CEO once; leads fan out; brief has next actions per team (acceptance test 10)', async () => {
    expect(HEARTBEAT_STEPS).toEqual(['gather', 'reconcile_brand', 'answer_owner', 'meeting', 'company_plan', 'board_premortem', 'owner_verdict', 'division_plans', 'brief', 'commit']);
    const llm = orgLlm({ vetoes: 1 });
    const d = daemonFor(llm);
    await d.start();
    const v = Vault.open(dir);
    try {
      await planUntilFannedOut(d, v, 2);
      const jobs = listJobs(v);
      expect(jobs.filter((j) => j.type === 'company.plan')).toHaveLength(2); // one return → one rewrite
      expect(jobs.filter((j) => j.type === 'board.premortem')).toHaveLength(2);
      expect(jobs.every((j) => j.type !== 'board.premortem' || j.status === 'done')).toBe(true);
      expect(v.events.count('plan.vetoed')).toBe(1);
      const divisionPlans = jobs.filter((j) => j.type === 'division.plan');
      expect(divisionPlans.map((j) => j.assigned).sort()).toEqual(['cfo', 'cto']);   // dev -> technology, revenue -> revenue
      expect(divisionPlans.every((j) => j.status === 'done')).toBe(true);
      expect(jobs.some((j) => j.type === 'engineer.ship' && j.owner_role === 'cto' && j.team === 'dev')).toBe(true);
      expect(jobs.some((j) => j.type === 'research' && j.for === 'cfo')).toBe(true);
      expect(v.events.count('team.planned')).toBe(2);
      // Only the cycle that wrote the plan holds a board session; the one that fans it out finds the verdict note
      // open and skips straight past, so a waiting plan costs one session per plan, not one per heartbeat.
      expect(llm.calls.advisor_investor ?? 0).toBeLessThanOrEqual(2);
      expect(llm.calls.advisor_customer ?? 0).toBeLessThanOrEqual(2);
      // Task 9 review finding 2 (busy loop when team_plans re-blocks on an already-finished ids[0]) is covered
      // directly by the firstOpenJob unit tests above — job.blocked events are only emitted by block()/blockMany(),
      // which team_plans calls at most once regardless, so an event count here would not have caught the bug.
      const brief = readFileSync(path.join(dir, 'Runs', readFileSync(path.join(dir, 'Jobs/queue.md'), 'utf8') && require('node:fs').readdirSync(path.join(dir, 'Runs')).filter((f: string) => f.endsWith('.md')).sort().at(-1)!), 'utf8');
      expect(brief).toContain('## Next action per team');
      expect(existsSync(path.join(dir, 'Decisions'))).toBe(true);
      console.log('calls per cycle:', llm.calls, '=', Object.values(llm.calls).reduce((a, b) => a + b, 0));
      // Two heartbeats (the plan, then the fan-out once the board's verdict stands) - the ceiling covers both.
      expect(Object.values(llm.calls).reduce((a, b) => a + b, 0)).toBeLessThan(100);
    } finally { v.close(); await d.stop(); }
  });
  it('a second veto escalates to the owner as a message and the cycle continues', async () => {
    const d = daemonFor(orgLlm({ vetoes: 2 }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      expect(v.events.count('plan.vetoed')).toBe(2);
      expect(listJobs(v).filter((j) => j.type === 'company.plan')).toHaveLength(2);
      expect(v.events.query({ types: ['proposal.created'] }).some((e) => e.payload.kind === 'message' && String(e.payload.title).toLowerCase().includes('veto'))).toBe(true);
    } finally { v.close(); await d.stop(); }
  });

  it('a process: line does not make team_plans wait for its expanded jobs (Task 9 review round 2)', async () => {
    // "launch" has no team.plan/board.premortem/company.plan step, so its expanded jobs can't be confused with
    // the ones team_plans itself creates; its first step (engineer.ship, no depends_on) is queued immediately but
    // needs its own worker cycle, so it should still be open when the heartbeat completes if team_plans correctly
    // waits only on the team.plan jobs (not rollup() of every heartbeat child).
    const planWithProcess = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### dev\n- Scaffold the site from Brand/\nprocess: launch\n\n### revenue\n- Find the first organic channel\n';
    const llm = orgLlm({ vetoes: 0, plan: planWithProcess });
    const d = daemonFor(llm);
    await d.start();
    const v = Vault.open(dir);
    try {
      await planUntilFannedOut(d, v, 2);
      const jobs = listJobs(v);
      // The cycle that fanned out is the one that expanded the process: line, not necessarily the first heartbeat.
      const hb = jobs.find((j) => j.type === 'ceo.heartbeat' && jobs.some((c) => c.parent === j.id && c.type === 'division.plan'))!;
      const divisionPlans = jobs.filter((j) => j.type === 'division.plan');
      expect(divisionPlans.every((j) => j.status === 'done')).toBe(true);
      // Expanded jobs are direct children of the heartbeat, like team.plan/board.premortem/company.plan, but a
      // different type — the lead's own scheduler.request jobs (e.g. engineer.ship from a team.plan) are parented
      // to that team.plan job instead, so this filter only catches the process expansion.
      const expanded = jobs.filter((j) => j.parent === hb.id && !['company.plan', 'board.premortem', 'division.plan'].includes(j.type));
      expect(expanded.length).toBeGreaterThan(0);
      expect(expanded.some((j) => !['done', 'failed', 'cancelled'].includes(j.status))).toBe(true);
    } finally { v.close(); await d.stop(); }
  });
});

describe('brief notes a recent org migration (F10)', () => {
  it('a migration org.changed event since the previous heartbeat surfaces under What needs you', async () => {
    const seed = Vault.open(dir);
    seed.events.emit({ type: 'org.changed', agent: 'daemon', payload: { reason: 'migration', changed: ['Teams/dev.md'] } });
    seed.close();
    const llm = orgLlm({ vetoes: 0, plan: '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n' });
    const d = daemonFor(llm);
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      const runs = v.list('Runs', { ext: '.md' }).sort();
      const brief = readFileSync(path.join(dir, runs.at(-1)!), 'utf8');
      expect(brief).toContain('The company was reorganised into teams');
    } finally { v.close(); await d.stop(); }
  });
});

describe('board pre-mortems are validated decision notes (D7)', () => {
  const SECTIONS = ['## Context', '## Options considered', '## Chosen', '## Why', '## Expected effect', '## Review date'];

  it('a passing pre-mortem is an adopted decision note, and the board is not asked to write one itself', async () => {
    const d = daemonFor(orgLlm({ vetoes: 0 }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      // A run now holds more than one heartbeat: pick the one that actually held the board session.
      const all = listJobs(v);
      const hb = all.find((j) => j.type === 'ceo.heartbeat' && all.some((c) => c.parent === j.id && c.type === 'board.premortem'))!;
      const rel = `Decisions/premortem-${hb.id}.md`;
      expect(v.exists(rel)).toBe(true);
      const note = v.readNoteOrNull(rel)!;
      const fm = DecisionFrontmatter.parse(note.data);
      expect(fm.id).toBe(`premortem-${hb.id}`);
      expect(fm.decided_by).toBe('advisor_skeptic');   // the board lead signs the joint verdict
      expect(fm.cycle).toBe(hb.id);
      expect(fm.status).toBe('adopted');
      expect(fm.inputs).toEqual(['[[Plans/plan]]']);
      for (const h of SECTIONS) expect(note.body).toContain(h);
      expect(listDecisions(v).map((x) => x.path)).toContain(rel);
      const board = listJobs(v).find((j) => j.type === 'board.premortem')!;
      expect(readJob(v, board.id)!.body).toContain('### The Skeptic');
      expect(readJob(v, board.id)!.body).not.toContain('Decisions/');
    } finally { v.close(); await d.stop(); }
  });

  it('a returned pre-mortem is a proposed decision note carrying the findings', async () => {
    const d = daemonFor(orgLlm({ vetoes: 2 }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      // A run now holds more than one heartbeat: pick the one that actually held the board session.
      const all = listJobs(v);
      const hb = all.find((j) => j.type === 'ceo.heartbeat' && all.some((c) => c.parent === j.id && c.type === 'board.premortem'))!;
      const note = v.readNoteOrNull(`Decisions/premortem-${hb.id}.md`)!;
      expect(DecisionFrontmatter.parse(note.data).status).toBe('proposed');
      expect(note.body).toContain('growth objective has no metric');
    } finally { v.close(); await d.stop(); }
  });
});

describe('brief lists jobs that stopped and wait for the owner', () => {
  it('a job finished as blocked (blocked_on owner) appears under What needs you with its blocker', async () => {
    const seed = Vault.open(dir);
    const id = createJob(seed, { type: 'growth.outreach', title: 'Review outreach', assigned: 'cto', priority: 3, goal: 'g' }, 'ceo');
    updateJob(seed, id, { status: 'blocked', blocked_on: { kind: 'owner', id, since: new Date().toISOString() } }, 'cto');
    seed.updateNote(`Jobs/${id}.md`, (n) => ({ data: n.data, body: setSection(n.body, '## Result', '```json\n' + JSON.stringify({ status: 'blocked', blockers: ['cto may not schedule cto'], summary: 'stuck' }) + '\n```') }), 'cto');
    seed.close();
    const d = daemonFor(orgLlm({ vetoes: 0, plan: '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n' }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      const runs = v.list('Runs', { ext: '.md' }).sort();
      const brief = readFileSync(path.join(dir, runs.at(-1)!), 'utf8');
      const facts = brief.split('_Facts used:_')[1] ?? '';
      expect(facts).toContain(`Decide on ${id}`);
      expect(facts).toContain('cto may not schedule cto');
      expect(facts).toContain('status: queued');
    } finally { v.close(); await d.stop(); }
  });
});

describe('division planning (spec item 3)', () => {
  it('one division.plan per division named in the plan, and none for the teams that do not plan', async () => {
    const plan = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### technology\n- Ship the first cut\n\n### revenue\n- Find the first organic channel\n\n### operations\n- Verify what shipped and write the lesson\n\n### security\n- Rotate the keys\n';
    const d = daemonFor(orgLlm({ vetoes: 0, plan }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await planUntilFannedOut(d, v, 3);
      const plans = listJobs(v).filter((j) => j.type === 'division.plan');
      expect(plans.map((j) => j.assigned).sort()).toEqual(['cfo', 'coo', 'cto']);
      expect(listJobs(v).filter((j) => j.type === 'board.premortem')).toHaveLength(1);
      expect(v.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'division_plans' && /security/.test(String(e.payload.message)))).toBe(true);
      const goal = readJob(v, plans.find((j) => j.assigned === 'cto')!.id)!.body;
      expect(goal).toContain('Dev (lead dev_manager');
      expect(goal).toContain('backend_engineer');
    } finally { v.close(); await d.stop(); }
  });

  it('with the switch off — the shipped default — the plan waits for the owner, and no new work starts', async () => {
    const seed = Vault.open(dir);
    // Undo the beforeEach helper: this is the vault as it ships, where only the owner rules.
    seed.writeText('Memory/constitution.md', seed.readText('Memory/constitution.md').replace(/^board_decides_after_hours:.*$/m, 'board_decides_after_hours: 0'), 'owner');
    seed.close();
    const d = daemonFor(orgLlm({ vetoes: 0 }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      // Give the daemon several more ticks: no amount of waiting decides this plan, only the owner does.
      await new Promise((r) => setTimeout(r, 2000));
      d.requestHeartbeat('nothing has changed');
      await new Promise((r) => setTimeout(r, 2000));
      expect(listJobs(v).filter((j) => j.type === 'division.plan')).toHaveLength(0);
      const verdict = listInbox(v).find((n) => n.data.kind === 'plan_verdict')!;
      expect(verdict.data.approved).toBeNull();
      expect(verdict.data.resolved_at).toBeNull();
      expect(listJobs(v).filter((j) => j.type === 'company.plan')).toHaveLength(1);  // nothing was written over it either
      // The owner approves; the next heartbeat plans the divisions against the plan that was waiting.
      v.updateNote(verdict.path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'owner');
      d.requestHeartbeat('owner approved the plan');
      await waitFor(() => listJobs(v).filter((j) => j.type === 'division.plan').length >= 2, 60000);
      expect(listJobs(v).filter((j) => j.type === 'company.plan')).toHaveLength(1);
    } finally { v.close(); await d.stop(); }
  });
});
