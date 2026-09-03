import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { loadOrg, reportsOf } from '../src/org.js';
import { isOwnerOwned } from '../src/guard.js';

let dir: string; let vault: Vault;
beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-tpl-org-')); vault = (await scaffoldVault(dir)).vault; });
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('default org in the template (spec §1, §6)', () => {
  it('five teams, nine active roles, personas everywhere, hireable charters aside', () => {
    const org = loadOrg(vault);
    expect(Object.keys(org.teams).sort()).toEqual(['engineering', 'growth', 'operations', 'research', 'strategy']);
    expect(Object.keys(org.roles).sort()).toEqual(['ceo', 'coo', 'critic', 'cto', 'engineer', 'head_of_growth', 'qa', 'research_analyst', 'tech_lead']);
    expect(reportsOf(org, 'cto').sort()).toEqual(['engineer', 'qa', 'tech_lead']);
    for (const r of Object.values(org.roles)) { expect(r.persona, r.role).toBeTruthy(); expect(r.team, r.role).toBeTruthy(); expect(r.reports_to, r.role).toBeTruthy(); }
    for (const h of ['cfo', 'devops', 'engineer_2', 'marketing', 'sales', 'support', 'product', 'ui']) expect(existsSync(path.join(dir, 'Roles/_hireable', `${h}.md`)), h).toBe(true);
    expect(new Set(Object.values(org.roles).map((r) => r.desk)).size).toBe(9); // distinct desks
  });
  it('processes, docs, gates and constitution fields exist; Teams/ is owner-owned', () => {
    for (const p of ['new_product', 'feature', 'launch', 'pricing', 'weekly_review', 'opportunity']) expect(existsSync(path.join(dir, 'Processes', `${p}.md`)), p).toBe(true);
    for (const d of ['Docs/adr', 'Docs/research', 'Docs/postmortems', 'Docs/tech-radar.md']) expect(existsSync(path.join(dir, d)), d).toBe(true);
    expect(readFileSync(path.resolve(__dirname, '../../../config/gates.yaml'), 'utf8')).toMatch(/engineer\.ship:\s*\[qa\.review, coo\.verify\]/);
    expect(vault.constitution()).toMatchObject({ max_team_size: 6, auto_approve_reorg: false, max_roles: 12 });
    expect(isOwnerOwned('Teams/engineering.md')).toBe(true);
  });
});
