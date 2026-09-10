import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { loadOrg, migrateOrg } from '../src/org.js';
import { listJobs } from '../src/jobs.js';
import { charter, teamNote, makeLegacyVault } from './legacy-vault.js';

/** A synthetic tower template: enough of the real one for the migration to have something to copy. */
function makeTemplate(): string {
  const tpl = mkdtempSync(path.join(tmpdir(), 'cubicle-tpl-'));
  for (const d of ['Roles/_hireable', 'Roles/archive', 'Teams', 'Processes', 'Docs', 'Memory']) mkdirSync(path.join(tpl, d), { recursive: true });
  writeFileSync(path.join(tpl, 'Roles/ceo.md'), charter('ceo', 'executive', 'owner'));
  writeFileSync(path.join(tpl, 'Roles/cto.md'), charter('cto', 'technology', 'ceo'));
  writeFileSync(path.join(tpl, 'Roles/coo.md'), charter('coo', 'operations', 'ceo'));
  writeFileSync(path.join(tpl, 'Roles/dev_manager.md'), charter('dev_manager', 'dev', 'cto'));
  writeFileSync(path.join(tpl, 'Roles/backend_engineer.md'), charter('backend_engineer', 'dev', 'dev_manager'));   // the v1 `engineer`'s successor: open build work lands on a worker, not the manager
  writeFileSync(path.join(tpl, 'Roles/advisor_skeptic.md'), charter('advisor_skeptic', 'board', 'ceo'));
  writeFileSync(path.join(tpl, 'Roles/research_manager.md'), charter('research_manager', 'research', 'coo'));
  writeFileSync(path.join(tpl, 'Teams/executive.md'), teamNote('executive', 'ceo', [], 'floor: 1\n'));
  writeFileSync(path.join(tpl, 'Teams/technology.md'), teamNote('technology', 'cto', ['dev_manager'], 'floor: 4\n'));
  writeFileSync(path.join(tpl, 'Teams/operations.md'), teamNote('operations', 'coo', ['research_manager'], 'floor: 4\n'));
  writeFileSync(path.join(tpl, 'Teams/dev.md'), teamNote('dev', 'dev_manager', ['backend_engineer'], 'floor: 2\nparent: technology\n'));
  writeFileSync(path.join(tpl, 'Teams/board.md'), teamNote('board', 'advisor_skeptic', [], 'floor: 1\n'));
  writeFileSync(path.join(tpl, 'Teams/research.md'), teamNote('research', 'research_manager', [], 'floor: 2\nparent: operations\n'));
  writeFileSync(path.join(tpl, 'Processes/feature.md'), '---\nname: feature\nsteps:\n  - { role: dev_manager, type: custom, title: "Build: {objective}" }\n---\nTower feature process.\n');
  writeFileSync(path.join(tpl, 'Memory/constitution.md'), '# Constitution\n\n```yaml\nmax_roles: 40\nmax_team_size: 8\nauto_approve_reorg: false\nnever_modify:\n  - Teams/\n```\n');
  return tpl;
}

describe('migrateOrg: tower roster step', () => {
  it('archives the legacy six, reassigns open jobs, swaps team notes and processes, moves kept chiefs to their tower desks, raises the caps, and is idempotent', async () => {
    const tpl = makeTemplate();
    const { dir, vault, open, done } = await makeLegacyVault();
    try {
      const r = migrateOrg(vault, tpl);
      expect(r.changed).toContain('Roles/engineer.md');
      const org = loadOrg(vault);
      expect(Object.keys(org.roles).sort()).toEqual(['advisor_skeptic', 'backend_engineer', 'ceo', 'coo', 'cto', 'dev_manager', 'research_manager']);
      expect(Object.keys(org.teams).sort()).toEqual(['board', 'dev', 'executive', 'operations', 'research', 'technology']);
      const archived = readdirSync(path.join(dir, 'Roles/archive'));
      for (const id of ['engineer', 'head_of_growth', 'qa', 'tech_lead', 'research_analyst', 'critic']) expect(archived.some((f) => f.startsWith(`${id}-`)), id).toBe(true);
      expect(existsSync(path.join(dir, 'Roles/engineer.md'))).toBe(false);
      expect(existsSync(path.join(dir, 'Teams/engineering.md'))).toBe(false);
      expect(org.roles.cto).toMatchObject({ desk: 'cto', team: 'technology' });
      expect(org.roles.ceo.desk).toBe('ceo');
      expect(org.teams.research.lead).toBe('research_manager');
      expect(org.teams.dev.parent).toBe('technology');
      const jobs = listJobs(vault);
      expect(jobs.find((j) => j.id === open)!.assigned).toBe('backend_engineer');   // the v1 engineer's open build work goes to a worker with the build tools
      expect(jobs.find((j) => j.id === done)!.assigned).toBe('critic');   // finished work keeps its history
      expect(vault.readText('Processes/feature.md')).toContain('dev_manager');
      expect(vault.constitution()).toMatchObject({ max_roles: 40, max_team_size: 8 });
      expect(migrateOrg(vault, tpl).changed).toEqual([]);
    } finally { vault.close(); rmSync(dir, { recursive: true, force: true }); rmSync(tpl, { recursive: true, force: true }); }
  });
  it('archives an owner-edited Teams note before the tower template overwrites it', async () => {
    const tpl = makeTemplate();
    const { dir, vault } = await makeLegacyVault();
    try {
      const edited = teamNote('operations', 'coo', [], 'mission: keep the lights on, my way\n');
      writeFileSync(path.join(dir, 'Teams/operations.md'), edited);
      migrateOrg(vault, tpl);
      const archived = readdirSync(path.join(dir, 'Teams/archive'));
      const match = archived.find((f) => f.startsWith('operations-'));
      expect(match, archived.join(',')).toBeTruthy();
      expect(readFileSync(path.join(dir, 'Teams/archive', match!), 'utf8')).toContain('keep the lights on, my way');
      expect(vault.readText('Teams/operations.md')).not.toContain('keep the lights on, my way');
      const org = loadOrg(vault);
      expect(org.teams.operations.lead).toBe('coo');   // the archived copy (same team id) is not picked up as live
    } finally { vault.close(); rmSync(dir, { recursive: true, force: true }); rmSync(tpl, { recursive: true, force: true }); }
  });
  it('does nothing on a vault that already has the tower roster', async () => {
    const tpl = makeTemplate();
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-v2-'));
    const { vault } = await scaffoldVault(dir);
    try {
      writeFileSync(path.join(dir, 'Roles/dev_manager.md'), charter('dev_manager', 'dev', 'cto'));
      const before = readdirSync(path.join(dir, 'Roles/archive')).length;
      migrateOrg(vault, tpl);
      expect(readdirSync(path.join(dir, 'Roles/archive')).length).toBe(before);
    } finally { vault.close(); rmSync(dir, { recursive: true, force: true }); rmSync(tpl, { recursive: true, force: true }); }
  });
});
