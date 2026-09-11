import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { loadOrg, type Org } from '../src/org.js';
import { loadGates, gatesFor, gatesForRisk, criteriaFor, gateAssignee } from '../src/gates.js';
import { ProposalKind } from '../src/schemas.js';

const table = loadGates(path.resolve(__dirname, '../../../config/gates.yaml'));

let dir: string; let vault: Vault;
beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-gates-risk-')); vault = (await scaffoldVault(dir)).vault; });
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('risk-based gate chains (owner operating model §26–27)', () => {
  it('low risk is the base chain, unchanged', () => {
    expect(gatesForRisk(table, 'engineer.ship', 'low')).toEqual(gatesFor(table, 'engineer.ship'));
    expect(gatesForRisk(table, 'engineer.ship')).toEqual(['qa.review', 'coo.verify']);
  });

  it('medium and high insert security.review first, before QA spends a cycle', () => {
    expect(gatesForRisk(table, 'engineer.ship', 'medium')).toEqual(['security.review', 'qa.review', 'coo.verify']);
    expect(gatesForRisk(table, 'engineer.ship', 'high')).toEqual(['security.review', 'qa.review', 'coo.verify']);
  });

  it('never inserts a second security.review into a chain that already has one', () => {
    const t = { 'x.ship': { gates: ['security.review', 'coo.verify'], criteria: '' } };
    expect(gatesForRisk(t, 'x.ship', 'high')).toEqual(['security.review', 'coo.verify']);
  });

  it('a job type with no gates gains one anyway when the risk says so', () => {
    expect(gatesForRisk(table, 'team.plan', 'medium')).toEqual(['security.review']);
  });

  it('security.review is a known gate type with criteria and no gates of its own', () => {
    expect(gatesFor(table, 'security.review')).toEqual([]);
    expect(criteriaFor(table, 'security.review')).toMatch(/secret|auth|data/i);
  });
});

describe('gateAssignee', () => {
  const job = { for: 'cto', owner_role: 'dev_manager' };
  it('names the role in the gate for ordinary gates', () => {
    expect(gateAssignee('qa.review', job)).toBe('qa');
    expect(gateAssignee('coo.verify', job)).toBe('coo');
    expect(gateAssignee('requester.review', job)).toBe('cto');
  });
  it('resolves security.review through the security team lead, defaulting to the CISO', () => {
    expect(gateAssignee('security.review', job, (t) => (t === 'security' ? 'ciso' : null))).toBe('ciso');
    expect(gateAssignee('security.review', job, () => null)).toBe('ciso');
    expect(gateAssignee('security.review', job)).toBe('ciso');
    expect(gateAssignee('security.review', job, (t) => (t === 'security' ? 'qa_security' : null))).toBe('qa_security');
  });
  it('resolves security.review through a loaded Org the same way SP7 resolves research.review', () => {
    const org = loadOrg(vault);
    expect(org.teams.security?.lead).toBe('ciso');           // the fixture's own answer, not a hard-coded one
    expect(gateAssignee('security.review', job, org)).toBe('ciso');
  });
  it('the org chart wins over the CISO fallback when the security team has a different lead', () => {
    const org = loadOrg(vault);
    const reorged: Org = { ...org, teams: { ...org.teams, security: { ...org.teams.security, lead: 'appsec_lead' } } };
    expect(gateAssignee('security.review', job, reorged)).toBe('appsec_lead');
  });
});

describe('threat_model proposals', () => {
  it('is a proposal kind the owner can approve', () => {
    expect(ProposalKind.safeParse('threat_model').success).toBe(true);
  });
  it('gates.yaml lists every job type it can gate, so gen-docs stays complete', () => {
    const raw = readFileSync(path.resolve(__dirname, '../../../config/gates.yaml'), 'utf8');
    expect(raw).toMatch(/^\s+security\.review:/m);
  });
});
