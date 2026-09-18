import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, createProposal, writeIdeaCard, readIdea, keptIdeas, BRAND_NAME_PATH,
  keepOwnerPick, pickedIdeaName, ownerKept, ownerKeptNote,
  isJobDump, whatHappenedSection, whatHappenedProse, WRITTEN_WITHOUT_MODEL,
} from '../src/index.js';

/** The three the CEO proposed and the one the owner took, in the shape `ownerPick` reads. */
const THREE = '1. CrateMate — weekly allergen-checked meal kits for nurseries.\n2. SpeedAudit — free website speed fixes, then a paid deep dive.\n3. Tallyhouse — a stock count app for corner shops.';

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-w4-kept-'));
  vault = (await scaffoldVault(dir)).vault;
  const { path: rel } = createProposal(vault, {
    kind: 'brand_change', from: 'ceo', target: BRAND_NAME_PATH, title: 'Three company ideas — pick one',
    body: `${THREE}\n\nSet \`chosen: 1|2|3\` and \`approved: true\`.`,
  }, 'ceo');
  vault.updateNote(rel, (n) => ({ data: { ...n.data, approved: true, chosen: 2 }, body: n.body }), 'owner');
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe("the idea the owner picked is the idea the owner kept (W4-5)", () => {
  it('reads the company out of the picked line', () => {
    expect(pickedIdeaName('2. SpeedAudit — free website speed fixes, then a paid deep dive.')).toBe('SpeedAudit');
  });

  it('keeps the card the discovery job files minutes after the pick', () => {
    // The live sequence: the `brand_change` resolved at 06:25 and `Ideas/speedaudit.md` was filed at 06:27.
    expect(keepOwnerPick(vault)).toBeNull();
    writeIdeaCard(vault, { title: 'SpeedAudit — Free Website Performance Diagnostics & Consulting Upsell', source: 'discovery' }, 'research_manager');
    expect(keepOwnerPick(vault)).toBe('speedaudit-free-website-performance-diagnostics');
    const card = readIdea(vault, 'speedaudit-free-website-performance-diagnostics')!;
    expect(card.data.decision).toBe('keep');
    expect(card.data.decided_by).toBe('owner');
    expect(card.data.decided_at).not.toBe('');
    expect(card.body).toContain('The owner picked this idea');
    expect(keptIdeas(vault).map((i) => i.id)).toEqual(['speedaudit-free-website-performance-diagnostics']);
  });

  it('is idempotent, and never reverses a later decision of theirs', () => {
    writeIdeaCard(vault, { slug: 'speedaudit', title: 'SpeedAudit', source: 'discovery' }, 'daemon');
    expect(keepOwnerPick(vault)).toBe('speedaudit');
    expect(keepOwnerPick(vault)).toBeNull();
  });

  it('never keeps a card the owner has not seen', () => {
    writeIdeaCard(vault, { slug: 'speedaudit', title: 'SpeedAudit', source: 'intelligence:competitive' }, 'daemon');
    expect(keepOwnerPick(vault)).toBeNull();
  });

  it('knows an owner keep from a board one, and says what the board would have done', () => {
    writeIdeaCard(vault, { slug: 'speedaudit', title: 'SpeedAudit', source: 'discovery' }, 'daemon');
    keepOwnerPick(vault);
    expect(ownerKept(readIdea(vault, 'speedaudit')!.data)).toBe(true);
    expect(ownerKeptNote('park')).toContain('You kept this; the board would park it');
  });
});

describe('the brief has a floor under it (W4-11)', () => {
  /** `Runs/2026-09-18-1057.md` as the second dry-run wrote it: eighteen lines, one job four times. */
  const LIVE_DUMP = [
    '- Runway: 2026-09-18: done',
    '- Competitive intelligence: cycle 6: done',
    '- What would "Automated Stripe webhook replay protection" cost?: done',
    '- Is "Automated Stripe webhook replay protection" worth trying?: failed',
    '- Review: Is "Automated Stripe webhook replay protection" worth trying?: done',
    '- Review: Is "Automated Stripe webhook replay protection" worth trying?: done',
    '- Is "Automated Stripe webhook replay protection" worth trying?: done',
  ].join('\n');

  it('reads the drafted section off a brief', () => {
    expect(whatHappenedSection(`## What happened\n${LIVE_DUMP}\n\n## What's next\n- nothing`)).toBe(LIVE_DUMP);
    expect(whatHappenedSection('## Whats next\n- nothing')).toBe('');
  });

  it('calls the live run a job dump, on both triggers', () => {
    expect(isJobDump(LIVE_DUMP)).toBe(true);
    expect(isJobDump('- Runway: 2026-09-18: done\n- Runway: 2026-09-18: done')).toBe(true);   // repeated
    expect(isJobDump('- The research office priced two board cards; one review came back failed and was re-run.')).toBe(false);
    expect(isJobDump('')).toBe(false);
  });

  it('writes what happened grouped by outcome and deduplicated instead', () => {
    const prose = whatHappenedProse([
      { title: 'Runway: 2026-09-18', status: 'done' },
      { title: 'Is "Automated Stripe webhook replay protection" worth trying?', status: 'done' },
      { title: 'Is "Automated Stripe webhook replay protection" worth trying?', status: 'done' },
      { title: 'Is "Automated Stripe webhook replay protection" worth trying?', status: 'failed' },
    ]);
    expect(prose).toBe([
      '- Finished 2 jobs: Runway: 2026-09-18 and Is "Automated Stripe webhook replay protection" worth trying?.',
      '- Did not finish 1 job: Is "Automated Stripe webhook replay protection" worth trying?.',
    ].join('\n'));
    expect(isJobDump(prose)).toBe(false);
    expect(whatHappenedProse([])).toBe('- Nothing finished since the last heartbeat.');
    expect(WRITTEN_WITHOUT_MODEL).toBe('Written without the model (quota).');
  });
});
