import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { loadOrg, officeRole, officeHolder, childTeams, divisionOf, divisionTeams, divisionLeadOf } from '../src/org.js';
import { OFFICES, DEFAULT_OFFICES } from '../src/schemas.js';

let dir: string; let vault: Vault;
beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-offices-')); vault = (await scaffoldVault(dir)).vault; });
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('offices (spec item 1)', () => {
  it('the template constitution maps all eight offices to active roles', () => {
    const org = loadOrg(vault);
    expect(OFFICES).toEqual(['chief_executive', 'finance', 'operations', 'security', 'compliance', 'people', 'research', 'engineering']);
    for (const o of OFFICES) expect(org.offices?.[o], o).toBe(DEFAULT_OFFICES[o]);
    expect(officeRole(org, 'chief_executive')).toBe('ceo');
    expect(officeRole(org, 'engineering')).toBe('cto');
    expect(officeRole(org, 'security')).toBe('ciso');
    expect(officeRole(org, 'research')).toBe('research_manager');
  });

  it('the constitution can rename an office and loadOrg follows it', () => {
    const text = vault.readText('Memory/constitution.md').replace(/^  engineering: cto$/m, '  engineering: dev_manager');
    vault.writeText('Memory/constitution.md', text, 'owner');
    try { expect(officeRole(loadOrg(vault), 'engineering')).toBe('dev_manager'); }
    finally { vault.writeText('Memory/constitution.md', text.replace(/^  engineering: dev_manager$/m, '  engineering: cto'), 'owner'); }
  });

  it('officeRole is null for an inactive holder; officeHolder falls back to the team lead, then the division lead', () => {
    const org = loadOrg(vault);
    const gone = { ...org, roles: Object.fromEntries(Object.entries(org.roles).filter(([r]) => r !== 'ciso')) };
    expect(officeRole(gone, 'security')).toBeNull();
    expect(officeHolder(gone, 'security')).toBe('ceo');        // the security team's only lead is the CISO
    const noResearchLead = { ...org, roles: Object.fromEntries(Object.entries(org.roles).filter(([r]) => r !== 'research_manager')) };
    expect(officeHolder(noResearchLead, 'research')).toBe('coo');    // the Research room sits under Operations
    expect(officeHolder(org, 'people')).toBe('chro');
  });

  it('the team tree: children, division root, the divisions that plan, and a role\'s division lead', () => {
    const org = loadOrg(vault);
    expect(childTeams(org, 'technology').map((t) => t.id).sort()).toEqual(['dev', 'qa']);
    expect(childTeams(org, 'dev')).toEqual([]);
    expect(divisionOf(org, 'dev')).toBe('technology');
    expect(divisionOf(org, 'sales')).toBe('revenue');
    expect(divisionOf(org, 'executive')).toBe('executive');
    expect(divisionOf(org, undefined)).toBeNull();
    expect(divisionTeams(org).map((t) => t.id).sort()).toEqual(['operations', 'revenue', 'technology']);
    expect(divisionLeadOf(org, 'backend_engineer')).toBe('cto');
    expect(divisionLeadOf(org, 'research_analyst')).toBe('coo');
    expect(divisionLeadOf(org, 'ciso')).toBe('ciso');
  });

  it('board_decides_after_hours is off by default: the plan waits for the owner', () => {
    expect(vault.constitution().board_decides_after_hours).toBe(0);
  });
});
