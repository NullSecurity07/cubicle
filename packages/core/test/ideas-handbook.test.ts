import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { parseNote } from '../src/frontmatter.js';
import { KEEP_AT, PARK_AT, IDEA_SCORE_MAX, IDEA_SCORE_WEIGHTS, SWEEP_IDEAS_SECTION, OWNER_SEEN_IDEA_SOURCES } from '../src/ideas.js';
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

  // Ruling W3-5: the board sits only on ideas the owner has seen, and the one way to promote a card it has not
  // is a frontmatter flag. There is no parser for it, so the handbook is where that rule lives — if it drifts
  // from `ownerHasSeenIdea` / the brief's own wording, nobody ever finds out.
  it('says which cards reach the board, and how the owner promotes one that would not', () => {
    const md = vault.readText('Docs/ideas-handbook.md');
    expect(md).toContain('`decision: keep`');
    expect(md).toContain(SWEEP_IDEAS_SECTION.replace(/^#+\s*/, ''));
    for (const s of OWNER_SEEN_IDEA_SOURCES) expect(md, s).toContain(s);
    expect(md).toMatch(/intelligence[\s\S]{0,200}not/i);
  });

  it('is short enough that an agent will read it', () => {
    expect(vault.readText('Docs/ideas-handbook.md').split('\n').length).toBeLessThan(120);
  });
});

describe('Processes/discovery.md', () => {
  it('is prose, not steps: the daemon owns the one discovery job there may be', () => {
    // A `process: discovery` line in a plan used to mint a second `discovery` job with a random id, which
    // `discoveryJobId(digest)` idempotence cannot see — a whole research lifecycle over material already read —
    // plus a `finance.estimate` job naming no card at all (whole-branch review, minor 6).
    const note = parseNote(vault.readText('Processes/discovery.md'));
    expect(note.data.steps).toBeUndefined();
    expect(() => expandProcess(vault, 'discovery', 'Understand the company', { by: 'ceo', owner_role: 'ceo' })).toThrow(/unknown process/);
    expect(note.body).toContain(DISCOVERY_INBOX);
  });

  it('still reads as the account of what discovery does', () => {
    const note = parseNote(vault.readText('Processes/discovery.md'));
    expect(note.body).toContain(FOUNDER_BRIEF);
    for (const s of FOUNDER_BRIEF_SECTIONS) expect(note.body).toContain(s);
    for (const t of ['discovery.inputs', 'idea.card', 'research.start', 'sources.cite']) expect(note.body, t).toContain(t);
  });
});
