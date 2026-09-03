import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, loadOrg, loadGates } from '@cubicle/core';
import { assembleContext, readRole, MEMORY_DIRS } from '../src/index.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-ctx-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('role-shaped prompts (spec §5)', () => {
  it('persona, team, open work, criteria and review findings appear as blocks', async () => {
    const id = createJob(vault, { type: 'engineer.ship', title: 'Build', assigned: 'engineer', goal: 'g', team: 'engineering', owner_role: 'cto', done_when: 'it builds' }, 'cto');
    const other = createJob(vault, { type: 'custom', title: 'Later', assigned: 'engineer', goal: 'g', team: 'engineering', owner_role: 'cto' }, 'cto');
    vault.updateNote(`Jobs/${id}.md`, (n) => ({ data: n.data, body: n.body + '\n## Review findings\n\n- qa.review: index.html has no title\n' }), 'daemon');
    const role = readRole(vault, 'engineer')!;
    const msgs = await assembleContext({ vault, role: role.data, roleBody: role.body, job: readJob(vault, id)!.data, jobBody: readJob(vault, id)!.body, observations: [], maxPromptTokens: 6000, org: loadOrg(vault), gates: loadGates(), maxSteps: 25 });
    const sys = String(msgs[0].content);
    expect(sys).toContain('# Who you are'); expect(sys).toContain('DHH');
    expect(sys).toContain('# Your team'); expect(sys).toMatch(/lead: CTO/i); expect(sys).toContain('qa');
    expect(sys).toContain('# Your open work'); expect(sys).toContain('Later');
    expect(sys).toContain('# What good looks like'); expect(sys).toContain('Done when: it builds');
    expect(sys).toContain('The reviewer returned this job'); expect(sys).toContain('index.html has no title');
    expect(sys).toContain('plan your next three steps');
    expect(sys.indexOf('# Who you are')).toBeGreaterThan(sys.indexOf('# Your charter'));
  });
  it('lessons tagged with another team are filtered from the memory block; Docs is indexed', () => {
    expect(MEMORY_DIRS).toContain('Docs');
  });
});
