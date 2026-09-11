import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, templateDir } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { loadOrg, migrateOrg } from '../src/org.js';
import { readProcess, expandProcess, MAX_PROCESS_STEPS } from '../src/processes.js';
import { readJob } from '../src/jobs.js';
import { INDEX_HEADER } from '../src/research.js';

let dir: string; let vault: Vault;
beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-rvault-')); vault = (await scaffoldVault(dir)).vault; });
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('the research area of the vault', () => {
  it('ships an index with the table header the daemon appends to, and the three reserved directories', () => {
    expect(vault.readText('Research/index.md')).toContain(INDEX_HEADER);
    for (const d of ['Research/intelligence', 'Research/archive', 'Research/followups']) {
      expect(existsSync(path.join(dir, d)), d).toBe(true);
    }
    expect(existsSync(path.join(dir, 'Ideas/_template.md'))).toBe(true);
    expect(existsSync(path.join(dir, 'Metrics/research.md'))).toBe(true);
  });

  it('research_lifecycle expands into a chain of active roles ending in a gated research job', () => {
    const p = readProcess(vault, 'research_lifecycle')!;
    expect(p.steps.length).toBeGreaterThanOrEqual(3);
    expect(p.steps.length).toBeLessThanOrEqual(MAX_PROCESS_STEPS);
    const org = loadOrg(vault);
    for (const s of p.steps) expect(org.roles[s.role], s.role).toBeDefined();
    expect(p.steps.at(-1)!.type).toBe('research');
    expect(p.body).toMatch(/existing evidence/i);
    expect(p.body).toMatch(/stopping/i);

    const ids = expandProcess(vault, 'research_lifecycle', 'pricing', { by: 'ceo', owner_role: 'research_manager', team: 'research' });
    expect(ids).toHaveLength(p.steps.length);
    const jobs = ids.map((id) => readJob(vault, id)!.data);
    expect(jobs[0].depends_on).toEqual([]);
    expect(jobs[1].depends_on).toEqual([ids[0]]);
    expect(jobs.every((j) => j.title.includes('pricing'))).toBe(true);
  });
});

describe('migration brings an older vault up to the research area', () => {
  it('copies Research/, Ideas/ and Metrics/research.md without clobbering anything', async () => {
    const old = mkdtempSync(path.join(tmpdir(), 'cubicle-rmig-'));
    const { vault: v } = await scaffoldVault(old);
    try {
      v.writeText('Research/index.md', '# my own index\n', 'daemon');
      v.remove('Ideas/_template.md', 'daemon');
      v.remove('Metrics/research.md', 'daemon');
      const { changed } = migrateOrg(v, templateDir());
      expect(changed).toContain('Ideas/_template.md');
      expect(changed).toContain('Metrics/research.md');
      expect(changed).not.toContain('Research/index.md');       // present, so left alone
      expect(v.readText('Research/index.md')).toBe('# my own index\n');
      expect(v.exists('Ideas/_template.md')).toBe(true);
    } finally { v.close(); rmSync(old, { recursive: true, force: true }); }
  });
});
