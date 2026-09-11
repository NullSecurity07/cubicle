import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, loadOrg, loadGates } from '@cubicle/core';
import { assembleContext, readRole, MEMORY_DIRS, filterMemoryHits } from '../src/index.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-ctx-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('role-shaped prompts (spec §5)', () => {
  it('persona, team, open work, criteria and review findings appear as blocks', async () => {
    const id = createJob(vault, { type: 'engineer.ship', title: 'Build', assigned: 'backend_engineer', goal: 'g', team: 'dev', owner_role: 'dev_manager', done_when: 'it builds' }, 'dev_manager');
    const other = createJob(vault, { type: 'custom', title: 'Later', assigned: 'backend_engineer', goal: 'g', team: 'dev', owner_role: 'dev_manager' }, 'dev_manager');
    vault.updateNote(`Jobs/${id}.md`, (n) => ({ data: n.data, body: n.body + '\n## Review findings\n\n- team:qa.review: index.html has no title\n' }), 'daemon');
    const role = readRole(vault, 'backend_engineer')!;
    const msgs = await assembleContext({ vault, role: role.data, roleBody: role.body, job: readJob(vault, id)!.data, jobBody: readJob(vault, id)!.body, observations: [], maxPromptTokens: 6000, org: loadOrg(vault), gates: loadGates(), maxSteps: 25 });
    const sys = String(msgs[0].content);
    expect(sys).toContain('# Who you are'); expect(sys).toContain('DHH');
    expect(sys).toContain('# Your team'); expect(sys).toMatch(/lead: Dev Manager/i); expect(sys).toContain('Frontend Engineer');
    expect(sys).toContain('# Your open work'); expect(sys).toContain('Later');
    expect(sys).toContain('# What good looks like'); expect(sys).toContain('Done when: it builds');
    expect(sys).toContain('The reviewer returned this job'); expect(sys).toContain('index.html has no title');
    expect(sys).toContain('plan your next three steps');
    expect(sys.indexOf('# Who you are')).toBeGreaterThan(sys.indexOf('# Your charter'));
  });
  it('lessons tagged with another team are filtered from the memory block; Docs is indexed', () => {
    expect(MEMORY_DIRS).toContain('Docs');
  });

  it('filterMemoryHits drops other teams\' lines but keeps the reader\'s own and untagged lines', () => {
    const mixed = [{ path: 'Memory/lessons.md', score: 0.9, text: [
      '- [2026-09-03] [[job-a]] send the newsletter on Tuesdays (cmo) #team:revenue',
      '- [2026-09-03] [[job-b]] use retries for flaky network calls (backend_engineer) #team:dev',
      '- [2026-09-03] [[job-c]] keep the constitution short (ceo)',
    ].join('\n') }];

    const forDev = filterMemoryHits(mixed, 'dev');
    expect(forDev).toHaveLength(1);
    expect(forDev[0].text).toContain('use retries for flaky network calls');
    expect(forDev[0].text).toContain('keep the constitution short');
    expect(forDev[0].text).not.toContain('send the newsletter on Tuesdays');

    const forRevenue = filterMemoryHits(mixed, 'revenue');
    expect(forRevenue).toHaveLength(1);
    expect(forRevenue[0].text).toContain('send the newsletter on Tuesdays');
    expect(forRevenue[0].text).toContain('keep the constitution short');
    expect(forRevenue[0].text).not.toContain('use retries for flaky network calls');

    const onlyOtherTeam = [{ path: 'Memory/lessons.md', score: 0.9, text: '- [2026-09-03] [[job-a]] send the newsletter on Tuesdays (cmo) #team:revenue' }];
    expect(filterMemoryHits(onlyOtherTeam, 'dev')).toHaveLength(0);

    expect(filterMemoryHits(mixed, undefined)).toEqual(mixed);
  });
});
