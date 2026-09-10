import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, listJobs, readJob, createJob, updateJob, createProposal, loadOrg } from '@cubicle/core';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig, mockedServices, mockedServicesRow, modelUseRows, planningGate, teamPlanGoal } from '../src/index.js';
import { orgLlm } from '../../../scripts/lib/org-llm.js';

const root = path.resolve(__dirname, '../../..');
let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-brief-'));
  const { vault } = await scaffoldVault(dir);
  vault.updateNote('Brand/name.md', (n) => ({ data: { ...n.data, name: 'PlateReady' }, body: n.body }), 'owner');
  vault.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NO_KEYS = { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv;
const daemonFor = (llm: Llm, env: NodeJS.ProcessEnv = NO_KEYS) => new Daemon(defaultConfig(dir, env, { port: 0, tickMs: 300, maxConcurrentJobs: 3, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined });
async function waitFor(pred: () => boolean, ms = 30000): Promise<void> { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); } }
const lastBrief = (v: Vault) => readFileSync(path.join(dir, v.list('Runs', { ext: '.md' }).sort().at(-1)!), 'utf8');
const factsOf = (brief: string) => brief.split('_Facts used:_')[1] ?? '';

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const planOn = (updated: string) => `---\nupdated: "${updated}"\ncycle: 3\n---\n# Plan\n\n## Objectives\n\n### engineering\n- Ship the staging branch\n\n### growth\n- Run the second outreach iteration\n\n### operations\n- Verify the outreach iteration\n`;
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
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      const facts = factsOf(lastBrief(v));
      expect(facts).toContain('Model use: 6 calls, 5 downgraded to local');
      expect(facts).toContain('(5 of 6 calls downgraded): no cloud provider has an API key');
    } finally { v.close(); await d.stop(); }
  });

  it('with cloud keys present the same pattern is blamed on rate limits / cooling; a mostly-cloud window adds no row', async () => {
    const seed = Vault.open(dir); seedRouterCalls(seed, 3, 3); seed.close();
    const d = daemonFor(orgLlm({ vetoes: 0 }), { ...NO_KEYS, GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', OPENROUTER_API_KEY: 'o' });
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      const facts = factsOf(lastBrief(v));
      expect(facts).toContain('(3 of 6 calls downgraded): cloud models were rate-limited or cooling');
    } finally { v.close(); await d.stop(); }
    const seed2 = Vault.open(dir); seedRouterCalls(seed2, 1, 9); seed2.close();
    const d2 = daemonFor(orgLlm({ vetoes: 0 }), { ...NO_KEYS, GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', OPENROUTER_API_KEY: 'o' });
    await d2.start();
    const v2 = Vault.open(dir);
    try {
      d2.requestHeartbeat('test');
      await waitFor(() => v2.events.count('heartbeat.completed') >= 2, 60000);
      const facts = factsOf(lastBrief(v2));
      expect(facts).toContain('Model use: 10 calls, 1 downgraded to local');
      expect(facts).not.toContain('ran mostly on the local model');
    } finally { v2.close(); await d2.stop(); }
  });
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
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      const facts = factsOf(lastBrief(v));
      expect(facts).toContain('Outbound services: deploy live, email mock, analytics mock');
      expect(facts).toContain('- Email and analytics are simulated (no BREVO_*/GOATCOUNTER_* keys)');
    } finally { v.close(); await d.stop(); }
  });
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
    expect(planningGate({ ...base, plan: '# Plan\n\n## Objectives\n\n### engineering\n- Ship it\n' }).skip).toBe(false); // no frontmatter at all
    expect(planningGate({ ...base, plan: `---\nupdated: "${today}"\n---\n# Plan\n\n## Objectives\n\n### operations\n- Verify the site\n` }).skip).toBe(false); // not substantive
    expect(planningGate({ ...base, openJobs: 0 }).skip).toBe(false);
    expect(planningGate({ ...base, ownerAsked: true }).skip).toBe(false);
    expect(planningGate({ ...base, rewrite: true }).skip).toBe(false);                             // the Critic returned the plan: rewrite it
    expect(planningGate({ ...base, maxAgeDays: undefined }).skip).toBe(false);                     // gate disabled
    expect(planningGate({ ...base, maxAgeDays: 0 }).skip).toBe(false);
  });

  it('a fresh plan with open work: no company.plan/critic/team.plan jobs this heartbeat, the brief says so', async () => {
    const seed = Vault.open(dir);
    seed.writeText('Plans/plan.md', planOn(today), 'ceo');
    // Open work from that plan: queued, but never runnable here because it depends on a job that is parked on the owner.
    const parked = createJob(seed, { type: 'engineer.ship', title: 'Staging branch', assigned: 'engineer', priority: 3, goal: 'g' }, 'cto');
    updateJob(seed, parked, { status: 'blocked', blocked_on: { kind: 'owner', id: parked, since: new Date().toISOString() } }, 'cto');
    createJob(seed, { type: 'engineer.ship', title: 'Deploy staging', assigned: 'engineer', priority: 3, goal: 'g', depends_on: [parked] }, 'cto');
    seed.close();
    const d = daemonFor(orgLlm({ vetoes: 0 }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      const types = listJobs(v).map((j) => j.type);
      expect(types).not.toContain('company.plan');
      expect(types).not.toContain('critic.premortem');
      expect(types).not.toContain('team.plan');
      expect(factsOf(lastBrief(v))).toContain(`Planning: skipped — the plan from ${today} stands and 1 job is still open`);
      expect(v.readText('Plans/plan.md')).toBe(planOn(today));
      expect(v.list('Plans/archive', { ext: '.md' })).toEqual([]); // nothing was archived because nothing was rewritten
    } finally { v.close(); await d.stop(); }
  });

  it('an unanswered owner message re-plans even against a fresh plan with open work; so does a stale plan', async () => {
    const seed = Vault.open(dir);
    seed.writeText('Plans/plan.md', planOn(today), 'ceo');
    const parked = createJob(seed, { type: 'engineer.ship', title: 'Staging branch', assigned: 'engineer', priority: 3, goal: 'g' }, 'cto');
    updateJob(seed, parked, { status: 'blocked', blocked_on: { kind: 'owner', id: parked, since: new Date().toISOString() } }, 'cto');
    createJob(seed, { type: 'engineer.ship', title: 'Deploy staging', assigned: 'engineer', priority: 3, goal: 'g', depends_on: [parked] }, 'cto');
    createProposal(seed, { kind: 'message', from: 'owner', to: 'ceo', title: 'change', body: 'Drop the staging branch, ship straight to production.' }, 'owner');
    seed.close();
    const d = daemonFor(orgLlm({ vetoes: 0 }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      expect(listJobs(v).filter((j) => j.type === 'company.plan')).toHaveLength(1);
      expect(factsOf(lastBrief(v))).not.toContain('Planning: skipped');
    } finally { v.close(); await d.stop(); }
    // Second heartbeat: the owner message is answered, the plan orgLlm wrote has no `updated` stamp → not fresh → re-plan.
    const d2 = daemonFor(orgLlm({ vetoes: 0 }));
    await d2.start();
    const v2 = Vault.open(dir);
    try {
      d2.requestHeartbeat('test');
      await waitFor(() => v2.events.count('heartbeat.completed') >= 2, 60000);
      expect(listJobs(v2).filter((j) => j.type === 'company.plan')).toHaveLength(2);
    } finally { v2.close(); await d2.stop(); }
  });
});

describe('member-less team planning', () => {
  it('teamPlanGoal tells a lead with no members to plan work for themself via the CEO, never scheduler.request for themself', () => {
    const org = loadOrg(Vault.open(dir));
    const ops = org.teams.operations, eng = org.teams.engineering;
    expect(ops.members).toEqual([]);
    const opsGoal = teamPlanGoal(ops, '- Verify the outreach iteration', 'none recorded');
    const engGoal = teamPlanGoal(eng, '- Ship it', 'none recorded');
    const sentence = 'Your team has no members: plan work you will do yourself in follow-up jobs assigned to you by the CEO (ask with colleague.message), or request research from research_analyst; do not call scheduler.request for yourself.';
    expect(opsGoal).toContain(sentence);
    expect(opsGoal).toContain('for your members (none)');
    expect(engGoal).not.toContain(sentence);
    expect(engGoal).toContain('for your members (tech_lead, engineer, qa)');
    expect(engGoal).not.toContain('do the work yourself as a custom job');
  });

  it('the COO\'s team.plan job carries the sentence; the CTO\'s does not', async () => {
    const d = daemonFor(orgLlm({ vetoes: 0, plan: planOn('') }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      const plans = listJobs(v).filter((j) => j.type === 'team.plan');
      const goal = (role: string) => readJob(v, plans.find((j) => j.assigned === role)!.id)!.body.split('## Goal')[1].split('## Plan')[0];
      expect(plans.map((j) => j.assigned).sort()).toEqual(['coo', 'cto', 'head_of_growth']);
      expect(goal('coo')).toContain('Your team has no members');
      expect(goal('cto')).not.toContain('Your team has no members');
    } finally { v.close(); await d.stop(); }
  });
});
