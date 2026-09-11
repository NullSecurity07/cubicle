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
    expect(gatesForRisk(table, 'engineer.ship')).toEqual(['team:qa.review', 'office:operations.verify']);
  });

  it('medium and high insert office:security.review first, before QA spends a cycle', () => {
    expect(gatesForRisk(table, 'engineer.ship', 'medium')).toEqual(['office:security.review', 'team:qa.review', 'office:operations.verify']);
    expect(gatesForRisk(table, 'engineer.ship', 'high')).toEqual(['office:security.review', 'team:qa.review', 'office:operations.verify']);
  });

  it('never inserts a second security gate into a chain that already has one, under either name', () => {
    const t = { 'x.ship': { gates: ['office:security.review', 'office:operations.verify'], criteria: '' } };
    expect(gatesForRisk(t, 'x.ship', 'high')).toEqual(['office:security.review', 'office:operations.verify']);
    const legacy = { 'y.ship': { gates: ['security.review', 'coo.verify'], criteria: '' } };
    expect(gatesForRisk(legacy, 'y.ship', 'high')).toEqual(['security.review', 'coo.verify']);
  });

  it('a job type with no gates gains one anyway when the risk says so', () => {
    expect(gatesForRisk(table, 'team.plan', 'medium')).toEqual(['office:security.review']);
  });

  it('office:security.review is a known gate type with criteria and no gates of its own', () => {
    expect(gatesFor(table, 'office:security.review')).toEqual([]);
    expect(criteriaFor(table, 'office:security.review')).toMatch(/secret|auth|data/i);
  });
});

describe('gateAssignee', () => {
  const job = { for: 'cto', owner_role: 'dev_manager' };
  it('names the role in the gate for ordinary gates', () => {
    expect(gateAssignee('qa.review', job)).toBe('qa');
    expect(gateAssignee('coo.verify', job)).toBe('coo');
    expect(gateAssignee('requester.review', job)).toBe('cto');
  });
  it('resolves office:security.review through the security team lead, defaulting to the CISO', () => {
    expect(gateAssignee('office:security.review', job, (t) => (t === 'security' ? 'ciso' : null))).toBe('ciso');
    expect(gateAssignee('office:security.review', job, () => null)).toBe('ciso');
    expect(gateAssignee('office:security.review', job)).toBe('ciso');
    expect(gateAssignee('office:security.review', job, (t) => (t === 'security' ? 'qa_security' : null))).toBe('qa_security');
  });
  it('resolves office:security.review through a loaded Org the same way SP7 resolves research.review', () => {
    const org = loadOrg(vault);
    expect(org.teams.security?.lead).toBe('ciso');           // the fixture's own answer, not a hard-coded one
    expect(gateAssignee('office:security.review', job, org)).toBe('ciso');
  });
  it('the constitution\'s office map is what moves the gate: re-staffing security moves office:security.review', () => {
    const org = loadOrg(vault);
    // Spec item 2: an office gate resolves through `offices`, so the owner re-staffs a seat in the constitution
    // rather than by editing the room. Moving the room's lead alone does not take the office with it.
    const restaffed: Org = { ...org, offices: { ...org.offices, security: 'qa_security' } };
    expect(gateAssignee('office:security.review', job, restaffed)).toBe('qa_security');
    const reorged: Org = { ...org, teams: { ...org.teams, security: { ...org.teams.security, lead: 'appsec_lead' } } };
    expect(gateAssignee('office:security.review', job, reorged)).toBe('ciso');
  });
  it('a room gate goes to the room\'s lead, and up to the division lead when the room has none', () => {
    const org = loadOrg(vault);
    expect(gateAssignee('team:qa.review', job, org)).toBe('qa_lead');
    const noQaLead: Org = { ...org, roles: Object.fromEntries(Object.entries(org.roles).filter(([r]) => r !== 'qa_lead')) };
    expect(gateAssignee('team:qa.review', job, noQaLead)).toBe(org.teams.technology.lead);   // QA sits under Technology
    expect(gateAssignee('team:nosuchroom.review', job, org)).toBe('ceo');                    // never a made-up role
  });
});

describe('threat_model proposals', () => {
  it('is a proposal kind the owner can approve', () => {
    expect(ProposalKind.safeParse('threat_model').success).toBe(true);
  });
  it('gates.yaml lists every job type it can gate, so gen-docs stays complete', () => {
    const raw = readFileSync(path.resolve(__dirname, '../../../config/gates.yaml'), 'utf8');
    expect(raw).toMatch(/^\s+office:security\.review:/m);
    expect(raw).toMatch(/^\s+security\.review:/m);   // the pre-office name stays so a job queued before the rename still resolves
  });
});
