import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, listJobs, listInbox, readJob, loadOrg, resolveTeamSection, listDecisions, DecisionFrontmatter, createJob, updateJob, setSection, createStream, writeCiRecord, createProposal, writeIdeaCard, updateIdea } from '@cubicle/core';
import type { Llm } from '@cubicle/harness';
import type { RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import { Daemon, defaultConfig, HEARTBEAT_STEPS, planIsSubstantive, firstOpenJob, parseObjectiveSections, mergeBoardVerdict, runBoardSession, writeBoardPremortemDecision, BOARD_UNREVIEWED_NOTE, runHeartbeat, createHeartbeatJob, planVerdictId, boardSubject, advisorPrompt, chairPrompt, boardAgenda } from '../src/index.js';
import { orgLlm } from '../../../scripts/lib/org-llm.js';
import { letTheBoardDecide, planUntilFannedOut } from './helpers/board-switch.js';
import { TEST_MS, eventProgress, waitForProgress } from './helpers/load.js';

const root = path.resolve(__dirname, '../../..');
let dir: string;
/** "Has anything happened": the event log's JSONL mirror, appended to by every emitted event (helpers/load.ts). */
const progress = eventProgress(() => dir);
// Every heartbeat here needs a company to plan for: nothing runs before the owner has given one an idea
// (spec §12, C1). The brand name is the inert way to say so — an inbox message would also land in the brief.
beforeEach(async () => {
  disposed = false;
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
/**
 * Every daemon this file started, stopped before the vault it writes to is removed.
 *
 * The teardown has to be ordered and unconditional. A test body vitest has given up on never reaches its own
 * `finally`, so a daemon could outlive `rmSync`: its tick, its watcher's debounce and its workers keep writing to
 * a directory that is gone, which throws ENOENT storms attributed to whichever case runs next and starves that
 * one of CPU until it times out too — one slow case taking the rest of the file down with it, which is the shape
 * this flake had. `d.stop()` clears the tick, awaits `VaultWatcher.stop()` (which clears its debounce timers and
 * awaits chokidar's `close()`) and closes the pool, so after it nothing is left holding the directory.
 */
const daemons: Daemon[] = [];
/**
 * Set the moment teardown begins, so a poll loop belonging to a case that has already been given up on stops
 * touching a vault that is being removed rather than raising under the next case's name.
 */
let disposed = false;
afterEach(async () => {
  disposed = true;
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  // One turn of the loop, so a callback already queued behind those stops runs before the directory goes.
  await new Promise((r) => setImmediate(r));
  rmSync(dir, { recursive: true, force: true });
});

const daemonFor = (llm: Llm) => {
  const d = new Daemon(defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 300, maxConcurrentJobs: 3, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined });
  daemons.push(d);
  return d;
};
/**
 * Poll a condition on real timers, failing only when the daemon has written nothing for the stall budget
 * (`helpers/load.ts`). A hard 60 s was the original flake, and scaling it by a load read at import was not the
 * cure: under `pnpm -r test` every suite starts while the 1-minute average still describes an idle box. Watching
 * the event log makes the wait independent of how busy the machine is.
 */
async function waitFor(pred: () => boolean, what = 'a condition'): Promise<void> {
  await waitForProgress(pred, { progress, torn: () => disposed, what });
}

// A plan good enough to exercise runBoardSession directly, without going through a whole heartbeat.
const PLAN_TEXT = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### dev\n- Scaffold the site from Brand/\n';

/** Scripted `chat()` that records which tier and roleId each call used, so a test can check what `askAs` sent
 * to the router without parsing a real model response. */
function tierRecordingLlm(): Llm & { calls: { roleId: string; tier: string; prompt: string }[] } {
  const calls: { roleId: string; tier: string; prompt: string }[] = [];
  return {
    calls,
    async chat(req: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[] }) {
      const last = String(chat.messages.at(-1)?.content ?? '');
      calls.push({ roleId: req.roleId ?? '?', tier: String(req.tier), prompt: last });
      // Two chair prompts, two shapes (SP5b): the plan's asks for `VERDICT: pass`, the idea's for one of the
      // three pressure-test words. Answering the idea chair parseably keeps a session at four calls — an
      // unusable answer would buy the chair its one re-ask, and every cost assertion below would shift.
      const content = /VERDICT: pass/.test(last) ? 'VERDICT: pass\n- none'
        : /VERDICT: STRONG/.test(last) ? 'VERDICT: STRONG\nRUBRIC: core assumption 2, fatal flaws 2, pain 2, founder fit 2, why now 2\n- none'
        : '- a failure mode';
      return { content, toolCalls: [], finishReason: 'stop' as const, usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] };
    },
    promptBudget: () => 6000,
  } satisfies Llm & { calls: typeof calls };
}

describe('mergeBoardVerdict', () => {
  it('reads the chair\'s verdict line and its bullets, and fails open to pass', () => {
    expect(mergeBoardVerdict('VERDICT: return\n- no metric on the growth objective\n- nobody owns the deploy')).toMatchObject({ verdict: 'return', findings: ['no metric on the growth objective', 'nobody owns the deploy'] });
    expect(mergeBoardVerdict('verdict: PASS\n- watch the free tier')).toMatchObject({ verdict: 'pass', findings: ['watch the free tier'] });
    expect(mergeBoardVerdict('')).toMatchObject({ verdict: 'pass', findings: [] });
    expect(mergeBoardVerdict('The board could not agree.')).toMatchObject({ verdict: 'pass', findings: [] });
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
  }, TEST_MS);
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
    // The order this test is about, relative and not positional: `money` was inserted at index 1 and a pinned
    // array made that a test edit rather than a test.
    expect(HEARTBEAT_STEPS).toEqual(expect.arrayContaining(['gather', 'reconcile_brand', 'answer_owner', 'discovery', 'ideas_board', 'meeting', 'company_plan', 'board_premortem', 'owner_verdict', 'division_plans', 'brief', 'commit']));
    const at = (s: string) => HEARTBEAT_STEPS.indexOf(s as (typeof HEARTBEAT_STEPS)[number]);
    expect(at('company_plan')).toBeLessThan(at('board_premortem'));
    expect(at('board_premortem')).toBeLessThan(at('owner_verdict'));
    expect(at('owner_verdict')).toBeLessThan(at('division_plans'));
    expect(at('division_plans')).toBeLessThan(at('brief'));
    expect(at('brief')).toBeLessThan(at('commit'));
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
  }, TEST_MS);
  it('a second veto escalates to the owner as a message and the cycle continues', async () => {
    const d = daemonFor(orgLlm({ vetoes: 2 }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1);
      expect(v.events.count('plan.vetoed')).toBe(2);
      expect(listJobs(v).filter((j) => j.type === 'company.plan')).toHaveLength(2);
      expect(v.events.query({ types: ['proposal.created'] }).some((e) => e.payload.kind === 'message' && String(e.payload.title).toLowerCase().includes('veto'))).toBe(true);
    } finally { v.close(); await d.stop(); }
  }, TEST_MS);

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
  }, TEST_MS);
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
      await waitFor(() => v.events.count('heartbeat.completed') >= 1);
      const runs = v.list('Runs', { ext: '.md' }).sort();
      const brief = readFileSync(path.join(dir, runs.at(-1)!), 'utf8');
      expect(brief).toContain('The company was reorganised into teams');
    } finally { v.close(); await d.stop(); }
  }, TEST_MS);
});

describe('board pre-mortems are validated decision notes (D7)', () => {
  const SECTIONS = ['## Context', '## Options considered', '## Chosen', '## Why', '## Expected effect', '## Review date'];

  it('a passing pre-mortem is an adopted decision note, and the board is not asked to write one itself', async () => {
    const d = daemonFor(orgLlm({ vetoes: 0 }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1);
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
  }, TEST_MS);

  it('a returned pre-mortem is a proposed decision note carrying the findings', async () => {
    const d = daemonFor(orgLlm({ vetoes: 2 }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1);
      // A run now holds more than one heartbeat: pick the one that actually held the board session.
      const all = listJobs(v);
      const hb = all.find((j) => j.type === 'ceo.heartbeat' && all.some((c) => c.parent === j.id && c.type === 'board.premortem'))!;
      const note = v.readNoteOrNull(`Decisions/premortem-${hb.id}.md`)!;
      expect(DecisionFrontmatter.parse(note.data).status).toBe('proposed');
      expect(note.body).toContain('growth objective has no metric');
    } finally { v.close(); await d.stop(); }
  }, TEST_MS);
});

describe('board advisors each speak at their own charter\'s model_tier (Task 4 review finding 1)', () => {
  // Ruling S-5: the whole board — chair included — sits on the medium tier. One session is four calls on top of
  // the plan, and the free strong tier is 20 calls a day per flash model: it is the CEO's plan and the owner's
  // replies that spend it. What this suite still guards is that each advisor speaks at its *own* charter's tier.
  it('asks every advisor, and the chair, at the board\'s own medium tier rather than the strong one', async () => {
    const llm = tierRecordingLlm();
    const vault = Vault.open(dir);
    try {
      const org = loadOrg(vault);
      expect(org.roles.advisor_investor.model_tier).toBe('medium');
      expect(org.roles.advisor_customer.model_tier).toBe('medium');
      expect(org.roles.advisor_skeptic.model_tier).toBe('medium');
      expect(org.roles.ceo.model_tier).toBe('strong');   // the tier the board is not spending
      await runBoardSession({ vault, llm }, org, PLAN_TEXT);
      const advisorCalls = llm.calls.filter((c) => /Imagine the cycle has already failed/.test(c.prompt));
      const tierOf = (roleId: string) => advisorCalls.find((c) => c.roleId === roleId)?.tier;
      expect(tierOf('advisor_investor')).toBe('medium');
      expect(tierOf('advisor_customer')).toBe('medium');
      expect(tierOf('advisor_skeptic')).toBe('medium');
      const chairCall = llm.calls.find((c) => /VERDICT: pass/.test(c.prompt));
      expect(chairCall?.roleId).toBe('advisor_skeptic');
      expect(chairCall?.tier).toBe('medium');
      expect(llm.calls.some((c) => c.tier === 'strong')).toBe(false);
    } finally { vault.close(); }
  });

  it('falls back to the board lead\'s tier, then medium, when an advisor\'s own model_tier is missing (Task 4 review finding 1)', async () => {
    const llm = tierRecordingLlm();
    const vault = Vault.open(dir);
    try {
      const org = loadOrg(vault);
      // Simulate a role note with no model_tier of its own — org.roles is a plain in-memory object here, not
      // backed by the file, so this does not touch the vault. The lead is given a distinct tier for the same
      // reason: with the whole board on medium, a fallback to the lead and a fallback to the bare default look
      // the same, and this test is about which one happened.
      org.roles.advisor_skeptic = { ...org.roles.advisor_skeptic, model_tier: 'strong' };
      const { model_tier: _drop, ...withoutTier } = org.roles.advisor_investor;
      org.roles.advisor_investor = withoutTier as typeof org.roles.advisor_investor;
      await runBoardSession({ vault, llm }, org, PLAN_TEXT);
      const advisorCalls = llm.calls.filter((c) => /Imagine the cycle has already failed/.test(c.prompt));
      // advisor_investor has no tier of its own, so it falls back to the lead's ('strong'), not to a bare default.
      expect(advisorCalls.find((c) => c.roleId === 'advisor_investor')?.tier).toBe('strong');
      // …and an advisor that does carry one keeps it.
      expect(advisorCalls.find((c) => c.roleId === 'advisor_customer')?.tier).toBe('medium');
    } finally { vault.close(); }
  });
});

describe('board advisors are de-duplicated (Task 4 review MINOR 4)', () => {
  it('asks a lead listed among the board members only once', async () => {
    const llm = tierRecordingLlm();
    const vault = Vault.open(dir);
    try {
      const org = loadOrg(vault);
      org.teams.board = { ...org.teams.board, members: [org.teams.board.lead, ...org.teams.board.members] };
      const session = await runBoardSession({ vault, llm }, org, PLAN_TEXT);
      expect(session.advisors).toEqual(['advisor_skeptic', 'advisor_investor', 'advisor_customer']);
      const advisorAsksOf = (roleId: string) => llm.calls.filter((c) => c.roleId === roleId && /Imagine the cycle has already failed/.test(c.prompt)).length;
      expect(advisorAsksOf('advisor_skeptic')).toBe(1);
    } finally { vault.close(); }
  });
});

describe('a board where every model call fails does not read as a clean pre-mortem (Task 4 review finding 2)', () => {
  const throwingLlm: Llm = {
    async chat() { throw new Error('no model available'); },
    promptBudget: () => 6000,
  };

  it('runBoardSession reports zero advisors answered, and fails open to pass', async () => {
    const vault = Vault.open(dir);
    try {
      const org = loadOrg(vault);
      const session = await runBoardSession({ vault, llm: throwingLlm }, org, PLAN_TEXT);
      expect(session.answered).toBe(0);
      expect(session.verdict).toBe('pass');
    } finally { vault.close(); }
  });

  // Its one caller guards on the board room first, but it is exported and tests call it directly — an org with
  // no board must fail open like every other board path, not with a TypeError (final review M5).
  it('an org with no board room passes unreviewed instead of throwing', async () => {
    const vault = Vault.open(dir);
    try {
      const org = loadOrg(vault);
      const noBoard = { ...org, teams: Object.fromEntries(Object.entries(org.teams).filter(([id]) => id !== 'board')) };
      const session = await runBoardSession({ vault, llm: throwingLlm }, noBoard, PLAN_TEXT);
      expect(session).toMatchObject({ verdict: 'pass', findings: [], advisors: [], answered: 0 });
    } finally { vault.close(); }
  });

  it('writeBoardPremortemDecision writes "no advisor answered" rather than "the plan survived the pre-mortem" when answered is 0', async () => {
    const vault = Vault.open(dir);
    try {
      const org = loadOrg(vault);
      const session = await runBoardSession({ vault, llm: throwingLlm }, org, PLAN_TEXT);
      writeBoardPremortemDecision(vault, 'job_hb1', 'job_board1', session.verdict, session.findings, org.teams.board.lead, new Date(), session.answered);
      const note = vault.readNoteOrNull('Decisions/premortem-job_hb1.md')!;
      expect(note.body).toContain(BOARD_UNREVIEWED_NOTE);
      expect(note.body).not.toContain('The plan survived the pre-mortem.');
      expect(note.body).not.toContain('The board found nothing in this plan likely to sink the cycle.');
    } finally { vault.close(); }
  });

  it('the heartbeat emits daemon.warning { where: "board_premortem" } when no advisor answered', async () => {
    const llm = orgLlm({ vetoes: 0, boardSilent: true });
    const d = daemonFor(llm);
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1);
      const warnings = v.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'board_premortem');
      expect(warnings.some((e) => e.payload.reason === BOARD_UNREVIEWED_NOTE)).toBe(true);
      const hb = listJobs(v).find((j) => j.type === 'ceo.heartbeat')!;
      const note = v.readNoteOrNull(`Decisions/premortem-${hb.id}.md`)!;
      expect(note.body).toContain(BOARD_UNREVIEWED_NOTE);
      expect(note.body).not.toContain('The plan survived the pre-mortem.');
    } finally { v.close(); await d.stop(); }
  }, TEST_MS);
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
      await waitFor(() => v.events.count('heartbeat.completed') >= 1);
      const runs = v.list('Runs', { ext: '.md' }).sort();
      const brief = readFileSync(path.join(dir, runs.at(-1)!), 'utf8');
      const facts = brief.split('_Facts used:_')[1] ?? '';
      expect(facts).toContain(`Decide on ${id}`);
      expect(facts).toContain('cto may not schedule cto');
      expect(facts).toContain('status: queued');
    } finally { v.close(); await d.stop(); }
  }, TEST_MS);
});

describe('division planning (spec item 3)', () => {
  it('one division.plan per division named in the plan, and none for the teams that do not plan', async () => {
    const plan = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### technology\n- Ship the first cut\n\n### revenue\n- Find the first organic channel\n\n### operations\n- Verify what shipped and write the lesson\n\n### security\n- Rotate the keys\n';
    const d = daemonFor(orgLlm({ vetoes: 0, plan }));
    await d.start();
    const v = Vault.open(dir);
    try {
      // Three divisions is the tightest case in the suite — several heartbeat round trips before the fan-out —
      // and it timed out at 54 s against the helper's 60 s default under load (Task 6 review, finding 2). Twice
      // the file's own budget, which is itself scaled by the machine's load.
      await planUntilFannedOut(d, v, 3);
      const plans = listJobs(v).filter((j) => j.type === 'division.plan');
      expect(plans.map((j) => j.assigned).sort()).toEqual(['cfo', 'coo', 'cto']);
      expect(listJobs(v).filter((j) => j.type === 'board.premortem')).toHaveLength(1);
      expect(v.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'division_plans' && /security/.test(String(e.payload.message)))).toBe(true);
      const goal = readJob(v, plans.find((j) => j.assigned === 'cto')!.id)!.body;
      expect(goal).toContain('Dev (lead dev_manager');
      expect(goal).toContain('backend_engineer');
    } finally { v.close(); await d.stop(); }
    // The per-case timeout is raised past the helper's budget on purpose: whichever gives up first should be
    // the helper, whose message says how many division plans it actually saw.
  }, TEST_MS);

  it('with the switch off — the shipped default — the plan waits for the owner, and no new work starts', async () => {
    const seed = Vault.open(dir);
    // Undo the beforeEach helper: this is the vault as it ships, where only the owner rules.
    seed.writeText('Memory/constitution.md', seed.readText('Memory/constitution.md').replace(/^board_decides_after_hours:.*$/m, 'board_decides_after_hours: 0'), 'owner');
    seed.close();
    const d = daemonFor(orgLlm({ vetoes: 0 }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1);
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
      await waitFor(() => listJobs(v).filter((j) => j.type === 'division.plan').length >= 2);
      expect(listJobs(v).filter((j) => j.type === 'company.plan')).toHaveLength(1);
    } finally { v.close(); await d.stop(); }
  }, TEST_MS);
});

describe('the fan-out is crash-idempotent (final review C1)', () => {
  /** `division_plans` needs no model: the goal text is assembled from the org and the plan. */
  const mute: Llm = { async chat() { throw new Error('the fan-out must not call a model'); }, promptBudget: () => 6000 };
  const FAN_OUT_PLAN = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### dev\n- Scaffold the site from Brand/\nprocess: launch\n\n### revenue\n- Find the first organic channel\n';
  const stateRel = (hbId: string) => path.join(dir, '.cubicle/jobs', `${hbId}.heartbeat.json`);
  /** Every job the fan-out makes: one division.plan per division, plus the `process:` expansion (same parent). */
  const fannedOut = (v: Vault, hbId: string) => listJobs(v).filter((j) => j.parent === hbId && j.type !== 'company.plan' && j.type !== 'board.premortem').map((j) => `${j.type}:${j.id}`).sort();

  it('a kill BEFORE the state write re-creates nothing: still one division.plan per division and one process expansion', async () => {
    const v = Vault.open(dir);
    try {
      v.writeText('Plans/plan.md', FAN_OUT_PLAN, 'ceo');
      const hbId = createHeartbeatJob(v, 'test');
      const verdict = createProposal(v, { id: planVerdictId(hbId), kind: 'plan_verdict', from: 'ceo', job: hbId, title: 'Approve this cycle\'s plan', body: 'The board passed this plan.' }, 'ceo');
      v.updateNote(verdict.path, (n) => ({ data: { ...n.data, approved: true, board_verdict: 'pass' }, body: n.body }), 'owner');
      updateJob(v, hbId, { checkpoint_step: HEARTBEAT_STEPS.indexOf('owner_verdict') }, 'daemon');

      const out = await runHeartbeat({ vault: v, llm: mute, env: {}, now: () => new Date() }, hbId);
      expect(out.status).toBe('blocked');
      const first = fannedOut(v, hbId);
      expect(first.filter((s) => s.startsWith('division.plan:'))).toHaveLength(2);   // dev → technology, revenue → revenue
      expect(first.filter((s) => !s.startsWith('division.plan:')).length).toBeGreaterThan(0);   // the `process: launch` steps

      // The kill, in the window the acceptance run never enters: every job note is on disk, but `state.divisionPlanJobs`
      // was never written and `blockMany` never set `blocked_on`, so the resume has neither the cache nor the
      // `blocked_on` recovery hook. Before the deterministic ids this queued the whole planning round a second time.
      const state = JSON.parse(readFileSync(stateRel(hbId), 'utf8'));
      delete state.divisionPlanJobs;
      writeFileSync(stateRel(hbId), JSON.stringify(state, null, 2));
      updateJob(v, hbId, { status: 'queued', checkpoint_step: HEARTBEAT_STEPS.indexOf('division_plans'), blocked_on: undefined }, 'daemon');

      const again = await runHeartbeat({ vault: v, llm: mute, env: {}, now: () => new Date() }, hbId);
      expect(again.status).toBe('blocked');
      expect(fannedOut(v, hbId)).toEqual(first);
    } finally { v.close(); }
  });
});

describe('the chief executive is an office, not the id `ceo` (final review I1/I2)', () => {
  /** Re-staff the seat the way an owner does: one line in the constitution's `offices:` block. */
  const restaff = (v: Vault, holder: string) => v.writeText('Memory/constitution.md', v.readText('Memory/constitution.md').replace(/^(\s*)chief_executive:.*$/m, `$1chief_executive: ${holder}`), 'owner');

  it('the company.plan job is stamped with the new holder and the new holder\'s team, not `ceo`/`executive`', async () => {
    const v = Vault.open(dir);
    try {
      restaff(v, 'coo');
      const hbId = createHeartbeatJob(v, 'test');
      updateJob(v, hbId, { checkpoint_step: HEARTBEAT_STEPS.indexOf('company_plan') }, 'daemon');
      const out = await runHeartbeat({ vault: v, llm: { async chat() { throw new Error('no model'); }, promptBudget: () => 6000 }, env: {}, now: () => new Date() }, hbId);
      expect(out.status).toBe('blocked');
      const plan = listJobs(v).find((j) => j.type === 'company.plan')!;
      expect(plan.assigned).toBe('coo');
      expect(plan.owner_role).toBe('coo');
      expect(plan.team).toBe('operations');   // the COO's own room, not the hard-coded `executive`
    } finally { v.close(); }
  });

  it('the chief executive speaks from the office holder\'s charter, not from Roles/ceo.md', async () => {
    const v = Vault.open(dir);
    try {
      restaff(v, 'coo');
      // The old holder's charter is archived, exactly as `applyFire`/a re-staff leaves it: reading it by name
      // would hand the new holder an empty charter.
      v.move('Roles/ceo.md', 'Roles/archive/ceo-2026-09-11.md', 'owner');
      const prompts: { roleId: string; system: string }[] = [];
      const llm: Llm = { async chat(req: RouteRequest, chat: { messages: ChatMessage[] }) { prompts.push({ roleId: req.roleId ?? '?', system: String(chat.messages[0]?.content ?? '') }); throw new Error('no model'); }, promptBudget: () => 6000 };
      const hbId = createHeartbeatJob(v, 'test');
      updateJob(v, hbId, { checkpoint_step: HEARTBEAT_STEPS.indexOf('brief') }, 'daemon');
      await runHeartbeat({ vault: v, llm, env: {}, now: () => new Date() }, hbId);
      expect(prompts.length).toBeGreaterThan(0);
      expect(prompts.every((p) => p.roleId === 'coo')).toBe(true);
      expect(prompts[0].system).toContain('# Your charter (COO)');
      expect(prompts[0].system).toContain(readFileSync(path.join(dir, 'Roles/coo.md'), 'utf8').split('---').slice(2).join('---').trim().split('\n')[0]);
    } finally { v.close(); }
  });
});

const IDEA_SUBJECT = { kind: 'idea' as const, text: '# Meal kits\n\n## Score\n\n46 of 60', title: 'Meal kits for nurseries', slug: 'meal-kits' };

describe('one board session, two subjects (spec §3)', () => {
  it("reads a bare string as this cycle's plan, so SP2's callers are unchanged", () => {
    expect(boardSubject(PLAN_TEXT)).toEqual({ kind: 'plan', text: PLAN_TEXT, title: "this cycle's plan" });
    expect(boardSubject(IDEA_SUBJECT)).toBe(IDEA_SUBJECT);
  });

  it('keeps the pre-mortem wording the plan path already has', () => {
    expect(advisorPrompt(boardSubject(PLAN_TEXT))).toContain('Imagine the cycle has already failed');
    expect(advisorPrompt(boardSubject(PLAN_TEXT))).toContain(PLAN_TEXT);
    expect(chairPrompt(boardSubject(PLAN_TEXT), 't')).toContain('VERDICT: pass');
    expect(chairPrompt(boardSubject(PLAN_TEXT), 't')).toContain('would waste the cycle');
  });

  it('asks a different question of an idea, and says who decides', () => {
    expect(advisorPrompt(IDEA_SUBJECT)).toContain('Pressure test it the way Paul Graham reads a YC application');
    expect(advisorPrompt(IDEA_SUBJECT)).toContain('Three Fatal Flaws');
    expect(advisorPrompt(IDEA_SUBJECT)).not.toContain('Imagine the cycle has already failed');
    expect(chairPrompt(IDEA_SUBJECT, 'advisors said things')).toContain('the owner does');
    expect(boardAgenda(IDEA_SUBJECT)).toBe('Idea review: Meal kits for nurseries');
    expect(boardAgenda(boardSubject(PLAN_TEXT))).toContain('Pre-mortem');
  });

  // The scripted models in scripts/lib/org-llm.ts route the board's calls on the words of the last prompt, and
  // both chairs ask for the same verdict line — so the only thing keeping an idea session from spending the
  // plan's scripted veto is that each chair prompt names its own subject. Assert the phrases, not the routing.
  it('names its own subject in the chair prompt, so a scripted board can tell the two apart', () => {
    expect(chairPrompt(boardSubject(PLAN_TEXT), 't')).toContain('this plan');
    expect(chairPrompt(boardSubject(PLAN_TEXT), 't')).not.toContain('this idea');
    expect(chairPrompt(IDEA_SUBJECT, 't')).toContain('this idea');
    expect(chairPrompt(IDEA_SUBJECT, 't')).not.toContain('this plan');
  });

  it('truncates a very long subject rather than blowing the prompt budget', () => {
    const huge = { kind: 'idea' as const, text: 'x'.repeat(9000), title: 'Huge', slug: 'huge' };
    expect(advisorPrompt(huge).length).toBeLessThan(5000);
  });

  it('lights the board room for the plan pre-mortem as well as for an idea (spec §6.1)', async () => {
    const llm = tierRecordingLlm();
    const vault = Vault.open(dir);
    try {
      const org = loadOrg(vault);
      await runBoardSession({ vault, llm }, org, PLAN_TEXT);
      const opened = vault.events.query({ types: ['meeting.opened'] }).at(-1)!;
      expect(opened.payload.room).toBe('board');
      expect(opened.payload.subject).toBe('plan');
      expect(opened.payload.participants).toEqual(['advisor_skeptic', 'advisor_investor', 'advisor_customer']);
      expect(vault.events.query({ types: ['meeting.turn'] }).length).toBe(3);
      const closed = vault.events.query({ types: ['meeting.closed'] }).at(-1)!;
      expect(closed.payload.id).toBe(opened.payload.id);
      expect(closed.payload.verdict).toBe('pass');
      // A board session is not a unit of work: the job note is the record, and the viewer keys the board room
      // on the event, so neither end of the meeting carries a job (spec §6.2).
      expect(opened.job).toBe(null);
      expect(closed.job).toBe(null);

      const before = llm.calls.length;
      const ideaSession = await runBoardSession({ vault, llm }, org, IDEA_SUBJECT);
      // Three advisors and one chair, and no more: the chair answered in the form it was asked for, so the one
      // re-ask SP5b allows is not spent and the heartbeat's model budget is exactly what it was.
      expect(ideaSession.calls).toBe(4);
      expect(ideaSession.reasked).toBe(false);
      expect(ideaSession.pressure).toBe('STRONG');
      expect(llm.calls.length - before).toBe(4);
      const idea = vault.events.query({ types: ['meeting.opened'] }).at(-1)!;
      expect(idea.payload.subject).toBe('idea');
      expect(idea.payload.title).toBe('Meal kits for nurseries');
      expect(idea.payload.agenda).toContain('Idea review');
      // Two sessions, two ids — the viewer must never close the wrong meeting.
      expect(idea.payload.id).not.toBe(opened.payload.id);
    } finally { vault.close(); }
  });

  // The no-board path returns before any advisor is asked, so the room must stay dark rather than showing a
  // meeting that never opens a chair (M5).
  it('emits nothing when there is no board room to sit in', async () => {
    const vault = Vault.open(dir);
    try {
      const org = loadOrg(vault);
      const noBoard = { ...org, teams: Object.fromEntries(Object.entries(org.teams).filter(([id]) => id !== 'board')) };
      const session = await runBoardSession({ vault, llm: tierRecordingLlm() }, noBoard, IDEA_SUBJECT);
      expect(session.subject).toBe(IDEA_SUBJECT);
      expect(vault.events.query({ types: ['meeting.opened'] }).length).toBe(0);
    } finally { vault.close(); }
  });
});

describe('a plan may draw only on ideas the company kept (spec §4.2)', () => {
  const planNaming = (slug: string) => `---\ncycle: 1\nupdated: ${new Date().toISOString()}\n---\n# Plan\n\n## Objectives\n\n### dev\n- Ship [[Ideas/${slug}]] this cycle\n`;
  const hbState = (hbId: string) => JSON.parse(readFileSync(path.join(dir, '.cubicle/jobs', `${hbId}.heartbeat.json`), 'utf8'));

  it('the board returns a plan that draws on a scrapped idea before any advisor speaks, and lets a kept one through', async () => {
    const v = Vault.open(dir);
    try {
      const slug = writeIdeaCard(v, { title: 'Crypto loyalty', source: 'discovery' }, 'research_manager');
      updateIdea(v, slug, { score_inputs: { value: 1, evidence: 1, effort: 1, fit: 1 }, decision: 'scrap' }, 'daemon');
      v.writeText('Plans/plan.md', planNaming(slug), 'ceo');

      const llm = tierRecordingLlm();
      const hbId = createHeartbeatJob(v, 'test');
      updateJob(v, hbId, { checkpoint_step: HEARTBEAT_STEPS.indexOf('board_premortem') }, 'daemon');
      const out = await runHeartbeat({ vault: v, llm, env: {}, now: () => new Date() }, hbId);

      // The guard costs nothing: it is arithmetic, and it runs before a single advisor is asked.
      expect(llm.calls.length).toBe(0);
      expect(out.status).toBe('requeued');
      const vetoed = v.events.query({ types: ['plan.vetoed'] });
      expect(vetoed).toHaveLength(1);
      expect(vetoed[0].payload.reason).toBe('unkept ideas');
      expect(String((vetoed[0].payload.findings as string[])[0])).toContain(`[[Ideas/${slug}]]`);
      expect(vetoed[0].payload.vetoes).toBe(1);
      expect(hbState(hbId).vetoes).toBe(1);

      // The cycle owes a pre-mortem note whether or not the board sat, and it names the idea and the ruling.
      const note = v.readNoteOrNull(`Decisions/premortem-${hbId}.md`)!;
      expect(note.data.status).toBe('proposed');
      expect(note.body).toContain(`[[Ideas/${slug}]]`);
      expect(note.body).toContain('scrapped');

      // Back to the CEO to write a different plan — not on to the owner, and not two steps back.
      const after = readJob(v, hbId)!.data;
      expect(after.status).toBe('queued');
      expect(after.checkpoint_step).toBe(HEARTBEAT_STEPS.indexOf('company_plan'));
      expect(hbState(hbId).boardFindings[0]).toContain('A plan may only draw on kept ideas.');

      // Keep the same idea and the same plan is the board's business again: the advisors get to speak.
      updateIdea(v, slug, { decision: 'keep' }, 'owner');
      const hb2 = createHeartbeatJob(v, 'test');
      updateJob(v, hb2, { checkpoint_step: HEARTBEAT_STEPS.indexOf('board_premortem') }, 'daemon');
      await runHeartbeat({ vault: v, llm, env: {}, now: () => new Date() }, hb2);
      expect(llm.calls.length).toBeGreaterThan(0);
      expect(v.events.count('plan.vetoed')).toBe(1);
    } finally { v.close(); }
  });

  it('a rewrite that still names the scrapped idea goes to the owner, not round again (review T10, finding 5)', async () => {
    const v = Vault.open(dir);
    try {
      const slug = writeIdeaCard(v, { title: 'Crypto loyalty', source: 'discovery' }, 'research_manager');
      updateIdea(v, slug, { score_inputs: { value: 1, evidence: 1, effort: 1, fit: 1 }, decision: 'scrap' }, 'daemon');
      v.writeText('Plans/plan.md', planNaming(slug), 'ceo');

      const llm = tierRecordingLlm();
      const hbId = createHeartbeatJob(v, 'test');
      updateJob(v, hbId, { checkpoint_step: HEARTBEAT_STEPS.indexOf('board_premortem') }, 'daemon');
      expect((await runHeartbeat({ vault: v, llm, env: {}, now: () => new Date() }, hbId)).status).toBe('requeued');

      // The CEO's one rewrite still leans on the same scrapped card, so the same heartbeat is back at the board
      // with its veto already counted. The board may not stall the company: this one goes to the owner.
      updateJob(v, hbId, { status: 'queued', checkpoint_step: HEARTBEAT_STEPS.indexOf('board_premortem'), blocked_on: undefined }, 'daemon');
      await runHeartbeat({ vault: v, llm, env: {}, now: () => new Date() }, hbId);

      expect(v.events.count('plan.vetoed')).toBe(2);
      expect(hbState(hbId).vetoes).toBe(2);
      expect(v.events.query({ types: ['proposal.created'] }).some((e) => e.payload.kind === 'message' && String(e.payload.title).toLowerCase().includes('veto'))).toBe(true);
      // Still no session either time: two returns, and not one advisor was asked.
      expect(listJobs(v).filter((j) => j.type === 'board.premortem')).toHaveLength(0);
      // …and the cycle walks on past the board rather than requeueing for ever.
      expect(readJob(v, hbId)!.data.checkpoint_step).toBeGreaterThan(HEARTBEAT_STEPS.indexOf('board_premortem'));
    } finally { v.close(); }
  });

  it('an undecided idea is a finding the CEO and the owner read, never a return (cycle one would deadlock)', async () => {
    const v = Vault.open(dir);
    try {
      const slug = writeIdeaCard(v, { title: 'B2B API', source: 'discovery' }, 'research_manager');
      v.writeText('Plans/plan.md', planNaming(slug), 'ceo');
      const llm = tierRecordingLlm();
      const hbId = createHeartbeatJob(v, 'test');
      updateJob(v, hbId, { checkpoint_step: HEARTBEAT_STEPS.indexOf('board_premortem') }, 'daemon');
      await runHeartbeat({ vault: v, llm, env: {}, now: () => new Date() }, hbId);

      expect(v.events.count('plan.vetoed')).toBe(0);
      expect(llm.calls.length).toBeGreaterThan(0);
      expect(hbState(hbId).boardFindings[0]).toContain('has not ruled on yet');
    } finally { v.close(); }
  });
});
