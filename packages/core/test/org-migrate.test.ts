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
