// Shared fixture for the two migration tests: a v1 (nine-role) vault, plus the charter/team-note writers both
// the v1 vault and the synthetic tower template are built from.
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { createJob, updateJob } from '../src/jobs.js';

export const charter = (role: string, team: string, reports_to: string, desk = role, extra = '') => `---\nrole: ${role}\ndisplay: ${role}\nmodel_tier: cheap\ntools: [vault.read, finish]\napproval_overrides: {}\nactive: true\nhired: "2026-09-02T00:00:00.000Z"\nsprite: ${role}\ndesk: ${desk}\nteam: ${team}\nreports_to: ${reports_to}\npersona: "p"\npermissions: []\n${extra}---\n# Charter\n\n${role}.\n`;
export const teamNote = (id: string, lead: string, members: string[], extra = '') => `---\nid: ${id}\nname: ${id}\nlead: ${lead}\nmembers: [${members.join(', ')}]\nmission: m\nroom: ${id}\n${extra}processes: []\n---\n# ${id}\n`;

/** A v1 vault: the nine legacy charters, three legacy team notes, a v1 process and an open job for the engineer. */
export async function makeLegacyVault() {
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
