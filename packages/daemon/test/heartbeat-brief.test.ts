import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, listJobs, createJob, updateJob, createProposal, loadOrg, createStream, writeCiRecord } from '@cubicle/core';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig, mockedServices, mockedServicesRow, modelUseRows, isKeyProblemDowngrade, planningGate, divisionPlanGoal } from '../src/index.js';
import { orgLlm } from '../../../scripts/lib/org-llm.js';
import { letTheBoardDecide, planUntilFannedOut } from './helpers/board-switch.js';
import { TEST_MS, eventProgress, waitForProgress } from './helpers/load.js';

const root = path.resolve(__dirname, '../../..');
let dir: string;
/** "Has anything happened": the event log's JSONL mirror, appended to by every emitted event (helpers/load.ts). */
const progress = eventProgress(() => dir);
beforeEach(async () => {
  disposed = false;
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-brief-'));
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
const daemons: Daemon[] = [];
/** Set when teardown begins, so a poll loop from a case already given up on stops touching the vault. */
let disposed = false;
// Stop every daemon this test started before the vault it writes to is removed. A test body that vitest has
// already given up on (see TEST_MS) never reaches its own `finally`, so without this the daemon outlives the
// directory: its tick, its watcher and its workers keep writing to a path that is gone, which throws ENOENT
// storms attributed to whichever test is running next and starves that test of CPU until it times out too —
// one slow test used to take the rest of the file down with it.
afterEach(async () => {
  disposed = true;
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  // One turn of the loop, so a callback already queued behind those stops runs before the directory goes.
  await new Promise((r) => setImmediate(r));
  rmSync(dir, { recursive: true, force: true });
});

const NO_KEYS = { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv;
// A whole heartbeat cycle is ~16 model calls and a few dozen jobs; on a loaded machine that can pass 30 s. Both
// budgets are `helpers/load.ts`'s, read once for this file and scaled by the machine's 1-minute load: a fixed
// ceiling is what made this file and planning.test.ts fail on a busy box and pass on an idle one. `TEST_MS`
// leaves room for `waitFor`'s own budget to expire first, so a stuck test fails inside its `try` and still runs
// the `finally` that stops the daemon.
//
// Every assertion below reads the vault while the daemon is still running, and describes the vault after exactly
// the heartbeat(s) the test asked for. The `jobsCompletedN` trigger (spec §8) breaks that: the first heartbeat's
// own cycle queues real work jobs, and once five of them finish — ~300 ms after `heartbeat.completed`, i.e. inside
// `waitFor`'s 100 ms poll gap — the daemon queues a second heartbeat, which writes a second brief and a second
// company.plan. Whether a test saw one or two was a coin flip decided by machine load, which is why a different
// test failed on every run. The cadence rule itself is correct and is covered by daemon.test.ts ("planning and gate
// sub-jobs ... never retrigger a second heartbeat on their own"); here we disable it so the heartbeat count is the
// test's to control: one on startup, plus any explicit `requestHeartbeat`.
const ONE_HEARTBEAT_AT_A_TIME = { maxElapsedHours: 6, jobsCompletedN: Number.MAX_SAFE_INTEGER, startupAwayHours: 1 };
const daemonFor = (llm: Llm, env: NodeJS.ProcessEnv = NO_KEYS) => {
  const d = new Daemon(defaultConfig(dir, env, { port: 0, tickMs: 300, maxConcurrentJobs: 3, heartbeat: ONE_HEARTBEAT_AT_A_TIME, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined });
  daemons.push(d);
  return d;
};
/**
 * Poll a condition on real timers, failing only when the daemon has written nothing for the stall budget
 * (`helpers/load.ts`). The ceiling this used to carry was scaled by a load read at import, which under
 * `pnpm -r test` is the one moment that still looks idle; watching the event log needs no such guess.
 */
async function waitFor(pred: () => boolean, what = 'a condition'): Promise<void> {
  await waitForProgress(pred, { progress, torn: () => disposed, what });
}
const lastBrief = (v: Vault) => readFileSync(path.join(dir, v.list('Runs', { ext: '.md' }).sort().at(-1)!), 'utf8');
const factsOf = (brief: string) => brief.split('_Facts used:_')[1] ?? '';

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const planOn = (updated: string) => `---\nupdated: "${updated}"\ncycle: 3\n---\n# Plan\n\n## Objectives\n\n### dev\n- Ship the staging branch\n\n### revenue\n- Run the second outreach iteration\n\n### security\n- Verify the outreach iteration\n`;
const seedRouterCalls = (v: Vault, downgraded: number, cloud: number) => {
  for (let i = 0; i < downgraded; i++) v.events.emit({ type: 'router.call', agent: 'ceo', payload: { provider: 'ollama', model: 'qwen2.5:7b', tier: 'local', tokens: { prompt_tokens: 1, completion_tokens: 1 }, tools: 'json', downgraded: true } });
  for (let i = 0; i < cloud; i++) v.events.emit({ type: 'router.call', agent: 'ceo', payload: { provider: 'gemini', model: 'gemini-3.5-flash', tier: 'strong', tokens: { prompt_tokens: 1, completion_tokens: 1 }, tools: 'native', downgraded: false } });
};

describe('degraded-mode row (the team ran on the local model)', () => {
  it('modelUseRows: a fact line always; a needs-you row only from 5 calls with at least half downgraded, naming the cause', () => {
    expect(modelUseRows({ calls: 0, downgraded: 0 }, false)).toEqual({ fact: 'Model use: 0 calls, 0 downgraded to local', needsYou: null });
    expect(modelUseRows({ calls: 4, downgraded: 4 }, true).needsYou).toBeNull();         // too few calls to call it a pattern
    expect(modelUseRows({ calls: 10, downgraded: 4 }, true).needsYou).toBeNull();        // under half
    expect(modelUseRows({ calls: 6, downgraded: 3 }, true).needsYou).toBe('- The team ran mostly on the local model (3 of 6 calls downgraded): no cloud provider has an API key. Check API keys in .env (`cubicle doctor`) and Metrics/quota.md');
    expect(modelUseRows({ calls: 6, downgraded: 6 }, false).needsYou).toBe('- The team ran mostly on the local model (6 of 6 calls downgraded): cloud models were rate-limited or cooling. Check API keys in .env (`cubicle doctor`) and Metrics/quota.md');
  });

  it('a heartbeat whose window was mostly downgraded router.call events puts the row in the brief, with the no-key reason when no cloud provider has a key', async () => {
    const seed = Vault.open(dir); seedRouterCalls(seed, 5, 1); seed.close();
    const d = daemonFor(orgLlm({ vetoes: 0 }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1);
      const facts = factsOf(lastBrief(v));
      expect(facts).toContain('Model use: 6 calls, 5 downgraded to local');
      expect(facts).toContain('(5 of 6 calls downgraded): no cloud provider has an API key');
    } finally { v.close(); await d.stop(); }
  }, TEST_MS);

  it('with cloud keys present the same pattern is blamed on rate limits / cooling; a mostly-cloud window adds no row', async () => {
    const seed = Vault.open(dir); seedRouterCalls(seed, 3, 3); seed.close();
    const d = daemonFor(orgLlm({ vetoes: 0 }), { ...NO_KEYS, GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', OPENROUTER_API_KEY: 'o' });
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1);
      const facts = factsOf(lastBrief(v));
      expect(facts).toContain('(3 of 6 calls downgraded): cloud models were rate-limited or cooling');
    } finally { v.close(); await d.stop(); }
    const seed2 = Vault.open(dir); seedRouterCalls(seed2, 1, 9); seed2.close();
    const d2 = daemonFor(orgLlm({ vetoes: 0 }), { ...NO_KEYS, GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', OPENROUTER_API_KEY: 'o' });
    await d2.start();
    const v2 = Vault.open(dir);
    try {
      d2.requestHeartbeat('test');
      await waitFor(() => v2.events.count('heartbeat.completed') >= 2);
      const facts = factsOf(lastBrief(v2));
      expect(facts).toContain('Model use: 10 calls, 1 downgraded to local');
      expect(facts).not.toContain('ran mostly on the local model');
    } finally { v2.close(); await d2.stop(); }
  }, TEST_MS);

  it('isKeyProblemDowngrade: a division-budget demotion is not a keys problem, only a cascade downgrade is', () => {
    expect(isKeyProblemDowngrade({ downgraded: true, reason: 'division budget' })).toBe(false);
    expect(isKeyProblemDowngrade({ downgraded: true, reason: 'cascade' })).toBe(true);
    expect(isKeyProblemDowngrade({ downgraded: true })).toBe(true);   // no reason at all still counts (the pre-budget shape)
    expect(isKeyProblemDowngrade({ downgraded: false, reason: 'division budget' })).toBe(false);
  });

  it('a window entirely demoted by division budget never trips "check your API keys" — that would blame the wrong thing', async () => {
    const seed = Vault.open(dir);
    for (let i = 0; i < 6; i++) {
      seed.events.emit({ type: 'router.call', agent: 'ceo', payload: { provider: 'gemini', model: 'gemini-3.5-flash', tier: 'cheap', tokens: { prompt_tokens: 1, completion_tokens: 1 }, tools: 'native', downgraded: true, reason: 'division budget' } });
    }
    seed.close();
    const d = daemonFor(orgLlm({ vetoes: 0 }), { ...NO_KEYS, GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', OPENROUTER_API_KEY: 'o' });
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1);
      const facts = factsOf(lastBrief(v));
      expect(facts).toContain('Model use: 6 calls, 0 downgraded to local');
      expect(facts).not.toContain('ran mostly on the local model');
    } finally { v.close(); await d.stop(); }
  }, TEST_MS);
});

describe('mock-mode stamp (simulated deploy/email/analytics)', () => {
  it('mockedServices reuses the adapters\' own mode selection, so the env-var names live in one place', () => {
    expect(mockedServices({})).toEqual(['deploy', 'email', 'analytics']);
    expect(mockedServices({ CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' })).toEqual(['email', 'analytics']);
    expect(mockedServices({ CLOUDFLARE_API_TOKEN: 't' })).toEqual(['deploy', 'email', 'analytics']); // half a key pair is still mock
    expect(mockedServices({ CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a', BREVO_API_KEY: 'b', BREVO_SENDER_EMAIL: 'e', GOATCOUNTER_CODE: 'c', GOATCOUNTER_API_TOKEN: 'g' })).toEqual([]);
  });
  it('mockedServicesRow names only the services that are actually mocked', () => {
    expect(mockedServicesRow(['deploy', 'email', 'analytics'])).toBe('- Deploy, email and analytics are simulated (no CLOUDFLARE_*/BREVO_*/GOATCOUNTER_* keys): nothing has reached a customer. See SETUP.md');
    expect(mockedServicesRow(['email', 'analytics'])).toBe('- Email and analytics are simulated (no BREVO_*/GOATCOUNTER_* keys): nothing has reached a customer. See SETUP.md');
    expect(mockedServicesRow(['deploy'])).toBe('- Deploy is simulated (no CLOUDFLARE_* keys): nothing has reached a customer. See SETUP.md');
    expect(mockedServicesRow([])).toBeNull();
  });
  it('the brief carries the stamp so "Verified site deployment" cannot stand unqualified', async () => {
    const d = daemonFor(orgLlm({ vetoes: 0 }), { ...NO_KEYS, CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' });
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1);
      const facts = factsOf(lastBrief(v));
      expect(facts).toContain('Outbound services: deploy live, email mock, analytics mock');
      expect(facts).toContain('- Email and analytics are simulated (no BREVO_*/GOATCOUNTER_* keys)');
    } finally { v.close(); await d.stop(); }
  }, TEST_MS);
});

describe('re-planning gate', () => {
  const base = { plan: planOn(today), now: new Date(), maxAgeDays: 3, openJobs: 2, ownerAsked: false, rewrite: false };
  it('skips only when the plan is fresh, substantive, has open work, and nobody asked for a change', () => {
    expect(planningGate(base)).toEqual({ skip: true, planDate: today });
    expect(planningGate({ ...base, plan: planOn(daysAgo(2)) }).skip).toBe(true);
    expect(planningGate({ ...base, plan: planOn(daysAgo(3)) }).skip).toBe(false);                 // age == max: stale
    expect(planningGate({ ...base, plan: planOn('') }).skip).toBe(false);                          // the template's empty stamp: age unknown
    expect(planningGate({ ...base, plan: planOn('last tuesday') }).skip).toBe(false);              // unparseable: age unknown
    expect(planningGate({ ...base, plan: planOn(daysAgo(-2)) }).skip).toBe(false);                 // a future stamp is not an age either
    expect(planningGate({ ...base, plan: '# Plan\n\n## Objectives\n\n### dev\n- Ship it\n' }).skip).toBe(false); // no frontmatter at all
    expect(planningGate({ ...base, plan: `---\nupdated: "${today}"\n---\n# Plan\n\n## Objectives\n\n### operations\n- Verify the site\n` }).skip).toBe(false); // not substantive
    expect(planningGate({ ...base, openJobs: 0 }).skip).toBe(false);
    expect(planningGate({ ...base, ownerAsked: true }).skip).toBe(false);
    expect(planningGate({ ...base, rewrite: true }).skip).toBe(false);                             // the Critic returned the plan: rewrite it
    expect(planningGate({ ...base, maxAgeDays: undefined }).skip).toBe(false);                     // gate disabled
    expect(planningGate({ ...base, maxAgeDays: 0 }).skip).toBe(false);
  });

  it('a fresh plan with open work: no company.plan/board/division.plan jobs this heartbeat, the brief says so', async () => {
    const seed = Vault.open(dir);
    seed.writeText('Plans/plan.md', planOn(today), 'ceo');
    // Open work from that plan: queued, but never runnable here because it depends on a job that is parked on the owner.
    const parked = createJob(seed, { type: 'engineer.ship', title: 'Staging branch', assigned: 'backend_engineer', priority: 3, goal: 'g' }, 'cto');
    updateJob(seed, parked, { status: 'blocked', blocked_on: { kind: 'owner', id: parked, since: new Date().toISOString() } }, 'cto');
    createJob(seed, { type: 'engineer.ship', title: 'Deploy staging', assigned: 'backend_engineer', priority: 3, goal: 'g', depends_on: [parked] }, 'cto');
    seed.close();
    const d = daemonFor(orgLlm({ vetoes: 0 }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1);
      const types = listJobs(v).map((j) => j.type);
      expect(types).not.toContain('company.plan');
      expect(types).not.toContain('board.premortem');
      expect(types).not.toContain('division.plan');
      expect(factsOf(lastBrief(v))).toContain(`Planning: skipped — the plan from ${today} stands and 1 job is still open`);
      expect(v.readText('Plans/plan.md')).toBe(planOn(today));
      expect(v.list('Plans/archive', { ext: '.md' })).toEqual([]); // nothing was archived because nothing was rewritten
    } finally { v.close(); await d.stop(); }
  }, TEST_MS);

  it('an unanswered owner message re-plans even against a fresh plan with open work; so does a stale plan, once the plan already written has been ruled on', async () => {
    const seed = Vault.open(dir);
    seed.writeText('Plans/plan.md', planOn(today), 'ceo');
    const parked = createJob(seed, { type: 'engineer.ship', title: 'Staging branch', assigned: 'backend_engineer', priority: 3, goal: 'g' }, 'cto');
    updateJob(seed, parked, { status: 'blocked', blocked_on: { kind: 'owner', id: parked, since: new Date().toISOString() } }, 'cto');
    createJob(seed, { type: 'engineer.ship', title: 'Deploy staging', assigned: 'backend_engineer', priority: 3, goal: 'g', depends_on: [parked] }, 'cto');
    createProposal(seed, { kind: 'message', from: 'owner', to: 'ceo', title: 'change', body: 'Drop the staging branch, ship straight to production.' }, 'owner');
    seed.close();
    const d = daemonFor(orgLlm({ vetoes: 0 }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1);
      expect(listJobs(v).filter((j) => j.type === 'company.plan')).toHaveLength(1);
      expect(factsOf(lastBrief(v))).not.toContain('Planning: skipped');
    } finally { v.close(); await d.stop(); }
    const d2 = daemonFor(orgLlm({ vetoes: 0 }));
    await d2.start();
    const v2 = Vault.open(dir);
    try {
      // Second heartbeat: the plan the first one wrote is still waiting for a verdict, so this cycle rules on it
      // and fans it out rather than writing over it (program design §4) — no second company.plan.
      d2.requestHeartbeat('test');
      await waitFor(() => v2.events.count('heartbeat.completed') >= 2);
      expect(listJobs(v2).filter((j) => j.type === 'company.plan')).toHaveLength(1);
      expect(listJobs(v2).filter((j) => j.type === 'division.plan').length).toBeGreaterThan(0);
      // Third heartbeat: nothing waits on a verdict any more and the plan orgLlm wrote has no `updated` stamp →
      // not fresh → re-plan.
      d2.requestHeartbeat('test');
      await waitFor(() => listJobs(v2).filter((j) => j.type === 'company.plan').length >= 2);
    } finally { v2.close(); await d2.stop(); }
  }, TEST_MS);
});

describe('division planning goals', () => {
  it('divisionPlanGoal names the rooms and everyone in the division, and tells a lead with nobody under it what to do instead', () => {
    const v = Vault.open(dir);
    try {
      const org = loadOrg(v);
      const tech = divisionPlanGoal(org, org.teams.technology, '- Ship it', 'none recorded', 'research_manager');
      expect(tech).toContain('Dev (lead dev_manager');
      expect(tech).toContain('QA (lead qa_lead');
      expect(tech).toContain('backend_engineer');
      expect(tech).not.toContain('has nobody under you');
      const alone = divisionPlanGoal(org, { ...org.teams.security, id: 'security' }, '- Rotate the keys', 'none recorded', 'research_manager');
      expect(alone).toContain('Your division has nobody under you');
      expect(alone).toContain('do not call scheduler.request for yourself');
    } finally { v.close(); }
  });

  it('a section for a team that does not hold a planning round warns instead of queueing a plan', async () => {
    const d = daemonFor(orgLlm({ vetoes: 0, plan: planOn('') }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await planUntilFannedOut(d, v, 2);
      const plans = listJobs(v).filter((j) => j.type === 'division.plan');
      expect(plans.map((j) => j.assigned).sort()).toEqual(['cfo', 'cto']);
      expect(v.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'division_plans' && /security/.test(String(e.payload.message)))).toBe(true);
    } finally { v.close(); await d.stop(); }
  }, TEST_MS);
});
