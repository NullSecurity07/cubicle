import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IdeaFrontmatter } from '../src/schemas.js';
import { scaffoldVault } from '../src/template.js';
import { parseNote } from '../src/frontmatter.js';

describe('the idea card (minimal; sub-project 3 extends it)', () => {
  it('needs an id, a title and where it came from; everything else has a default', () => {
    const parsed = IdeaFrontmatter.parse({ id: 'competitor-dropped-free-tier', title: 'Competitor dropped its free tier', source: 'intelligence:competitive' });
    expect(parsed).toMatchObject({ status: 'new', evidence: [] });
    expect(typeof parsed.created).toBe('string');
    expect(IdeaFrontmatter.safeParse({ title: 'no id', source: 'x' }).success).toBe(false);
    expect(IdeaFrontmatter.safeParse({ id: 'a', title: 'b', source: 'c', status: 'shipped' }).success).toBe(false);
    for (const s of ['new', 'triaged', 'accepted', 'rejected']) {
      expect(IdeaFrontmatter.safeParse({ id: 'a', title: 'b', source: 'c', status: s }).success, s).toBe(true);
    }
  });

  it('the vault template ships a card that parses', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-ideas-'));
    const { vault } = await scaffoldVault(dir);
    try {
      const note = parseNote(vault.readText('Ideas/_template.md'));
      expect(IdeaFrontmatter.safeParse(note.data).success).toBe(true);
      expect(note.body).toMatch(/## What changed/);
      expect(note.body).toMatch(/## Why it might matter/);
      expect(note.body).toMatch(/## Evidence/);
    } finally { vault.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
