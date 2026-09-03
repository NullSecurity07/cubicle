import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, templateDir } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { loadOrg, migrateOrg } from '../src/org.js';
import { createJob, listJobs } from '../src/jobs.js';

let dir: string; let vault: Vault;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-migrate-'));
  vault = (await scaffoldVault(dir)).vault;
  // Make it look like a v0.1 vault: no Teams/, old growth role, no critic, old constitution.
  rmSync(path.join(dir, 'Teams'), { recursive: true, force: true }); rmSync(path.join(dir, 'Processes'), { recursive: true, force: true }); rmSync(path.join(dir, 'Docs'), { recursive: true, force: true });
  for (const r of ['critic', 'tech_lead', 'qa', 'research_analyst']) rmSync(path.join(dir, 'Roles', `${r}.md`));
  rmSync(path.join(dir, 'Roles', '_hireable'), { recursive: true, force: true });
  renameSync(path.join(dir, 'Roles', 'head_of_growth.md'), path.join(dir, 'Roles', 'growth.md'));
  writeFileSync(path.join(dir, 'Roles', 'growth.md'), readFileSync(path.join(dir, 'Roles', 'growth.md'), 'utf8').replace('role: head_of_growth', 'role: growth').replace(/^team:.*\n|^reports_to:.*\n|^persona:.*\n|^title:.*\n|^permissions:.*\n/gm, ''));
  writeFileSync(path.join(dir, 'Memory', 'constitution.md'), readFileSync(path.join(dir, 'Memory', 'constitution.md'), 'utf8').replace(/^max_team_size:.*\n|^auto_approve_reorg:.*\n/gm, '').replace('max_roles: 12', 'max_roles: 8'));
  createJob(vault, { type: 'research', title: 'old', assigned: 'growth', goal: 'g' }, 'cto');
});
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('migrateOrg (spec §1 compatibility)', () => {
  it('builds the default org on an old vault, renames growth, keeps desks and ids, and is idempotent', () => {
    const before = vault.events.count('org.changed');
    const r = migrateOrg(vault, templateDir());
    expect(r.changed.length).toBeGreaterThan(5);
    const org = loadOrg(vault);
    expect(Object.keys(org.teams).sort()).toEqual(['engineering', 'growth', 'operations', 'research', 'strategy']);
    expect(org.roles.head_of_growth.desk).toBe('cubicle_3'); expect(org.roles.growth).toBeUndefined();
    expect(org.roles.cto.team).toBe('engineering'); expect(org.roles.cto.persona).toBeTruthy(); expect(org.roles.cto.desk).toBe('cubicle_1');
    expect(existsSync(path.join(dir, 'Roles', 'growth.md'))).toBe(false);
    expect(existsSync(path.join(dir, 'Messages', 'head_of_growth.md'))).toBe(true);
    expect(vault.constitution().max_team_size).toBe(6);
    const job = listJobs(vault);
    expect(job.every((j) => j.assigned !== 'growth')).toBe(true);
    expect(vault.events.count('org.changed')).toBe(before + 1);
    expect(migrateOrg(vault, templateDir()).changed).toEqual([]);
    expect(vault.events.count('org.changed')).toBe(before + 1);
  });
});

describe('migrateOrg constitution patch (missing max_roles anchor)', () => {
  it('a constitution with no max_roles: line migrates once, then the second run is a no-op', async () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'cubicle-migrate-noanchor-'));
    const vault2 = (await scaffoldVault(dir2)).vault;
    // Simulate a corrupted/pre-field constitution: no max_roles, max_team_size or auto_approve_reorg lines at all.
    writeFileSync(path.join(dir2, 'Memory', 'constitution.md'), readFileSync(path.join(dir2, 'Memory', 'constitution.md'), 'utf8').replace(/^max_roles:.*\n|^max_team_size:.*\n|^auto_approve_reorg:.*\n/gm, ''));
    try {
      const before = vault2.events.count('org.changed');
      const r1 = migrateOrg(vault2, templateDir());
      expect(r1.changed).toContain('Memory/constitution.md');
      expect(vault2.constitution().max_roles).toBe(12);
      expect(vault2.constitution().max_team_size).toBe(6);
      expect(vault2.constitution().auto_approve_reorg).toBe(false);
      expect(vault2.events.count('org.changed')).toBe(before + 1);
      const r2 = migrateOrg(vault2, templateDir());
      expect(r2.changed).toEqual([]);
      expect(vault2.events.count('org.changed')).toBe(before + 1);
    } finally { vault2.close(); rmSync(dir2, { recursive: true, force: true }); }
  });
});

describe('migrateOrg constitution patch (never_modify append branch) (T5)', () => {
  it('a constitution whose never_modify is missing Teams/ gets it appended once, then a second run is a no-op', async () => {
    const dir4 = mkdtempSync(path.join(tmpdir(), 'cubicle-migrate-nevermod-'));
    const vault4 = (await scaffoldVault(dir4)).vault;
    try {
      const original = readFileSync(path.join(dir4, 'Memory', 'constitution.md'), 'utf8');
      // Same trigger as the "no max_roles anchor" branch above (this append only runs alongside it), but this
      // time also strip the `- Teams/` line out of never_modify so the append branch itself is exercised.
      const stripped = original
        .replace(/^max_roles:.*\n|^max_team_size:.*\n|^auto_approve_reorg:.*\n/gm, '')
        .replace(/^\s+-\s+Teams\/\s*\n/m, '');
      expect(stripped).not.toContain('Teams/');
      writeFileSync(path.join(dir4, 'Memory', 'constitution.md'), stripped);
      const before = vault4.events.count('org.changed');
      const r1 = migrateOrg(vault4, templateDir());
      expect(r1.changed).toContain('Memory/constitution.md');
      const patched = vault4.readTextOrNull('Memory/constitution.md')!;
      expect(patched).toMatch(/never_modify:\n(?:\s+-.*\n)*\s+-\s+Teams\/\n/);
      expect(vault4.events.count('org.changed')).toBe(before + 1);
      const r2 = migrateOrg(vault4, templateDir());
      expect(r2.changed).toEqual([]);
      expect(vault4.events.count('org.changed')).toBe(before + 1);
    } finally { vault4.close(); rmSync(dir4, { recursive: true, force: true }); }
  });
});

describe('migrateOrg warns about a teamless custom-hired charter with no template counterpart (F13)', () => {
  it('emits one daemon.warning naming the charter path', async () => {
    const dir3 = mkdtempSync(path.join(tmpdir(), 'cubicle-migrate-custom-'));
    const vault3 = (await scaffoldVault(dir3)).vault;
    try {
      vault3.writeText('Roles/custom_role.md', '---\nrole: custom_role\ndisplay: Custom\nactive: true\nhired: ""\nsprite: custom_role\ndesk: cubicle_9\n---\n# Charter\n\nDoes custom things.\n', 'daemon');
      const before = vault3.events.count('daemon.warning');
      migrateOrg(vault3, templateDir());
      const warnings = vault3.events.query({ types: ['daemon.warning'] }).slice(before);
      expect(warnings.some((e) => e.payload.path === 'Roles/custom_role.md' && /no team assigned/.test(String(e.payload.reason)))).toBe(true);
    } finally { vault3.close(); rmSync(dir3, { recursive: true, force: true }); }
  });
});
