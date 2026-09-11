import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault } from '@cubicle/core';
import { MemoryIndex, hashEmbed, MEMORY_DIRS } from '../src/memory.js';

let dir: string; let vault: Vault; let index: MemoryIndex;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-handbook-mem-')); vault = (await scaffoldVault(dir)).vault;
  index = new MemoryIndex(vault, hashEmbed());
  await index.indexAll();
});
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('the handbook and the radar are reachable by memory search', () => {
  it('Docs/ is an indexed directory', () => {
    expect(MEMORY_DIRS).toContain('Docs');
  });

  it('both documents are in the index', async () => {
    const all = await index.search('engineering', 50, ['Docs']);
    const paths = all.map((h) => h.path);
    expect(paths).toContain('Docs/engineering-handbook.md');
    expect(paths).toContain('Docs/tech-radar.md');
  });

  it('a question an engineer would actually ask finds the handbook', async () => {
    const hits = await index.search('work in progress limit kanban lane', 5, ['Docs']);
    expect(hits.map((h) => h.path)).toContain('Docs/engineering-handbook.md');
  });

  it('a question about adding a dependency finds the radar', async () => {
    const hits = await index.search('can we self-host this tool, is it open source, can data be exported', 5, ['Docs']);
    expect(hits.map((h) => h.path)).toContain('Docs/tech-radar.md');
  });
});
