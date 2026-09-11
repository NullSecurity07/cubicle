import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { loadOrg } from '../src/org.js';
import { REQUEST_FIELDS } from '../src/research.js';

let dir: string; let vault: Vault; let handbook: string;
beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-hb-')); vault = (await scaffoldVault(dir)).vault; handbook = vault.readText('Docs/research-handbook.md'); });
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('Docs/research-handbook.md', () => {
  it('is short enough to be read and long enough to be useful', () => {
    const lines = handbook.split('\n').length;
    expect(lines).toBeGreaterThan(100);
    expect(lines).toBeLessThan(200);
  });

  it('names every field of the request, so a refused job can be fixed from the handbook alone', () => {
    for (const f of REQUEST_FIELDS) {
      const needle = f === 'hypothesis or exploration' ? 'hypothesis' : f;
      expect(handbook.toLowerCase(), needle).toContain(needle.replace(/_/g, ' ').toLowerCase());
    }
  });

  it('names only tools and paths that exist', () => {
    for (const t of ['research.start', 'sources.cite', 'http.fetch', 'shell.run', 'memory.search', 'vault.search']) {
      expect(handbook, t).toContain(t);
    }
    for (const p of ['Research/index.md', 'Research/archive/', 'Research/intelligence/', 'Ideas/', 'Metrics/research.md', 'Processes/research_lifecycle.md']) {
      expect(handbook, p).toContain(p);
    }
    // shell.run mounts Site/ and a scratch dir, never the vault's Research/ — the handbook must not claim otherwise
    expect(handbook).toMatch(/scratch/);
    expect(handbook).not.toMatch(/cd Research/);
  });

  it('cites the owner document it condenses', () => {
    expect(handbook).toMatch(/docs\/owner\/research-operating-model\.md/);
    for (const s of ['§9', '§20', '§29', '§33', '§34', '§35', '§39', '§41']) expect(handbook, s).toContain(s);
  });

  it('every research charter points at the handbook and carries its taxonomy role', () => {
    const org = loadOrg(vault);
    const members = ['research_manager', 'researcher', 'research_analyst', 'data_scientist', 'intelligence_analyst', 'research_engineer'];
    expect(org.teams.research.members.concat(org.teams.research.lead).sort()).toEqual([...members].sort());
    for (const r of members) {
      const note = vault.readNoteOrNull(`Roles/${r}.md`)!;
      expect(note.body, r).toContain('Docs/research-handbook.md');
      expect(note.body, `${r} taxonomy`).toMatch(/# Role in the research taxonomy/);
    }
    const manager = vault.readNoteOrNull('Roles/research_manager.md')!;
    expect(manager.body).toMatch(/Research Ops/);
    expect(manager.body).toMatch(/Knowledge Manager/);
    expect(manager.data.tools as string[]).toContain('research.start');
    for (const r of members) expect(vault.readNoteOrNull(`Roles/${r}.md`)!.data.tools as string[], r).toContain('sources.cite');
    // I3: the handbook and the lifecycle process both call research.start "the first call of any research job",
    // and expandProcess injects the whole process body into every step's goal — so every charter that writes
    // into a project must be allowed to make that call, not only the manager who files the request.
    // The intelligence analyst writes sweeps, not projects; everyone else does open one.
    for (const r of members.filter((m) => m !== 'intelligence_analyst')) expect(vault.readNoteOrNull(`Roles/${r}.md`)!.data.tools as string[], r).toContain('research.start');
  });

  it('no charter promises something the tools do not do (I7, M3, M7)', () => {
    const ds = vault.readNoteOrNull('Roles/data_scientist.md')!.body;
    expect(ds).toMatch(/does not mount `Research\/`/);            // shell.run mounts Site/ and scratch only
    expect(ds).not.toMatch(/analysis\/` folder with python and sqlite through `shell.run`/);
    const ia = vault.readNoteOrNull('Roles/intelligence_analyst.md')!.body;
    expect(ia).not.toMatch(/regulatory/);                          // there are four kinds, not five
    expect(ia).toContain('<date>-c<cycle>-<kind>.md');
    expect(vault.readNoteOrNull('Teams/research.md')!.data.processes as string[]).toContain('research_lifecycle');
  });

  it('cites no section the owner document does not have', () => {
    // docs/owner/research-operating-model.md ends at §45; research.start is this codebase's tool, not a section.
    for (const m of handbook.match(/§\d+/g) ?? []) expect(Number(m.slice(1)), m).toBeLessThanOrEqual(45);
  });
});
