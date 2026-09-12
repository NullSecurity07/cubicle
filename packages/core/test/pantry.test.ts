import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { readIdea, listIdeas, writeIdeaCard, IDEA_SOURCES } from '../src/ideas.js';
import {
  PANTRY_DIR, PANTRY_MAX_TURNS, PANTRY_OVERLAP_MAX, PANTRY_SOURCE,
  pantrySlug, pantryNotePath, pantryIdea, ideaWords, overlapCoefficient, pantryIdeaIsNew, filePantryIdea, pantryNote,
} from '../src/pantry.js';

const NOW = new Date('2026-09-12T15:30:00.000Z');

describe('the idea rule is arithmetic on strings (spec §7)', () => {
  it('takes the last IDEA line and nothing else', () => {
    expect(pantryIdea('**A:** I keep thinking IDEA: a stale one\n**B:** IDEA: weekly meal kits for nurseries')).toBe('weekly meal kits for nurseries');
    expect(pantryIdea('**A:** hello\n**B:** idea: lower the price for schools')).toBe('lower the price for schools');
    expect(pantryIdea('**A:** **IDEA:** _sell the kits by the term_')).toBe('sell the kits by the term');
  });

  it('returns null for none, for empty and for a fragment', () => {
    expect(pantryIdea('**A:** hi\n**B:** IDEA: none')).toBeNull();
    expect(pantryIdea('**B:** IDEA: None.')).toBeNull();
    expect(pantryIdea('**B:** IDEA:')).toBeNull();
    expect(pantryIdea('**B:** IDEA:    ')).toBeNull();
    expect(pantryIdea('**B:** IDEA: meal kits')).toBeNull();          // three words is a fragment
    expect(pantryIdea('nobody said the word')).toBeNull();
  });

  it('cuts a paragraph down to a title', () => {
    expect(pantryIdea(`IDEA: ${'kits for nurseries '.repeat(20)}`)!.length).toBeLessThanOrEqual(160);
  });

  it('overlap is measured against the shorter title, not the union (Decision 15)', () => {
    const a = ideaWords('Meal kits for nurseries');
    const b = ideaWords('Meal kits for nursery managers');
    expect(a).toEqual(['meal', 'kits', 'nurseries']);
    expect(b).toEqual(['meal', 'kits', 'nursery', 'managers']);
    expect(overlapCoefficient(a, b)).toBeCloseTo(2 / 3, 5);
    expect(overlapCoefficient(a, b)).toBeGreaterThanOrEqual(PANTRY_OVERLAP_MAX);
    // Jaccard on the same pair is 2/5, which would have let the near-duplicate through.
    expect(2 / 5).toBeLessThan(PANTRY_OVERLAP_MAX);
    expect(overlapCoefficient(a, ideaWords('Sell advertising on the school newsletter'))).toBe(0);
    expect(overlapCoefficient([], b)).toBe(0);
  });
});

describe('at most one genuinely new card a day (spec §7)', () => {
  let dir: string; let vault: Vault;
  beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-pantry-')); vault = (await scaffoldVault(dir)).vault; });
  afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

  it('files the card through writeIdeaCard, with the pantry note as its evidence', () => {
    expect(IDEA_SOURCES).toContain(PANTRY_SOURCE);        // SP3 already taught the word
    const note = `${PANTRY_DIR}/2026-09-12-clo-and-cmo.md`;
    const filed = filePantryIdea(vault, { idea: 'Weekly meal kits for nurseries', note, now: NOW });
    expect(filed.slug).toBe('weekly-meal-kits-for-nurseries');
    const card = readIdea(vault, filed.slug!)!;
    expect(card.data.source).toBe(PANTRY_SOURCE);
    expect(card.data.evidence).toEqual([note]);
    expect(card.data.score).toBeNull();                   // still waiting on both offices, like any card
    expect(card.data.decision).toBe('undecided');
    for (const h of ['## What changed', '## Why it might matter', '## Evidence', '## Research', '## What it would cost', '## The board', '## Score', '## Decision']) {
      expect(card.body, h).toContain(h);
    }
  });

  it('refuses the same idea, a near-duplicate, and a second card on the same day — and says which', () => {
    expect(pantryIdeaIsNew(vault, null, NOW)).toEqual({ ok: false, why: 'nothing new came out of the chat' });
    writeIdeaCard(vault, { title: 'Meal kits for nurseries', source: 'discovery' }, 'daemon');
    expect(pantryIdeaIsNew(vault, 'meal kits for nurseries.', NOW).why).toContain('already on the board');
    expect(pantryIdeaIsNew(vault, 'Meal kits for nursery managers', NOW).why).toContain('too close to');
    expect(pantryIdeaIsNew(vault, 'Sell advertising in the school newsletter', NOW).ok).toBe(true);
    expect(filePantryIdea(vault, { idea: 'Sell advertising in the school newsletter', note: 'Pantry/x.md', now: NOW }).slug).toBe('sell-advertising-in-the-school-newsletter');
    // The day's one card is spent: a second, entirely unrelated idea waits for tomorrow.
    const second = filePantryIdea(vault, { idea: 'Run a stall at the county fair', note: 'Pantry/y.md', now: NOW });
    expect(second.slug).toBeNull();
    expect(second.why).toContain('already filed today');
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    expect(filePantryIdea(vault, { idea: 'Run a stall at the county fair', note: 'Pantry/y.md', now: tomorrow }).slug).toBe('run-a-stall-at-the-county-fair');
    expect(listIdeas(vault).filter((i) => i.source === PANTRY_SOURCE)).toHaveLength(2);
  });

  it('another source filing a card today does not spend the pantry\'s one', () => {
    writeIdeaCard(vault, { title: 'Something the sweep found', source: 'intelligence:market' }, 'daemon');
    expect(pantryIdeaIsNew(vault, 'Deliver on Saturday mornings too', NOW).ok).toBe(true);
  });
});

describe('the note (spec §6)', () => {
  let dir: string; let vault: Vault;
  beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-pantry-note-')); vault = (await scaffoldVault(dir)).vault; });
  afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

  it('is named by the day and the pair, and never overwrites an earlier one', () => {
    expect(pantrySlug(['clo', 'cmo'])).toBe('clo-and-cmo');
    const first = pantryNotePath(vault, NOW, ['clo', 'cmo']);
    expect(first).toBe('Pantry/2026-09-12-clo-and-cmo.md');
    vault.writeText(first, 'x\n', 'daemon');
    expect(pantryNotePath(vault, NOW, ['clo', 'cmo'])).toBe('Pantry/2026-09-12-clo-and-cmo-2.md');
  });

  it('carries the figures in frontmatter and the transcript one speaker per line', () => {
    const md = pantryNote({
      date: '2026-09-12', cycle: 7, participants: ['clo', 'cmo'],
      turns: [
        { role: 'clo', name: 'CLO / CCO', text: 'Nurseries keep asking for a weekly box.' },
        { role: 'cmo', name: 'CMO', text: 'IDEA: Weekly meal kits for nurseries' },
      ],
      idea: 'Weekly meal kits for nurseries', filed: 'weekly-meal-kits-for-nurseries', why: 'new',
    });
    expect(md).toContain('cycle: 7');
    expect(md).toContain('turns: 2');
    expect(md).toContain('idea: weekly-meal-kits-for-nurseries');
    expect(md).toContain('## Chat');
    expect(md).toContain('**CLO / CCO:** Nurseries keep asking');
    expect(md).toContain('## Idea');
    expect(md).toContain('[[weekly-meal-kits-for-nurseries]]');
    expect(PANTRY_MAX_TURNS).toBe(6);
  });

  it('says plainly when nothing came of it, and when no model answered at all', () => {
    const nothing = pantryNote({ date: '2026-09-12', cycle: 1, participants: ['clo', 'cmo'], turns: [{ role: 'clo', name: 'CLO', text: 'IDEA: none' }], idea: null, filed: null, why: 'nothing new came out of the chat' });
    expect(nothing).toContain('_Nothing new._');
    expect(nothing).toContain('idea: ""');
    const silent = pantryNote({ date: '2026-09-12', cycle: 1, participants: ['clo', 'cmo'], turns: [], idea: null, filed: null, why: 'nothing new came out of the chat' });
    expect(silent).toContain('no model was available');
    expect(silent).toContain('turns: 0');
    const refused = pantryNote({ date: '2026-09-12', cycle: 1, participants: ['clo', 'cmo'], turns: [{ role: 'clo', name: 'CLO', text: 'IDEA: Meal kits for nurseries again' }], idea: 'Meal kits for nurseries again', filed: null, why: 'too close to Ideas/meal-kits-for-nurseries.md ("Meal kits for nurseries")' });
    expect(refused).toContain('Not filed: too close to Ideas/meal-kits-for-nurseries.md');
  });

  it('a fresh vault has the directory, and an older one gets it on migration', async () => {
    expect(vault.exists(`${PANTRY_DIR}/_about.md`)).toBe(true);
    const { migrateOrg } = await import('../src/org.js');
    const { repoRoot } = await import('../src/template.js');
    vault.remove(`${PANTRY_DIR}/_about.md`, 'owner');
    migrateOrg(vault, path.join(repoRoot(), 'vault-template'));
    expect(vault.exists(`${PANTRY_DIR}/_about.md`)).toBe(true);
  });
});
