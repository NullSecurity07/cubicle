import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, listJobs, readJob } from '@cubicle/core';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig, HEARTBEAT_STEPS, planIsSubstantive, firstOpenJob } from '../src/index.js';
import { orgLlm } from '../../../scripts/lib/org-llm.js';

const root = path.resolve(__dirname, '../../..');
let dir: string;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-plan-')); const { vault } = await scaffoldVault(dir); vault.close(); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const daemonFor = (llm: Llm) => new Daemon(defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 300, maxConcurrentJobs: 3, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined });
async function waitFor(pred: () => boolean, ms = 30000): Promise<void> { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); } }

describe('planIsSubstantive (Task 9 review finding 1)', () => {
  it('is false for a plan with no ### sections at all', () => {
    expect(planIsSubstantive('---\ncycle: 1\n---\n# Plan\n\n## Objectives\n')).toBe(false);
  });
  it('is false when every section is verify/reconcile-only busywork', () => {
    const plan = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### engineering\n- Verify the deployed site\n- Reconcile Site/ with Brand/\n';
    expect(planIsSubstantive(plan)).toBe(false);
  });
  it('is true when a real objective sits alongside a verify/reconcile-only section (the bug: a per-section-scoped regex would stop at the first busywork-only section)', () => {
    const plan = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### engineering\n- Verify the deployed site\n\n### growth\n- Find the first organic channel\n';
    expect(planIsSubstantive(plan)).toBe(true);
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
  it('steps are company_plan → critic → team_plans; a veto reruns the CEO once; leads fan out; brief has next actions per team (acceptance test 10)', async () => {
    expect(HEARTBEAT_STEPS).toEqual(['gather', 'reconcile_brand', 'answer_owner', 'meeting', 'company_plan', 'critic', 'team_plans', 'brief', 'commit']);
    const llm = orgLlm({ vetoes: 1 });
    const d = daemonFor(llm);
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      const jobs = listJobs(v);
      expect(jobs.filter((j) => j.type === 'company.plan')).toHaveLength(2); // veto → one rewrite
      expect(jobs.filter((j) => j.type === 'critic.premortem')).toHaveLength(2);
      expect(v.events.count('plan.vetoed')).toBe(1);
      const teamPlans = jobs.filter((j) => j.type === 'team.plan');
      expect(teamPlans.map((j) => j.assigned).sort()).toEqual(['cto', 'head_of_growth']);
      expect(teamPlans.every((j) => j.status === 'done')).toBe(true);
      expect(jobs.some((j) => j.type === 'engineer.ship' && j.owner_role === 'cto' && j.team === 'engineering')).toBe(true);
      expect(jobs.some((j) => j.type === 'research' && j.for === 'head_of_growth')).toBe(true);
      expect(v.events.count('team.planned')).toBe(2);
      // Task 9 review finding 2 (busy loop when team_plans re-blocks on an already-finished ids[0]) is covered
      // directly by the firstOpenJob unit tests above — job.blocked events are only emitted by block()/blockMany(),
      // which team_plans calls at most once regardless, so an event count here would not have caught the bug.
      const brief = readFileSync(path.join(dir, 'Runs', readFileSync(path.join(dir, 'Jobs/queue.md'), 'utf8') && require('node:fs').readdirSync(path.join(dir, 'Runs')).filter((f: string) => f.endsWith('.md')).sort().at(-1)!), 'utf8');
      expect(brief).toContain('## Next action per team');
      expect(existsSync(path.join(dir, 'Decisions'))).toBe(true);
      console.log('calls per cycle:', llm.calls, '=', Object.values(llm.calls).reduce((a, b) => a + b, 0));
      expect(Object.values(llm.calls).reduce((a, b) => a + b, 0)).toBeLessThan(60);
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
    // "launch" has no team.plan/critic.premortem/company.plan step, so its expanded jobs can't be confused with
    // the ones team_plans itself creates; its first step (engineer.ship, no depends_on) is queued immediately but
    // needs its own worker cycle, so it should still be open when the heartbeat completes if team_plans correctly
    // waits only on the team.plan jobs (not rollup() of every heartbeat child).
    const planWithProcess = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### engineering\n- Scaffold the site from Brand/\nprocess: launch\n\n### growth\n- Find the first organic channel\n';
    const llm = orgLlm({ vetoes: 0, plan: planWithProcess });
    const d = daemonFor(llm);
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      const jobs = listJobs(v);
      const hb = jobs.find((j) => j.type === 'ceo.heartbeat')!;
      const teamPlans = jobs.filter((j) => j.type === 'team.plan');
      expect(teamPlans.every((j) => j.status === 'done')).toBe(true);
      // Expanded jobs are direct children of the heartbeat, like team.plan/critic.premortem/company.plan, but a
      // different type — the lead's own scheduler.request jobs (e.g. engineer.ship from a team.plan) are parented
      // to that team.plan job instead, so this filter only catches the process expansion.
      const expanded = jobs.filter((j) => j.parent === hb.id && !['company.plan', 'critic.premortem', 'team.plan'].includes(j.type));
      expect(expanded.length).toBeGreaterThan(0);
      expect(expanded.some((j) => !['done', 'failed', 'cancelled'].includes(j.status))).toBe(true);
    } finally { v.close(); await d.stop(); }
  });
});
