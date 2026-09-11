import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { loadOrg, reportsOf, leadOf } from '../src/org.js';
import { isOwnerOwned } from '../src/guard.js';

let dir: string; let vault: Vault;
beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-tpl-org-')); vault = (await scaffoldVault(dir)).vault; });
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

export const ACTIVE_ROLES = [
  'advisor_customer', 'advisor_investor', 'advisor_skeptic', 'backend_engineer', 'ceo', 'cfo', 'cgo', 'chro', 'ciso', 'clo', 'cmo', 'coo', 'cso', 'cto',
  'data_scientist', 'dev_manager', 'frontend_engineer', 'fullstack_engineer', 'intelligence_analyst', 'platform_engineer', 'product_designer', 'product_manager',
  'qa_automation', 'qa_exploratory', 'qa_lead', 'qa_performance', 'qa_release', 'qa_security', 'research_analyst', 'research_engineer', 'research_manager', 'researcher', 'sre',
];

describe('tower roster in the template (tower spec §C)', () => {
  it('33 active roles, five inactive sales placeholders, desk = role, personas everywhere, advisors veto', () => {
    const org = loadOrg(vault);
    expect(Object.keys(org.roles).sort()).toEqual(ACTIVE_ROLES);
    for (const r of Object.values(org.roles)) {
      expect(r.persona, r.role).toBeTruthy(); expect(r.team, r.role).toBeTruthy(); expect(r.reports_to, r.role).toBeTruthy(); expect(r.title, r.role).toBeTruthy();
      expect(r.desk, r.role).toBe(r.role); expect(r.sprite, r.role).toBe(r.role);
      expect(r.tools, r.role).toContain('finish');
    }
    for (const a of ['advisor_skeptic', 'advisor_investor', 'advisor_customer']) expect(org.roles[a].permissions.sort()).toEqual(['review', 'veto']);
    const files = readdirSync(path.join(dir, 'Roles')).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(38);
    for (let i = 1; i <= 5; i++) expect(readFileSync(path.join(dir, 'Roles', `sales_${i}.md`), 'utf8')).toMatch(/^active: false$/m);
    for (const gone of ['critic', 'engineer', 'head_of_growth', 'qa', 'tech_lead']) expect(files).not.toContain(`${gone}.md`);   // research_analyst.md still exists: it is the member now
  });
  it('hireable charters target the dev and sales rooms; cfo and product are real roles now', () => {
    for (const h of ['devops', 'engineer_2', 'marketing', 'sales', 'support', 'ui']) expect(existsSync(path.join(dir, 'Roles/_hireable', `${h}.md`)), h).toBe(true);
    for (const gone of ['cfo', 'product']) expect(existsSync(path.join(dir, 'Roles/_hireable', `${gone}.md`)), gone).toBe(false);
    for (const h of ['devops', 'engineer_2', 'ui']) expect(readFileSync(path.join(dir, 'Roles/_hireable', `${h}.md`), 'utf8')).toMatch(/^team: dev$/m);
    for (const h of ['marketing', 'sales', 'support']) expect(readFileSync(path.join(dir, 'Roles/_hireable', `${h}.md`), 'utf8')).toMatch(/^team: sales$/m);
  });
});

describe('tower teams', () => {
  it('ten teams with room and floor; departments carry their division as parent; division leads can reach their managers', () => {
    const org = loadOrg(vault);
    expect(Object.keys(org.teams).sort()).toEqual(['board', 'dev', 'executive', 'operations', 'qa', 'research', 'revenue', 'sales', 'security', 'technology']);
    for (const t of Object.values(org.teams)) { expect(t.room, t.id).toBeTruthy(); expect(t.floor, t.id).toBeGreaterThanOrEqual(1); expect(org.roles[t.lead], `${t.id} lead ${t.lead}`).toBeDefined(); }
    expect(org.teams.dev).toMatchObject({ lead: 'dev_manager', room: 'dev', floor: 2, parent: 'technology' });
    expect(org.teams.qa).toMatchObject({ lead: 'qa_lead', room: 'qa', floor: 3, parent: 'technology' });
    expect(org.teams.research).toMatchObject({ lead: 'research_manager', room: 'research', floor: 2, parent: 'operations' });
    expect(org.teams.sales).toMatchObject({ lead: 'cso', room: 'sales', floor: 2, parent: 'revenue' });
    expect(org.teams.dev.members).toHaveLength(7);
    expect(org.teams.sales.members).toEqual(['sales_1', 'sales_2', 'sales_3', 'sales_4', 'sales_5']);
    expect(reportsOf(org, 'cto').sort()).toEqual(['dev_manager', 'qa_lead']);
    expect(reportsOf(org, 'cfo').sort()).toEqual(['cgo', 'cmo', 'cso']);
    expect(reportsOf(org, 'coo').sort()).toEqual(['chro', 'clo', 'research_manager']);
    // A division note lists only the people who sit in the division office; the leads of the rooms under it are
    // reports through `parent`, not members (the stopgap that listed them twice is gone).
    expect(org.teams.technology.members).toEqual([]);
    expect(org.teams.revenue.members).toEqual(['cmo', 'cgo']);
    expect(org.teams.operations.members).toEqual(['chro', 'clo']);
    expect(leadOf(org, 'dev_manager')).toBe('cto'); expect(leadOf(org, 'backend_engineer')).toBe('dev_manager'); expect(leadOf(org, 'advisor_investor')).toBe('advisor_skeptic');
    for (const r of Object.values(org.roles)) if (r.role !== 'ceo') expect(Object.values(org.teams).some((t) => t.lead === r.role || t.members.includes(r.role)), `${r.role} in some team`).toBe(true);
    expect(isOwnerOwned('Teams/dev.md')).toBe(true);
  });
});

describe('processes, gates and constitution', () => {
  it('every process step names an active role; gates.yaml unchanged; caps raised', () => {
    const org = loadOrg(vault);
    for (const p of ['new_product', 'feature', 'launch', 'pricing', 'weekly_review', 'opportunity', 'research_lifecycle']) {
      const text = readFileSync(path.join(dir, 'Processes', `${p}.md`), 'utf8');
      for (const m of text.matchAll(/role:\s*([a-z_0-9]+)/g)) expect(org.roles[m[1]], `${p}: ${m[1]}`).toBeDefined();
      for (const m of text.matchAll(/for:\s*([a-z_0-9]+)/g)) expect(org.roles[m[1]], `${p} for: ${m[1]}`).toBeDefined();
    }
    expect(readFileSync(path.join(dir, 'Processes/feature.md'), 'utf8')).toMatch(/role: research_manager.*\n.*role: cto.*\n.*role: backend_engineer.*\n.*role: cmo/);
    for (const d of ['Docs/adr', 'Docs/research', 'Docs/postmortems', 'Docs/tech-radar.md', 'Research/index.md', 'Research/intelligence', 'Ideas/_template.md', 'Metrics/research.md']) expect(existsSync(path.join(dir, d)), d).toBe(true);
    expect(readFileSync(path.resolve(__dirname, '../../../config/gates.yaml'), 'utf8')).toMatch(/engineer\.ship:\s*\[team:qa\.review, office:operations\.verify\]/);
    expect(vault.constitution()).toMatchObject({ max_team_size: 8, auto_approve_reorg: false, max_roles: 40 });
  });
});
