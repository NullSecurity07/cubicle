import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { pressurePivot, productFixes } from '../src/pressure.js';
import { fileBoardPivot, pivotTitle, listIdeas, readIdea, BOARD_IDEA_SOURCE } from '../src/ideas.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-pivot-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

/** The live run's own pressure test on the founder brief, verbatim from the note the owner adopted. */
const LIVE_BRIEF_TEST = [
  '**Core Assumption:** unstated — QUESTION FOR THE OWNER: What concrete validation shows that founders would pay?',
  '**Three Fatal Flaws:** AltStack’s current model collapses because budget-conscious founders reject paid static directories.; **Monetization Paradox:** Target users optimize for zero software burn and will bypass paywalls; fix by replacing the subscription with affiliate-driven VPS hosting referrals.',
  '**Problem Validation:** unstated',
  '**Founder-Market Fit:** unstated',
  '**Brutal Verdict:** PIVOT REQUIRED — The static directory model fails to capture value from founders who trade their own labor for free software, necessitating a pivot from a subscription-based newsletter to a high-intent, affiliate-driven deployment service.',
].join('\n');

/** The live run's plan board session findings, verbatim from Meetings/2026-09-13-1826-board-plan.md. */
const LIVE_PLAN_FINDINGS = [
  'Demand: Open-source maintainers will not buy self-verification badges for $0-alternative tasks; fix by targeting commercial compliance needs where verification unblocks enterprise sales.',
  'Distribution: Static directories have zero organic reach for developers living in GitHub and Reddit; fix by executing direct outreach to maintainers with active supply-chain friction.',
  'Economics: A $100 price point fails if the value proposition is just developer convenience; fix by pricing the signed SBOM attestation at a level that offsets enterprise sales cycle costs.',
  'Execution: Cycle one objectives currently build a static landing page instead of testing the manual procurement bottleneck; fix by replacing the tech build with a 20-maintainer manual validation test.',
];

describe('pressurePivot', () => {
  it('reads the chair\'s own words after PIVOT REQUIRED, on the live brief', () => {
    expect(pressurePivot(LIVE_BRIEF_TEST)).toContain('affiliate-driven deployment service');
  });

  it('reads nothing out of STRONG or WEAK: neither of those proposes anything', () => {
    expect(pressurePivot('**Brutal Verdict:** STRONG — the pain is real and they pay for it today.')).toBe('');
    expect(pressurePivot('VERDICT: WEAK — nobody wants it at that price.')).toBe('');
  });

  it('falls back to the WEDGE line when the chair answered the machine line and reasoned elsewhere', () => {
    expect(pressurePivot('VERDICT: PIVOT REQUIRED\nWEDGE: the forty-site nursery chains, not single nurseries')).toBe('the forty-site nursery chains, not single nurseries');
  });
});

describe('productFixes', () => {
  it('takes the fixes that change what the company sells and leaves the one about how it works', () => {
    const fixes = productFixes(LIVE_PLAN_FINDINGS);
    expect(fixes).toHaveLength(3);
    expect(fixes[0]).toContain('commercial compliance needs');
    expect(fixes.join(' ')).toContain('signed SBOM attestation');
    expect(fixes.join(' ')).not.toContain('20-maintainer manual validation test');
  });

  it('reads nothing out of a finding that proposes nothing', () => {
    expect(productFixes(['Demand: nobody wants it.', 'Economics: the price is wrong.'])).toEqual([]);
  });
});

describe('pivotTitle', () => {
  it('names what the board wants instead, not what it said was wrong', () => {
    expect(pivotTitle(pressurePivot(LIVE_BRIEF_TEST), 'the founder brief')).toBe('A high-intent, affiliate-driven deployment service');
  });

  it('falls back to naming the subject rather than titling a card with a complaint', () => {
    expect(pivotTitle('no.', 'the founder brief')).toBe('Board pivot on the founder brief');
  });
});

describe('fileBoardPivot', () => {
  const live = { pivot: pressurePivot(LIVE_BRIEF_TEST), subject: 'the founder brief', transcript: 'Meetings/2026-09-13-1804-board-founder-brief.md', by: 'advisor_investor' };

  it('files the SBOM/deployment pivot as a candidate card the owner has to keep', () => {
    const slug = fileBoardPivot(vault, live)!;
    const card = readIdea(vault, slug)!;
    expect(card.data.source).toBe(BOARD_IDEA_SOURCE);
    expect(card.data.decision).toBe('undecided');
    expect(card.data.evidence).toEqual([live.transcript]);
    expect(card.body).toContain('affiliate-driven deployment service');
    expect(card.body).toContain('Nothing is planned against this until you keep it.');
  });

  it('is idempotent on the transcript, not on the words: one session, one card', () => {
    const first = fileBoardPivot(vault, live);
    // The same session read again, with the chair's words remembered slightly differently.
    const second = fileBoardPivot(vault, { ...live, pivot: 'Pivot to selling the SBOM to the enterprise buyer directly.' });
    expect(second).toBe(first);
    expect(listIdeas(vault)).toHaveLength(1);
  });

  it('files nothing when the board proposed nothing', () => {
    expect(fileBoardPivot(vault, { ...live, pivot: '' })).toBeNull();
    expect(listIdeas(vault)).toEqual([]);
  });
});
