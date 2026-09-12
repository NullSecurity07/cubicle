import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob, recordTrustVerdict, trustState, trustCleared, TRUST_GATES, TRUST_LOOKBACK } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, createRoleToolClient, phase3Tools, phase6Tools, policyFor, type ToolContext } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-trustgate-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const role = (id: string) => RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${id}.md`)).data);
const ctxFor = (roleId: string, jobId: string): ToolContext => ({
  vault, events: vault.events, roleId, role: role(roleId), jobId, config: cfg, env: {}, workspace: 'x',
  now: () => new Date(), scheduler: { enqueue: (j) => createJob(vault, j, roleId) },
});
/** Both offices cleared this exact call. The only thing that lets a leaving call run. */
const clear = (key: string) => { for (const gate of TRUST_GATES) recordTrustVerdict(vault, { key, proposal: 'prop_t', gate, verdict: 'pass', by: 'daemon' }); };
const client = (roleId: string, jobId: string) => createRoleToolClient(new ToolRegistry().registerAll([...phase3Tools({ includeMock: true }), ...phase6Tools()]).forRole(role(roleId), cfg), ctxFor(roleId, jobId));

describe('the tool layer is where the guarantee lives (spec §1, Decision 4)', () => {
  it('config/tools.yaml flags every tool that reaches somebody, and `mock.outbound` is not one', () => {
    for (const tool of ['email.send', 'social.post', 'browser.submit', 'stripe.payment_link', 'deploy.site']) {
      expect(policyFor(cfg, tool).trust_review, tool).toBe(true);
      expect(policyFor(cfg, tool).outbound, tool).toBe(true);   // trust_review implies outbound: the key is what the record is keyed on
    }
    expect(policyFor(cfg, 'mock.outbound').trust_review).toBe(false);
    expect(policyFor(cfg, 'vault.write').trust_review).toBe(false);
  });

  /**
   * The invariant, over the shipped config rather than over a list written by hand (I2). A sixth tool added to
   * `config/tools.yaml` with `outbound: true` and no `trust_review` would reach recipients with no review and
   * leave the whole suite green — `trustVeto` returns null for a policy that does not carry the flag. SP6 adds a
   * technology division and more tools, so this is the guard that keeps the guarantee true as the product grows.
   *
   * The converse matters as much: the harness only raises `auto` → `propose` when `policy.outbound`, and the
   * record is keyed on the idempotency key, which only an outbound tool gets — so a `trust_review` tool without
   * `outbound` would be refused by the tool layer in a loop the agent has no way out of.
   */
  it('`outbound` and `trust_review` imply each other in the shipped config, whatever tools it grows (I2)', () => {
    const names = Object.keys(cfg.tools);
    expect(names.length).toBeGreaterThan(10);                  // the config really was parsed
    for (const name of names) {
      const pol = policyFor(cfg, name);
      // `mock.outbound` is the one exception, and it is exempt by identity rather than by shape: it appends to
      // `.cubicle/` and reaches nobody (Decision 3), so it is outbound for the idempotency key alone.
      if (name === 'mock.outbound') continue;
      if (pol.outbound) expect(pol.trust_review, `${name} leaves the company, so it must carry trust_review: true`).toBe(true);
      if (pol.trust_review) expect(pol.outbound, `${name} is trust-reviewed, so it must carry outbound: true — the record is keyed on the idempotency key`).toBe(true);
    }
    expect(policyFor(cfg, 'mock.outbound').outbound).toBe(true);
    expect(policyFor(cfg, 'mock.outbound').trust_review).toBe(false);
  });

  it('email.send is refused before the handler runs, and no email is sent', async () => {
    const c = await client('cmo', 'job_e');
    try {
      const out = await c.call('email.send', { to: 'a@example.com', subject: 'hi', body: 'hello there' }, { idempotencyKey: 'job_e:1:2' });
      expect(out.ok).toBe(false);
      // The wrapper's own refusal, so the caller knows the handler provably never ran.
      expect(out.guardrailBlocked).toContain('email.send leaves the company');
      expect(vault.events.count('email.sent')).toBe(0);
      expect(vault.exists('Customers/_suppression.md')).toBe(true);    // scaffolded, not written by a send
      const blocked = vault.events.query({ types: ['guardrail.blocked'] }).at(-1)!;
      expect(blocked.payload).toMatchObject({ tool: 'email.send' });
      expect(String(blocked.payload.reason)).toContain('Nothing was sent');
    } finally { await c.close(); }
  });

  it('both offices cleared and it goes', async () => {
    const c = await client('cmo', 'job_e');
    try {
      clear('job_e:1:2');
      const out = await c.call('email.send', { to: 'a@example.com', subject: 'hi', body: 'hello there' }, { idempotencyKey: 'job_e:1:2' });
      expect(out.ok).toBe(true);
      expect(vault.events.count('email.sent')).toBe(1);
    } finally { await c.close(); }
  });

  it('a returned review is final: one pass and one return still send nothing', async () => {
    const c = await client('cmo', 'job_e');
    try {
      recordTrustVerdict(vault, { key: 'job_e:1:2', proposal: 'p', gate: 'office:security.review', verdict: 'pass', by: 'ciso' });
      recordTrustVerdict(vault, { key: 'job_e:1:2', proposal: 'p', gate: 'office:compliance.review', verdict: 'return', findings: ['no unsubscribe link in the body'], by: 'clo' });
      const out = await c.call('email.send', { to: 'a@example.com', subject: 'hi', body: 'hello there' }, { idempotencyKey: 'job_e:1:2' });
      expect(out.ok).toBe(false);
      expect(out.text).toContain('no unsubscribe link in the body');
      expect(vault.events.count('email.sent')).toBe(0);
    } finally { await c.close(); }
  });

  it('a leaving call with no idempotency key at all is refused, whoever makes it', async () => {
    const c = await client('cmo', 'job_e');
    try {
      clear('job_e:1:2');                                    // a cleared record for *another* call is not this call's
      const out = await c.call('email.send', { to: 'a@example.com', subject: 'hi', body: 'hello there' });
      expect(out.ok).toBe(false);
      expect(out.text).toContain('no filed proposal');
      expect(vault.events.count('email.sent')).toBe(0);
    } finally { await c.close(); }
  });

  it('a clearance for one call does not clear another', async () => {
    const c = await client('cmo', 'job_e');
    try {
      clear('job_e:1:2');
      expect((await c.call('email.send', { to: 'a@example.com', subject: 'hi', body: 'one' }, { idempotencyKey: 'job_e:1:2' })).ok).toBe(true);
      const second = await c.call('email.send', { to: 'b@example.com', subject: 'hi', body: 'two' }, { idempotencyKey: 'job_e:1:3' });
      expect(second.ok).toBe(false);
      expect(vault.events.count('email.sent')).toBe(1);
    } finally { await c.close(); }
  });

  it('a preview deploy needs no review; a live one does', async () => {
    mkdirSync(path.join(dir, 'Site/dist'), { recursive: true });
    writeFileSync(path.join(dir, 'Site/dist/index.html'), '<h1>v1</h1>');
    const c = await client('platform_engineer', 'job_d');
    try {
      expect((await c.call('deploy.site', { stage: 'preview' }, { idempotencyKey: 'job_d:1:1' })).ok).toBe(true);
      expect((await c.call('deploy.site', { stage: 'canary', metrics: ['error rate'] }, { idempotencyKey: 'job_d:1:2' })).ok).toBe(true);
      const live = await c.call('deploy.site', { stage: 'live', metrics: ['error rate'] }, { idempotencyKey: 'job_d:1:3' });
      expect(live.ok).toBe(false);
      expect(live.text).toContain('leaves the company');
      clear('job_d:1:4');
      expect((await c.call('deploy.site', { stage: 'live', metrics: ['error rate'] }, { idempotencyKey: 'job_d:1:4' })).ok).toBe(true);
    } finally { await c.close(); }
  });

  it('the mock outbound tool is untouched: it reaches nobody (Decision 3)', async () => {
    vault.updateNote('Roles/cmo.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), 'mock.outbound'] }, body: n.body }), 'owner');
    const c = await client('cmo', 'job_m');
    try {
      expect((await c.call('mock.outbound', { to: 'a@x', body: 'hi' }, { idempotencyKey: 'job_m:1:1' })).ok).toBe(true);
    } finally { await c.close(); }
  });

  it('an owner who sets a leaving tool to `never` still outranks a cleared record', async () => {
    vault.writeText('Memory/owner_preferences.md', '```yaml\napprovals:\n  email.send: never\n```\n', 'owner');
    const c = await client('cmo', 'job_e');
    try {
      clear('job_e:1:2');
      const out = await c.call('email.send', { to: 'a@example.com', subject: 'hi', body: 'hello there' }, { idempotencyKey: 'job_e:1:2' });
      expect(out.ok).toBe(false);
      expect(out.text).toContain('mode never');
      expect(vault.events.count('email.sent')).toBe(0);
    } finally { await c.close(); }
  });
});

/**
 * Coordinator ruling: no path may run a leaving tool on anything but this call's own two verdicts. A verdict is a
 * row in a log an agent cannot write, so these are not agent-reachable forgeries — they are the near misses a
 * real run produces: a verdict for the neighbouring call, an ordinary chain review that happens to share a gate
 * name, a gate that was never asked, and a clearance so old the bounded read no longer sees it.
 */
describe('only this call\'s own verdicts clear it', () => {
  const EMAIL = { to: 'a@example.com', subject: 'hi', body: 'hello there' };

  it('a verdict filed against another call — another proposal, another key — does not clear this one', async () => {
    const c = await client('cmo', 'job_e');
    try {
      for (const gate of TRUST_GATES) recordTrustVerdict(vault, { key: 'job_e:1:9', proposal: 'prop_other', gate, verdict: 'pass', by: 'daemon' });
      const out = await c.call('email.send', EMAIL, { idempotencyKey: 'job_e:1:2' });
      expect(out.ok).toBe(false);
      expect(out.text).toContain('leaves the company');
      expect(vault.events.count('email.sent')).toBe(0);
    } finally { await c.close(); }
  });

  it('an ordinary chain review carries no key, so it can never stand in for a trust verdict', async () => {
    const c = await client('cmo', 'job_e');
    try {
      // What `applyVerdict` emits when a *job's* security gate passes: same event type, same gate, no `key`.
      for (const gate of TRUST_GATES) vault.events.emit({ type: 'review.passed', agent: 'ciso', job: 'job_e', payload: { gate, findings: [] } });
      const out = await c.call('email.send', EMAIL, { idempotencyKey: 'job_e:1:2' });
      expect(out.ok).toBe(false);
      expect(out.text).toContain('leaves the company');
      expect(vault.events.count('email.sent')).toBe(0);
    } finally { await c.close(); }
  });

  it('one office is not both: a pass from only one gate, or from a gate nobody asked for, sends nothing', async () => {
    const c = await client('cmo', 'job_e');
    try {
      recordTrustVerdict(vault, { key: 'job_e:1:2', proposal: 'prop_t', gate: 'office:security.review', verdict: 'pass', by: 'ciso' });
      recordTrustVerdict(vault, { key: 'job_e:1:2', proposal: 'prop_t', gate: 'team:qa.review', verdict: 'pass', by: 'qa_lead' });
      const out = await c.call('email.send', EMAIL, { idempotencyKey: 'job_e:1:2' });
      expect(out.ok).toBe(false);
      expect(out.text).toContain('office:compliance.review');   // the one still outstanding, named
      expect(vault.events.count('email.sent')).toBe(0);
    } finally { await c.close(); }
  });

  it('a clearance older than the bounded read is expired, and the call is refused again', async () => {
    const c = await client('cmo', 'job_e');
    try {
      clear('job_e:1:2');
      // `trustState` reads the newest TRUST_LOOKBACK verdict rows. Push this call's two past that edge with the
      // verdicts of later calls: an expired clearance must fail closed, not fall through to a send.
      for (let i = 0; i < TRUST_LOOKBACK; i++) recordTrustVerdict(vault, { key: `job_z:1:${i}`, proposal: 'prop_z', gate: TRUST_GATES[i % TRUST_GATES.length], verdict: 'pass', by: 'daemon' });
      const out = await c.call('email.send', EMAIL, { idempotencyKey: 'job_e:1:2' });
      expect(out.ok).toBe(false);
      expect(out.text).toContain('leaves the company');
      expect(vault.events.count('email.sent')).toBe(0);
    } finally { await c.close(); }
  }, 60_000);

  it('the call that runs hands back its key, and running it does not spend the clearance', async () => {
    const c = await client('cmo', 'job_e');
    try {
      clear('job_e:1:2');
      const out = await c.call('email.send', EMAIL, { idempotencyKey: 'job_e:1:2' });
      expect(out.ok).toBe(true);
      // The at-most-once half: the key the harness writes into `side_effects_done` and skips on resume.
      expect(out.sideEffectKey).toBe('job_e:1:2');
      expect(vault.events.count('email.sent')).toBe(1);
      // The gate half: the tool layer records no verdict of its own, so a resumed attempt that re-checks reads
      // the same clearance instead of a spurious "the reviews are still out".
      expect(vault.events.count('review.passed')).toBe(TRUST_GATES.length);
      expect(trustCleared(trustState(vault.events, 'job_e:1:2'), TRUST_GATES)).toBe(true);
    } finally { await c.close(); }
  });

  it('a caller cannot assert its way past the gate: `call` varies the key and nothing else', async () => {
    const c = await client('cmo', 'job_e');
    try {
      // A config in which `email.send` owes no reviews — the one value that would make `trustVeto` return null.
      // Decision 4 refused `ToolContext.phase` because it would let a caller assert its way past the gate; the
      // override is the same capability by another name, so it may carry the idempotency key and nothing else.
      // The type says so, and the implementation ignores the rest whatever a JavaScript caller hands it.
      const permissive = parseToolsConfig('tools:\n  email.send: { mode: auto, outbound: true }\n');
      expect(policyFor(permissive, 'email.send').trust_review).toBe(false);
      const smuggled = { idempotencyKey: 'job_e:1:2', config: permissive } as unknown as { idempotencyKey?: string };
      const out = await c.call('email.send', EMAIL, smuggled);
      expect(out.ok).toBe(false);
      expect(out.guardrailBlocked).toContain('email.send leaves the company');
      expect(vault.events.count('email.sent')).toBe(0);
    } finally { await c.close(); }
  });
});
