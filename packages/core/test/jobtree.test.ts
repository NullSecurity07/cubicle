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
    const plan = createJob(vault, { type: 'team.plan', title: 'Plan', assigned: 'cto', goal: 'g', team: 'engineering', owner_role: 'cto' }, 'ceo');
    const a = createJob(vault, { type: 'engineer.ship', title: 'A', assigned: 'engineer', goal: 'g', parent: plan, team: 'engineering', owner_role: 'cto', done_when: 'site builds' }, 'cto');
    const b = createJob(vault, { type: 'research', title: 'B', assigned: 'research_analyst', goal: 'g', parent: plan, team: 'research', owner_role: 'cto', for: 'cto' }, 'cto');
    expect(readJob(vault, a)!.data).toMatchObject({ team: 'engineering', owner_role: 'cto', done_when: 'site builds' });
    expect(readJob(vault, b)!.data.for).toBe('cto');
    expect(childrenOf(vault, plan).map((j) => j.id).sort()).toEqual([a, b].sort());
    expect(rollup(vault, plan)).toBe('open');
    expect(rollup(vault, a)).toBe('empty');
    expect(openSubtree(vault, 'cto').map((j) => j.id).sort()).toEqual([plan, a, b].sort());
    updateJob(vault, a, { status: 'done' }, 'engineer');
    updateJob(vault, b, { status: 'in_review' }, 'research_analyst');
    expect(rollup(vault, plan)).toBe('open');
    updateJob(vault, b, { status: 'done' }, 'cto');
    expect(rollup(vault, plan)).toBe('done');
    updateJob(vault, a, { status: 'failed' }, 'engineer');
    expect(rollup(vault, plan)).toBe('failed');
    expect(openSubtree(vault, 'cto').map((j) => j.id)).toEqual([plan]);
  });
});
