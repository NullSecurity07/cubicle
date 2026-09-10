import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { createJob, updateJob, childrenOf, rollup, openSubtree, readJob } from '../src/jobs.js';

let dir: string; let vault: Vault;
beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-tree-')); vault = (await scaffoldVault(dir)).vault; });
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('job tree', () => {
  it('children, rollup and the open subtree per lead', () => {
    const plan = createJob(vault, { type: 'team.plan', title: 'Plan', assigned: 'dev_manager', goal: 'g', team: 'dev', owner_role: 'dev_manager' }, 'cto');
    const a = createJob(vault, { type: 'engineer.ship', title: 'A', assigned: 'backend_engineer', goal: 'g', parent: plan, team: 'dev', owner_role: 'dev_manager', done_when: 'site builds' }, 'dev_manager');
    const b = createJob(vault, { type: 'research', title: 'B', assigned: 'research_manager', goal: 'g', parent: plan, team: 'research', owner_role: 'dev_manager', for: 'dev_manager' }, 'dev_manager');
    expect(readJob(vault, a)!.data).toMatchObject({ team: 'dev', owner_role: 'dev_manager', done_when: 'site builds' });
    expect(readJob(vault, b)!.data.for).toBe('dev_manager');
    expect(childrenOf(vault, plan).map((j) => j.id).sort()).toEqual([a, b].sort());
    expect(rollup(vault, plan)).toBe('open');
    expect(rollup(vault, a)).toBe('empty');
    expect(openSubtree(vault, 'dev_manager').map((j) => j.id).sort()).toEqual([plan, a, b].sort());
    updateJob(vault, a, { status: 'done' }, 'backend_engineer');
    updateJob(vault, b, { status: 'in_review' }, 'research_manager');
    expect(rollup(vault, plan)).toBe('open');
    updateJob(vault, b, { status: 'done' }, 'dev_manager');
    expect(rollup(vault, plan)).toBe('done');
    updateJob(vault, a, { status: 'failed' }, 'backend_engineer');
    expect(rollup(vault, plan)).toBe('failed');
    expect(openSubtree(vault, 'dev_manager').map((j) => j.id)).toEqual([plan]);
  });
});
