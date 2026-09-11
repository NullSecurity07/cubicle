import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { parseNote } from '../src/frontmatter.js';
import { KEEP_AT, PARK_AT, IDEA_SCORE_MAX, IDEA_SCORE_WEIGHTS } from '../src/ideas.js';
import { FOUNDER_BRIEF, FOUNDER_BRIEF_SECTIONS, DISCOVERY_INBOX } from '../src/discovery.js';
import { expandProcess } from '../src/processes.js';

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-ideas-hb-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('Docs/ideas-handbook.md', () => {
  it('states the scoring rule the code actually computes', () => {
    const md = vault.readText('Docs/ideas-handbook.md');
    expect(md).toContain(`${IDEA_SCORE_WEIGHTS.value} × value`);
    expect(md).toContain(`${IDEA_SCORE_WEIGHTS.evidence} × evidence`);
    expect(md).toContain(`${IDEA_SCORE_WEIGHTS.effort} × effort`);
    expect(md).toContain(`${IDEA_SCORE_WEIGHTS.fit} × fit`);
    expect(md).toContain(String(IDEA_SCORE_MAX));
    expect(md).toContain(`Keep at ${KEEP_AT}`);
    expect(md).toContain(`park at ${PARK_AT}`);
    expect(md).toMatch(/effort[^.]*inverted/i);
  });

  it('names the real paths and the real tools, and no invented ones', () => {
    const md = vault.readText('Docs/ideas-handbook.md');
    for (const s of [FOUNDER_BRIEF, DISCOVERY_INBOX, 'Ideas/<slug>.md', 'idea.card', 'discovery.inputs', 'research.start', 'sources.cite']) {
      expect(md, s).toContain(s);
    }
    expect(md).not.toMatch(/idea\.score|ideas\.rank|Ledger\//);   // tools and paths that do not exist
  });

  it('says who fills what, and that a plan may draw only on kept ideas', () => {
    const md = vault.readText('Docs/ideas-handbook.md');
    expect(md).toMatch(/research office[^.]*evidence[^.]*fit/i);
    expect(md).toMatch(/finance office[^.]*value[^.]*effort/i);
    expect(md).toMatch(/only[^.]*kept/i);
  });

  it('is short enough that an agent will read it', () => {
    expect(vault.readText('Docs/ideas-handbook.md').split('\n').length).toBeLessThan(120);
  });
});

describe('Processes/discovery.md', () => {
  it('expands into the steps discovery actually runs, on real roles', () => {
    const ids = expandProcess(vault, 'discovery', 'Understand the company', { by: 'ceo', owner_role: 'ceo' });
    expect(ids.length).toBeGreaterThan(0);
    const note = parseNote(vault.readText('Processes/discovery.md'));
    for (const step of (note.data.steps as { role: string }[])) expect(vault.exists(`Roles/${step.role}.md`)).toBe(true);
    expect(note.body).toContain(FOUNDER_BRIEF);
    for (const s of FOUNDER_BRIEF_SECTIONS) expect(note.body).toContain(s);
  });
});
