import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { loadOrg, migrateOrg } from '../src/org.js';
import { createJob, listJobs, updateJob } from '../src/jobs.js';

const charter = (role: string, team: string, reports_to: string, desk = role, extra = '') => `---\nrole: ${role}\ndisplay: ${role}\nmodel_tier: cheap\ntools: [vault.read, finish]\napproval_overrides: {}\nactive: true\nhired: "2026-09-02T00:00:00.000Z"\nsprite: ${role}\ndesk: ${desk}\nteam: ${team}\nreports_to: ${reports_to}\npersona: "p"\npermissions: []\n${extra}---\n# Charter\n\n${role}.\n`;
const teamNote = (id: string, lead: string, members: string[], extra = '') => `---\nid: ${id}\nname: ${id}\nlead: ${lead}\nmembers: [${members.join(', ')}]\nmission: m\nroom: ${id}\n${extra}processes: []\n---\n# ${id}\n`;

/** A synthetic tower template: enough of the real one for the migration to have something to copy. */
function makeTemplate(): string {
  const tpl = mkdtempSync(path.join(tmpdir(), 'cubicle-tpl-'));
  for (const d of ['Roles/_hireable', 'Roles/archive', 'Teams', 'Processes', 'Docs', 'Memory']) mkdirSync(path.join(tpl, d), { recursive: true });
  writeFileSync(path.join(tpl, 'Roles/ceo.md'), charter('ceo', 'executive', 'owner'));
  writeFileSync(path.join(tpl, 'Roles/cto.md'), charter('cto', 'technology', 'ceo'));
  writeFileSync(path.join(tpl, 'Roles/coo.md'), charter('coo', 'operations', 'ceo'));
  writeFileSync(path.join(tpl, 'Roles/dev_manager.md'), charter('dev_manager', 'dev', 'cto'));
  writeFileSync(path.join(tpl, 'Roles/advisor_skeptic.md'), charter('advisor_skeptic', 'board', 'ceo'));
  writeFileSync(path.join(tpl, 'Roles/research_manager.md'), charter('research_manager', 'research', 'coo'));
  writeFileSync(path.join(tpl, 'Teams/executive.md'), teamNote('executive', 'ceo', [], 'floor: 1\n'));
  writeFileSync(path.join(tpl, 'Teams/technology.md'), teamNote('technology', 'cto', ['dev_manager'], 'floor: 4\n'));
  writeFileSync(path.join(tpl, 'Teams/operations.md'), teamNote('operations', 'coo', ['research_manager'], 'floor: 4\n'));
  writeFileSync(path.join(tpl, 'Teams/dev.md'), teamNote('dev', 'dev_manager', [], 'floor: 2\nparent: technology\n'));
  writeFileSync(path.join(tpl, 'Teams/board.md'), teamNote('board', 'advisor_skeptic', [], 'floor: 1\n'));
  writeFileSync(path.join(tpl, 'Teams/research.md'), teamNote('research', 'research_manager', [], 'floor: 2\nparent: operations\n'));
  writeFileSync(path.join(tpl, 'Processes/feature.md'), '---\nname: feature\nsteps:\n  - { role: dev_manager, type: custom, title: "Build: {objective}" }\n---\nTower feature process.\n');
  writeFileSync(path.join(tpl, 'Memory/constitution.md'), '# Constitution\n\n```yaml\nmax_roles: 40\nmax_team_size: 8\nauto_approve_reorg: false\nnever_modify:\n  - Teams/\n```\n');
  return tpl;
}

/** A v1 vault: the nine legacy charters, three legacy team notes, a v1 process and an open job for the engineer. */
async function makeLegacyVault() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-v1-'));
  const { vault } = await scaffoldVault(dir);
  for (const f of readdirSync(path.join(dir, 'Roles'))) if (f.endsWith('.md')) rmSync(path.join(dir, 'Roles', f));
  for (const f of readdirSync(path.join(dir, 'Teams'))) rmSync(path.join(dir, 'Teams', f));
  writeFileSync(path.join(dir, 'Roles/ceo.md'), charter('ceo', 'strategy', 'owner', 'ceo_cabin'));
  writeFileSync(path.join(dir, 'Roles/cto.md'), charter('cto', 'engineering', 'ceo', 'cubicle_1'));
  writeFileSync(path.join(dir, 'Roles/coo.md'), charter('coo', 'operations', 'ceo', 'cubicle_4'));
  for (const [r, t, l, d] of [['engineer', 'engineering', 'cto', 'cubicle_2'], ['head_of_growth', 'growth', 'ceo', 'cubicle_3'], ['qa', 'engineering', 'cto', 'cubicle_5'], ['tech_lead', 'engineering', 'cto', 'cubicle_6'], ['research_analyst', 'research', 'ceo', 'cubicle_7'], ['critic', 'strategy', 'ceo', 'cubicle_9']]) writeFileSync(path.join(dir, `Roles/${r}.md`), charter(r, t, l, d));
  writeFileSync(path.join(dir, 'Teams/engineering.md'), teamNote('engineering', 'cto', ['tech_lead', 'engineer', 'qa']));
  writeFileSync(path.join(dir, 'Teams/growth.md'), teamNote('growth', 'head_of_growth', []));
  writeFileSync(path.join(dir, 'Teams/strategy.md'), teamNote('strategy', 'ceo', ['critic']));
  writeFileSync(path.join(dir, 'Teams/operations.md'), teamNote('operations', 'coo', []));
  writeFileSync(path.join(dir, 'Teams/research.md'), teamNote('research', 'research_analyst', []));
  writeFileSync(path.join(dir, 'Processes/feature.md'), '---\nname: feature\nsteps:\n  - { role: engineer, type: custom, title: "Build: {objective}" }\n---\nv1.\n');
  writeFileSync(path.join(dir, 'Memory/constitution.md'), '# Constitution\n\n```yaml\nmax_roles: 12\nmax_team_size: 6\nauto_approve_reorg: false\nnever_modify:\n  - Teams/\n```\n');
  const open = createJob(vault, { type: 'custom', title: 'open work', assigned: 'engineer', goal: 'g' }, 'cto');
  const done = createJob(vault, { type: 'custom', title: 'old work', assigned: 'critic', goal: 'g' }, 'ceo');
  updateJob(vault, done, { status: 'done' }, 'daemon');
  return { dir, vault, open, done };
}

describe('migrateOrg: tower roster step', () => {
  it('archives the legacy six, reassigns open jobs, swaps team notes and processes, moves kept chiefs to their tower desks, raises the caps, and is idempotent', async () => {
    const tpl = makeTemplate();
    const { dir, vault, open, done } = await makeLegacyVault();
    try {
      const r = migrateOrg(vault, tpl);
      expect(r.changed).toContain('Roles/engineer.md');
      const org = loadOrg(vault);
      expect(Object.keys(org.roles).sort()).toEqual(['advisor_skeptic', 'ceo', 'coo', 'cto', 'dev_manager', 'research_manager']);
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
      expect(jobs.find((j) => j.id === open)!.assigned).toBe('dev_manager');
      expect(jobs.find((j) => j.id === done)!.assigned).toBe('critic');   // finished work keeps its history
      expect(vault.readText('Processes/feature.md')).toContain('dev_manager');
      expect(vault.constitution()).toMatchObject({ max_roles: 40, max_team_size: 8 });
      expect(migrateOrg(vault, tpl).changed).toEqual([]);
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
