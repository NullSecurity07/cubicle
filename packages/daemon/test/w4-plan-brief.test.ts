import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, createProposal, writeIdeaCard, updateIdea, readIdea, listInbox, keptIdeas,
  createJob, BRAND_NAME_PATH, NOTHING_PLANNED, PIVOT_TITLE_LABEL, keepOwnerPick, nowIso,
} from '@cubicle/core';
import {
  planVerdictBody, planIdeaRule, chairFormat, closeIdeaVerdicts, fileIdeaVerdict,
} from '../src/index.js';

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-w4-plan-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

/** A card both offices have answered and the board has returned — the shape an `idea_verdict` is filed from. */
function judgedCard(slug: string, title: string): void {
  writeIdeaCard(vault, { slug, title, source: 'discovery', evidence: ['the owner asked for it'] }, 'daemon');
  updateIdea(vault, slug, {
    score_inputs: { value: 4, evidence: 4, effort: 5, fit: 5 },
    research: `Research/${slug}/report.md`, estimate: 'One person, one week.',
    board_verdict: 'return', board_pressure: 'PIVOT REQUIRED',
  }, 'daemon');
}

describe('the plan says where the board and the CEO disagree (W4-2)', () => {
  it('names the pivot card and both options, and leaves the sentence out when there is no pivot', () => {
    const withPivot = planVerdictBody({ board: 'return', findings: ['Demand: nobody has paid.'], plan: '# Plan', decidesAfterHours: 0, pivot: 'anchor-customer-pilots' });
    expect(withPivot).toContain('The board and the CEO disagree: approve the plan as written, or keep the pivot card [[Ideas/anchor-customer-pilots]].');
    expect(planVerdictBody({ board: 'pass', findings: [], plan: '# Plan', decidesAfterHours: 0 })).not.toContain('disagree');
  });
});

describe('an objective names an idea, never a trailing stream (W4-5)', () => {
  it('asks the CEO for the idea marker and forbids the stream one', () => {
    const rule = planIdeaRule(['speedaudit']);
    expect(rule).toContain('idea: <slug>');
    expect(rule).toContain('Write no "stream:" on an objective');
  });

  it('tells the CEO there is nothing to plan when nothing is kept', () => {
    expect(planIdeaRule([])).toContain(NOTHING_PLANNED);
  });
});

describe('a board park never writes over a keep the owner made (W4-5)', () => {
  it('leaves the card alone and says so on the note the owner reads', () => {
    judgedCard('speedaudit', 'SpeedAudit — free website speed fixes');
    const filed = fileIdeaVerdict(vault, 'speedaudit', { from: 'advisor_skeptic', findings: ['Demand: nobody has paid.'] })!;
    expect(filed.band).toBe('park');
    // The owner picked it by name; only now does the board's clock run out on it.
    updateIdea(vault, 'speedaudit', { decision: 'keep', decided_by: 'owner', decided_at: nowIso(), status: 'accepted' }, 'daemon');
    // Backdate the note so `board_decides_after_hours` has elapsed on it.
    vault.updateNote(filed.path, (n) => ({ data: { ...n.data, created: '2026-01-01T00:00:00.000Z' }, body: n.body }), 'daemon');
    expect(closeIdeaVerdicts(vault, { now: new Date('2026-01-03T00:00:00.000Z'), decidesAfterHours: 24 })).toBe(1);
    const card = readIdea(vault, 'speedaudit')!;
    expect(card.data.decision).toBe('keep');
    expect(card.data.decided_by).toBe('owner');
    expect(keptIdeas(vault).map((i) => i.id)).toEqual(['speedaudit']);
    expect(vault.readText(filed.path)).toContain('You kept this; the board would park it');
  });

  it('still closes a verdict on a card nobody kept', () => {
    judgedCard('shopify-pixels', 'Shopify tracking pixels');
    const filed = fileIdeaVerdict(vault, 'shopify-pixels', { from: 'advisor_skeptic', findings: [] })!;
    vault.updateNote(filed.path, (n) => ({ data: { ...n.data, created: '2026-01-01T00:00:00.000Z' }, body: n.body }), 'daemon');
    expect(closeIdeaVerdicts(vault, { now: new Date('2026-01-03T00:00:00.000Z'), decidesAfterHours: 24 })).toBe(1);
    expect(readIdea(vault, 'shopify-pixels')!.data.decided_by).toBe('board');
  });

  it("puts the owner's own keep at the top of the verdict note", () => {
    judgedCard('speedaudit', 'SpeedAudit — free website speed fixes');
    updateIdea(vault, 'speedaudit', { decision: 'keep', decided_by: 'owner', decided_at: nowIso(), status: 'accepted' }, 'daemon');
    const filed = fileIdeaVerdict(vault, 'speedaudit', { from: 'advisor_skeptic', findings: [] })!;
    expect(listInbox(vault).find((n) => n.data.id === filed.id)!.body).toContain('You kept this; the board would park it');
  });
});

describe('the chair is asked to name its pivot (W4-7)', () => {
  it('asks for a product and a customer on the line the card is titled from', () => {
    const format = chairFormat().join('\n');
    expect(format).toContain(PIVOT_TITLE_LABEL);
    expect(format).toContain('<product> for <customer>');
  });
});

describe('the pick is a keep before the plan is written (W4-5)', () => {
  it('finds the card the discovery job filed after the owner picked its name', () => {
    const { path: rel } = createProposal(vault, {
      kind: 'brand_change', from: 'ceo', target: BRAND_NAME_PATH, title: 'Three company ideas — pick one',
      body: '1. CrateMate — meal kits.\n2. SpeedAudit — free website speed fixes.\n3. Tallyhouse — stock counts.',
    }, 'ceo');
    vault.updateNote(rel, (n) => ({ data: { ...n.data, approved: true, chosen: 2 }, body: n.body }), 'owner');
    writeIdeaCard(vault, { slug: 'speedaudit', title: 'SpeedAudit — free website speed fixes', source: 'discovery' }, 'research_manager');
    expect(keepOwnerPick(vault)).toBe('speedaudit');
    expect(keptIdeas(vault)).toHaveLength(1);
  });
});
