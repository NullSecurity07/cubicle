import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { loadOrg, type Org } from '../src/org.js';
import { loadGates } from '../src/gates.js';
import {
  TRUST_GATES, TRUST_GATE_OFFICE, trustReviewsFor, trustState, trustCleared, recordTrustVerdict,
  trustReviewerFor, trustJobId, trustGateGoal, trustGateLabel, trustRefusal, trustRefusalNoKey, trustVeto,
  trustDecision, TRUST_ARGS_CHARS, type TrustCheckCtx,
} from '../src/trust.js';

const CFG = path.resolve(__dirname, '../../../config');
const both = [...TRUST_GATES];
const flagged = { trust_review: true };

describe('what leaves the company (spec §2)', () => {
  it('the flag decides, and the arguments refine it', () => {
    expect(trustReviewsFor(flagged, 'email.send', { to: 'a@x', body: 'hi' })).toEqual(both);
    expect(trustReviewsFor(flagged, 'social.post', { channel: 'hn', body: 'x' })).toEqual(both);
    expect(trustReviewsFor(flagged, 'browser.submit', {})).toEqual(both);
    expect(trustReviewsFor(flagged, 'stripe.payment_link', { amount: 1 })).toEqual(both);
    expect(trustReviewsFor(undefined, 'email.send', {})).toEqual([]);
    expect(trustReviewsFor({ trust_review: false }, 'mock.outbound', { to: 'a', body: 'b' })).toEqual([]);
  });

  it('a preview is not a publication, and a rollback is not a new send', () => {
    expect(trustReviewsFor(flagged, 'deploy.site', { stage: 'live', metrics: ['error rate'] })).toEqual(both);
    expect(trustReviewsFor(flagged, 'deploy.site', { stage: 'preview' })).toEqual([]);
    expect(trustReviewsFor(flagged, 'deploy.site', { stage: 'canary', canary_percent: 5 })).toEqual([]);
    expect(trustReviewsFor(flagged, 'deploy.site', {})).toEqual([]);            // the schema's own default
    expect(trustReviewsFor(flagged, 'deploy.site', { stage: 'live', rollback: true })).toEqual([]);
  });

  it('the shipped config flags exactly the tools that reach somebody', () => {
    const yaml = readFileSync(path.join(CFG, 'tools.yaml'), 'utf8');
    for (const tool of ['email.send', 'social.post', 'browser.submit', 'stripe.payment_link', 'deploy.site']) {
      expect(new RegExp(`^\\s+${tool.replace('.', '\\.')}:.*trust_review: true`, 'm').test(yaml), tool).toBe(true);
    }
    // mock.outbound appends to .cubicle/ and reaches nobody (Decision 3); flagging it would have made every
    // existing dispatcher and dormancy test a trust-review test by accident.
    expect(/^\s+mock\.outbound:.*trust_review/m.test(yaml)).toBe(false);
  });

  it('both gates have an entry and criteria in the owner\'s gate table', () => {
    const table = loadGates(path.join(CFG, 'gates.yaml'));
    for (const gate of both) {
      expect(table[gate], gate).toBeDefined();
      expect(table[gate].gates, gate).toEqual([]);                 // a review is not itself reviewed
      expect(table[gate].criteria.length, gate).toBeGreaterThan(40);
    }
    expect(table['office:compliance.review'].criteria).toMatch(/unsubscribe|consent|public/i);
    expect(TRUST_GATE_OFFICE['office:compliance.review']).toBe('compliance');
    expect(TRUST_GATE_OFFICE['office:security.review']).toBe('security');
  });
});

describe('the record is the event log (spec §4)', () => {
  let dir: string; let vault: Vault;
  const KEY = 'job_abc:1:4';
  beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-trust-')); vault = (await scaffoldVault(dir)).vault; });
  afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

  it('nothing recorded means both reviews are pending, not passed', () => {
    const st = trustState(vault.events, KEY);
    expect(st).toMatchObject({ passed: [], returned: [], pending: both });
    expect(trustCleared(st, both)).toBe(false);
    expect(trustRefusal('email.send', st)).toContain('runs only once');
    expect(trustRefusal('email.send', st)).toContain('Nothing was sent');
  });

  it('one pass is not a clearance; two are', () => {
    recordTrustVerdict(vault, { key: KEY, proposal: 'prop_1', gate: 'office:compliance.review', verdict: 'pass', by: 'clo' });
    let st = trustState(vault.events, KEY);
    expect(st.passed).toEqual(['office:compliance.review']);
    expect(st.pending).toEqual(['office:security.review']);
    expect(trustCleared(st, both)).toBe(false);
    recordTrustVerdict(vault, { key: KEY, proposal: 'prop_1', gate: 'office:security.review', verdict: 'pass', by: 'ciso' });
    st = trustState(vault.events, KEY);
    expect(st.passed).toEqual(both);
    expect(trustCleared(st, both)).toBe(true);
  });

  it('a return is the state, and it carries the findings the author has to fix', () => {
    recordTrustVerdict(vault, { key: KEY, proposal: 'prop_1', gate: 'office:security.review', verdict: 'pass', by: 'ciso' });
    recordTrustVerdict(vault, { key: KEY, proposal: 'prop_1', gate: 'office:compliance.review', verdict: 'return', findings: ['no unsubscribe link in the body'], by: 'clo' });
    const st = trustState(vault.events, KEY);
    expect(st.returned).toEqual(['office:compliance.review']);
    expect(st.findings).toEqual(['no unsubscribe link in the body']);
    expect(trustCleared(st, both)).toBe(false);
    expect(trustRefusal('email.send', st)).toContain('returned by office:compliance.review');
    expect(trustRefusal('email.send', st)).toContain('no unsubscribe link');
  });

  it('the newest verdict per gate wins, so a re-review can clear a return', () => {
    recordTrustVerdict(vault, { key: KEY, proposal: 'p', gate: 'office:compliance.review', verdict: 'return', findings: ['fix the claim'], by: 'clo' });
    recordTrustVerdict(vault, { key: KEY, proposal: 'p', gate: 'office:compliance.review', verdict: 'pass', by: 'clo' });
    recordTrustVerdict(vault, { key: KEY, proposal: 'p', gate: 'office:security.review', verdict: 'pass', by: 'ciso' });
    expect(trustCleared(trustState(vault.events, KEY), both)).toBe(true);
  });

  it('an ordinary chain review of another job is not a trust verdict, and neither is another call\'s', () => {
    // What `applyVerdict` emits for a medium-risk ship: the same gate name, no key.
    vault.events.emit({ type: 'review.passed', agent: 'ciso', job: 'job_other', payload: { gate: 'office:security.review', findings: [] } });
    recordTrustVerdict(vault, { key: 'job_zzz:1:2', proposal: 'p2', gate: 'office:compliance.review', verdict: 'pass', by: 'clo' });
    expect(trustState(vault.events, KEY).pending).toEqual(both);
    expect(trustState(vault.events, '').pending).toEqual(both);
  });

  it('the verdict is written where no agent can reach it, and nowhere else', () => {
    recordTrustVerdict(vault, { key: KEY, proposal: 'prop_1', gate: 'office:compliance.review', verdict: 'pass', job: 'job_rev', by: 'clo' });
    const e = vault.events.query({ types: ['review.passed'] }).at(-1)!;
    expect(e.agent).toBe('clo');
    expect(e.job).toBe('job_rev');
    expect(e.payload).toMatchObject({ gate: 'office:compliance.review', key: KEY, proposal: 'prop_1', trust: true });
    // Decision 18: no note under `00 Inbox/` was touched, so the owner's approval flag stays the owner's.
    expect(vault.events.query({ types: ['vault.wrote'], from: e.ts }).filter((w) => String(w.payload.path).startsWith('00 Inbox/'))).toEqual([]);
  });

  it('a long finding is cut rather than carried whole into the log', () => {
    recordTrustVerdict(vault, { key: KEY, proposal: 'p', gate: 'office:compliance.review', verdict: 'return', findings: Array.from({ length: 9 }, (_, i) => `${i}`.repeat(500)), by: 'clo' });
    const p = vault.events.query({ types: ['review.returned'] }).at(-1)!.payload as { findings: string[] };
    expect(p.findings).toHaveLength(6);
    expect(p.findings[0].length).toBe(300);
  });
});

describe('nobody reviews their own send (spec §5)', () => {
  let dir: string; let vault: Vault; let org: Org;
  beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-trust-who-')); vault = (await scaffoldVault(dir)).vault; org = loadOrg(vault); });
  afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

  it('the office holder reviews, resolved through the constitution rather than by name', () => {
    expect(trustReviewerFor(org, 'office:compliance.review', 'cmo')).toBe(org.offices?.compliance ?? 'clo');
    expect(trustReviewerFor(org, 'office:security.review', 'cmo')).toBe(org.offices?.security ?? 'ciso');
    const restaffed: Org = { ...org, offices: { ...org.offices, compliance: 'coo' } };
    expect(trustReviewerFor(restaffed, 'office:compliance.review', 'cmo')).toBe('coo');
  });

  it('the author is never their own reviewer: it goes up the tree', () => {
    const clo = trustReviewerFor(org, 'office:compliance.review', 'cmo')!;
    const up = trustReviewerFor(org, 'office:compliance.review', clo);
    expect(up).not.toBe(clo);
    expect(org.roles[up!]).toBeDefined();
  });

  it('an unstaffed office is a null, never a made-up reviewer', () => {
    const empty: Org = { teams: {}, roles: {}, offices: {} };
    expect(trustReviewerFor(empty, 'office:compliance.review', 'cmo')).toBeNull();
    // Only the author is left: still null, so the call stays refused rather than self-reviewed.
    const alone: Org = { teams: {}, roles: { clo: org.roles.clo }, offices: { compliance: 'clo', chief_executive: 'clo' } };
    expect(trustReviewerFor(alone, 'office:compliance.review', 'clo')).toBeNull();
  });
});

describe('what the reviewer is shown (spec §3)', () => {
  it('the exact call, the criteria and the proposal it came from', () => {
    const goal = trustGateGoal({
      gate: 'office:compliance.review', tool: 'email.send',
      args: { to: 'nursery@example.com', subject: 'Hello', body: 'Buy now' },
      proposal: 'prop_x', path: '00 Inbox/2026-09-12-outbound_batch-x.md', author: 'cmo',
      criteria: 'Is the claim true? Is there a way out?',
    });
    expect(goal).toContain('office:compliance.review');
    expect(goal).toContain('`email.send`');
    expect(goal).toContain('"nursery@example.com"');
    expect(goal).toContain('Buy now');
    expect(goal).toContain('[[prop_x]]');
    expect(goal).toContain('Is the claim true?');
    expect(goal).toContain('verdict pass');
  });

  it('cuts an enormous body rather than handing a reviewer 80 kB', () => {
    const goal = trustGateGoal({ gate: 'office:security.review', tool: 'email.send', args: { body: 'x'.repeat(20_000) }, proposal: 'p', path: '00 Inbox/p.md', author: 'cmo', criteria: '' });
    expect(goal.length).toBeLessThan(TRUST_ARGS_CHARS + 900);
    expect(goal).toContain('cut at 4000 characters');
    expect(goal).toContain('00 Inbox/p.md');
  });

  it('ids are deterministic per call and per gate, and labels read as titles', () => {
    expect(trustJobId('job_a:1:2', 'office:compliance.review')).toBe(trustJobId('job_a:1:2', 'office:compliance.review'));
    expect(trustJobId('job_a:1:2', 'office:compliance.review')).not.toBe(trustJobId('job_a:1:2', 'office:security.review'));
    expect(trustJobId('job_a:1:2', 'office:compliance.review')).not.toBe(trustJobId('job_a:1:3', 'office:compliance.review'));
    expect(trustJobId('job_a:1:2', 'office:compliance.review')).toMatch(/^job_/);
    expect(trustGateLabel('office:compliance.review')).toBe('Compliance review');
    expect(trustGateLabel('office:security.review')).toBe('Security review');
  });

  it('a call with no key at all is refused by name', () => {
    expect(trustRefusalNoKey('email.send')).toContain('no filed proposal');
    expect(trustRefusalNoKey('email.send')).toContain('Nothing was sent');
  });
});

describe('the tool layer\'s own check, and the decision the harness shares with it', () => {
  let dir: string; let vault: Vault;
  const KEY = 'job_1:1:3';
  const EMAIL = { to: 'nursery@example.com', subject: 'Hello', body: 'Buy now' };
  const cfg = { tools: { 'email.send': { trust_review: true }, 'deploy.site': { trust_review: true }, 'mock.outbound': { trust_review: false } } };
  beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-veto-')); vault = (await scaffoldVault(dir)).vault; });
  afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });
  const ctx = (idempotencyKey?: string): TrustCheckCtx => ({ config: cfg, events: vault.events, idempotencyKey });
  const pass = (gate: string) => recordTrustVerdict(vault, { key: KEY, proposal: 'p', gate, verdict: 'pass', by: 'x' });

  it('refuses a leaving call with no key, and one whose reviews are out', () => {
    expect(trustVeto(ctx(), 'email.send', EMAIL)).toContain('no filed proposal');
    expect(trustVeto(ctx(''), 'email.send', EMAIL)).toContain('no filed proposal');
    expect(trustVeto(ctx(KEY), 'email.send', EMAIL)).toContain('runs only once');
    pass('office:compliance.review');
    expect(trustVeto(ctx(KEY), 'email.send', EMAIL)).toContain('office:security.review');
    pass('office:security.review');
    expect(trustVeto(ctx(KEY), 'email.send', EMAIL)).toBeNull();
  });

  it('a return is final for this attempt, however many passes came before it', () => {
    pass('office:security.review');
    recordTrustVerdict(vault, { key: KEY, proposal: 'p', gate: 'office:compliance.review', verdict: 'return', findings: ['no unsubscribe link'], by: 'clo' });
    expect(trustVeto(ctx(KEY), 'email.send', EMAIL)).toContain('returned by office:compliance.review');
  });

  it('a call that does not leave the company is not touched at all', () => {
    expect(trustVeto(ctx(), 'mock.outbound', { to: 'a', body: 'b' })).toBeNull();
    expect(trustVeto(ctx(), 'vault.write', { path: 'Site/index.html', content: 'x' })).toBeNull();
    expect(trustVeto(ctx(KEY), 'deploy.site', { stage: 'preview' })).toBeNull();
    expect(trustVeto(ctx(KEY), 'deploy.site', { stage: 'live', rollback: true })).toBeNull();
    expect(trustVeto(ctx(KEY), 'deploy.site', { stage: 'live', metrics: ['error rate'] })).toContain('runs only once');
  });

  it('the three-way decision: null, hold, returned, clear', () => {
    const call = { tool: 'email.send', args: EMAIL, idempotency_key: KEY };
    expect(trustDecision(vault.events, cfg.tools['mock.outbound'], { tool: 'mock.outbound', args: {}, idempotency_key: KEY })).toBeNull();
    expect(trustDecision(vault.events, cfg.tools['email.send'], call)!.kind).toBe('hold');
    pass('office:compliance.review');
    expect(trustDecision(vault.events, cfg.tools['email.send'], call)!.kind).toBe('hold');
    pass('office:security.review');
    expect(trustDecision(vault.events, cfg.tools['email.send'], call)!.kind).toBe('clear');
    recordTrustVerdict(vault, { key: KEY, proposal: 'p', gate: 'office:security.review', verdict: 'return', findings: ['the link leaks a session token'], by: 'ciso' });
    const d = trustDecision(vault.events, cfg.tools['email.send'], call)!;
    expect(d.kind).toBe('returned');
    expect(d.kind === 'returned' && d.reason).toContain('session token');
  });
});
