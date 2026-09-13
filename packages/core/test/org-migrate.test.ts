import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, templateDir } from '../src/template.js';
import { loadOrg, migrateOrg } from '../src/org.js';
import { createJob, listJobs } from '../src/jobs.js';
import { charter, makeLegacyVault } from './legacy-vault.js';

describe('migrateOrg on a v0.1 vault (growth role, no teams) against the real template', () => {
  it('renames growth, then the tower step archives it as head_of_growth and cmo takes its work; idempotent', async () => {
    const { dir, vault } = await makeLegacyVault();
    rmSync(path.join(dir, 'Roles/head_of_growth.md'));
    writeFileSync(path.join(dir, 'Roles/growth.md'), charter('growth', 'growth', 'ceo', 'cubicle_3').replace('display: growth', 'display: Growth'));
    rmSync(path.join(dir, 'Teams'), { recursive: true, force: true });
    createJob(vault, { type: 'research', title: 'old', assigned: 'growth', goal: 'g' }, 'cto');
    try {
      const before = vault.events.count('org.changed');
      const r = migrateOrg(vault, templateDir());
      expect(r.changed.length).toBeGreaterThan(5);
      const org = loadOrg(vault);
      expect(org.roles.growth).toBeUndefined(); expect(org.roles.head_of_growth).toBeUndefined(); expect(org.roles.cmo.desk).toBe('cmo');
      expect(org.roles.cto).toMatchObject({ team: 'technology', desk: 'cto' });
      expect(Object.keys(org.teams).sort()).toEqual(['board', 'dev', 'executive', 'operations', 'qa', 'research', 'revenue', 'sales', 'security', 'technology']);
      expect(existsSync(path.join(dir, 'Messages', 'head_of_growth.md'))).toBe(true);
      expect(vault.constitution()).toMatchObject({ max_team_size: 8, max_roles: 40 });
      expect(listJobs(vault).every((j) => j.assigned !== 'growth' && j.assigned !== 'head_of_growth')).toBe(true);
      expect(vault.events.count('org.changed')).toBe(before + 1);
      expect(migrateOrg(vault, templateDir()).changed).toEqual([]);
      expect(vault.events.count('org.changed')).toBe(before + 1);
    } finally { vault.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

// Ruling S-5. Step 4 of the migration fills only *missing* org fields, so a vault scaffolded while the skeptic
// was `strong` would keep the strong tier for ever: one board session is four calls on top of the plan, out of a
// free strong tier of 20 a day per flash model, and the live run of 2026-09-13 had that tier gone by 10:51.
describe('migrateOrg moves the board off the strong tier', () => {
  it('rewrites a strong board advisor to medium, leaves the CEO alone, and is idempotent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-board-tier-'));
    const vault = (await scaffoldVault(dir)).vault;
    try {
      // A vault written before the ruling: the skeptic chairs the board on the strong tier.
      const rel = 'Roles/advisor_skeptic.md';
      vault.writeText(rel, vault.readText(rel).replace(/^model_tier: .*$/m, 'model_tier: strong'), 'owner');
      expect(loadOrg(vault).roles.advisor_skeptic.model_tier).toBe('strong');

      const r = migrateOrg(vault, templateDir());
      expect(r.changed).toContain(rel);
      const org = loadOrg(vault);
      expect(org.roles.advisor_skeptic.model_tier).toBe('medium');
      expect(org.roles.advisor_investor.model_tier).toBe('medium');
      expect(org.roles.advisor_customer.model_tier).toBe('medium');
      // The strong tier is the CEO's plan and the owner's replies; nothing outside the board room moved.
      expect(org.roles.ceo.model_tier).toBe('strong');
      expect(org.roles.cto.model_tier).toBe('strong');
      expect(migrateOrg(vault, templateDir()).changed).toEqual([]);
    } finally { vault.close(); rmSync(dir, { recursive: true, force: true }); }
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

describe('migrateOrg constitution patch (offices, v2)', () => {
  it('a constitution with no offices block gets one, plus the board switch, and is left alone on a second run', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-offices-mig-'));
    try {
      const { vault } = await scaffoldVault(dir);
      const stripped = vault.readText('Memory/constitution.md')
        .replace(/^offices:\n(?:  \w+: \w+\n)+/m, '')
        .replace(/^board_decides_after_hours:.*\n/m, '');
      vault.writeText('Memory/constitution.md', stripped, 'owner');
      migrateOrg(vault, templateDir());
      const text = vault.readText('Memory/constitution.md');
      expect(text).toMatch(/^offices:$/m);
      expect(text).toMatch(/^  engineering: cto$/m);
      expect(text).toMatch(/^board_decides_after_hours: 0$/m);
      expect(loadOrg(vault).offices?.security).toBe('ciso');
      const before = vault.readText('Memory/constitution.md');
      migrateOrg(vault, templateDir());
      expect(vault.readText('Memory/constitution.md')).toBe(before);
      vault.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('migrateOrg strips the division-note stopgap (v2, task 2)', () => {
  it('migration strips a room lead that a division note still lists as a member, and leaves a real member alone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-stopgap-'));
    try {
      const { vault } = await scaffoldVault(dir);
      vault.writeText('Teams/technology.md', vault.readText('Teams/technology.md').replace(/^members: \[\]$/m, 'members: [dev_manager, qa_lead]'), 'owner');
      migrateOrg(vault, templateDir());
      expect(loadOrg(vault).teams.technology.members).toEqual([]);
      expect(loadOrg(vault).teams.revenue.members).toEqual(['cmo', 'cgo']);
      vault.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('migrateOrg warns about a teamless custom-hired charter with no template counterpart (F13)', () => {
  it('emits one daemon.warning naming the charter path', async () => {
    const dir3 = mkdtempSync(path.join(tmpdir(), 'cubicle-migrate-custom-'));
    const vault3 = (await scaffoldVault(dir3)).vault;
    try {
      vault3.writeText('Roles/custom_role.md', '---\nrole: custom_role\ndisplay: Custom\nactive: true\nhired: ""\nsprite: custom_role\ndesk: custom_role\n---\n# Charter\n\nDoes custom things.\n', 'daemon');
      const before = vault3.events.count('daemon.warning');
      migrateOrg(vault3, templateDir());
      const warnings = vault3.events.query({ types: ['daemon.warning'] }).slice(before);
      expect(warnings.some((e) => e.payload.path === 'Roles/custom_role.md' && /no team assigned/.test(String(e.payload.reason)))).toBe(true);
    } finally { vault3.close(); rmSync(dir3, { recursive: true, force: true }); }
  });
});
