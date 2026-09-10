import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LEGACY_ROLES, resolveRole, researchLead, loadOrg, type Org } from '../src/org.js';
import { expandProcess } from '../src/processes.js';
import { readJob } from '../src/jobs.js';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';

const role = (r: string, team: string, reports_to: string) => ({ role: r, display: r, model_tier: 'medium' as const, tools: [], approval_overrides: {}, active: true, hired: 'x', sprite: r, desk: r, team, reports_to, permissions: [] });
const tower: Org = {
  teams: {
    executive: { id: 'executive', name: 'Executive', lead: 'ceo', members: [], mission: '', processes: [] },
    board: { id: 'board', name: 'Board', lead: 'advisor_skeptic', members: [], mission: '', processes: [] },
    dev: { id: 'dev', name: 'Dev', lead: 'dev_manager', members: ['backend_engineer'], mission: '', processes: [] },
    qa: { id: 'qa', name: 'QA', lead: 'qa_lead', members: [], mission: '', processes: [] },
    research: { id: 'research', name: 'Research', lead: 'research_manager', members: ['research_analyst'], mission: '', processes: [] },
  },
  roles: Object.fromEntries([['ceo', 'executive', 'owner'], ['advisor_skeptic', 'board', 'ceo'], ['dev_manager', 'dev', 'cto'], ['backend_engineer', 'dev', 'dev_manager'], ['qa_lead', 'qa', 'cto'], ['research_manager', 'research', 'coo'], ['research_analyst', 'research', 'research_manager']].map(([r, t, l]) => [r, role(r, t, l)])),
};

describe('legacy role aliasing', () => {
  it('maps the six legacy ids (and growth) to tower roles only when the legacy id is not itself active', () => {
    expect(Object.keys(LEGACY_ROLES).sort()).toEqual(['critic', 'engineer', 'growth', 'head_of_growth', 'qa', 'research_analyst', 'tech_lead']);
    expect(resolveRole(tower, 'critic')).toBe('advisor_skeptic');
    expect(resolveRole(tower, 'engineer')).toBe('dev_manager');
    expect(resolveRole(tower, 'tech_lead')).toBe('dev_manager');
    expect(resolveRole(tower, 'qa')).toBe('qa_lead');
    expect(resolveRole(tower, 'research_analyst')).toBe('research_analyst'); // active member in the tower: no aliasing
    expect(resolveRole(tower, 'head_of_growth')).toBe('head_of_growth');      // alias cmo is not active in this fixture → unchanged
    expect(resolveRole(tower, 'dev_manager')).toBe('dev_manager');
    expect(resolveRole(tower, 'nobody')).toBe('nobody');
  });
  it('researchLead is the research team lead, the legacy analyst as a fallback, null without either', () => {
    expect(researchLead(tower)).toBe('research_manager');
    const legacy: Org = { teams: { research: { id: 'research', name: 'Research', lead: 'research_analyst', members: [], mission: '', processes: [] } }, roles: { research_analyst: role('research_analyst', 'research', 'ceo') } };
    expect(researchLead(legacy)).toBe('research_analyst');
    expect(researchLead({ teams: {}, roles: {} })).toBeNull();
  });
});

describe('expandProcess resolves a legacy step role', () => {
  let dir: string; let vault: Vault;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cubicle-alias-'));
    vault = (await scaffoldVault(dir)).vault;
    // Works with either template: make sure dev_manager is active and tech_lead is not.
    if (!vault.exists('Roles/dev_manager.md')) vault.writeText('Roles/dev_manager.md', '---\nrole: dev_manager\ndisplay: Dev Manager\nactive: true\nhired: "x"\nsprite: dev_manager\ndesk: dev_manager\nteam: engineering\nreports_to: cto\n---\n# Charter\n\nLeads Dev.\n', 'daemon');
    if (vault.exists('Roles/tech_lead.md')) vault.updateNote('Roles/tech_lead.md', (n) => ({ data: { ...n.data, active: false }, body: n.body }), 'daemon');
    vault.writeText('Processes/legacy_step.md', '---\nname: legacy_step\nsteps:\n  - { role: tech_lead, type: custom, title: "Split: {objective}" }\n---\nA v1 process that still names the tech lead.\n', 'daemon');
  });
  afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });
  it('assigns the step to the alias and still refuses an id with no alias', () => {
    expect(loadOrg(vault).roles.tech_lead).toBeUndefined();
    const [id] = expandProcess(vault, 'legacy_step', 'x', { by: 'ceo', owner_role: 'ceo' });
    expect(readJob(vault, id)!.data.assigned).toBe('dev_manager');
    vault.writeText('Processes/broken.md', '---\nname: broken\nsteps:\n  - { role: nope, type: custom, title: "X" }\n---\nx\n', 'daemon');
    expect(() => expandProcess(vault, 'broken', 'x', { by: 'ceo', owner_role: 'ceo' })).toThrow(/unknown or inactive role nope in process broken/);
  });
});
