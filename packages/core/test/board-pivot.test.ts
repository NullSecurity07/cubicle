import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { pressurePivot, productFixes } from '../src/pressure.js';
import { fileBoardPivot, pivotTitle, pivotProduct, pivotNamesAProduct, listIdeas, readIdea, BOARD_IDEA_SOURCE } from '../src/ideas.js';

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

/**
 * The *other* spelling the same live board used, verbatim from the 18:27 plan session — the one the first cut of
 * `productFixes` read as nothing at all, so the whole of ruling W3-2 was a silent no-op on that session.
 */
const LIVE_FIX_COLON_FINDINGS = [
  '**Failure Mode (Economics):** The plan assumes a market for "signed attestations" where none exists; buyers currently treat this as a zero-cost compliance checkbox. **Fix:** Pivot to selling an insurance-backed remediation service for a specific, high-cost supply-chain failure mode.',
  '**Failure Mode (Distribution):** The plan relies on manual cold-outreach to maintainers who have no incentive to adopt a new, unproven standard. **Fix:** Partner with an existing security-focused CI/CD platform to embed the solution as a native, value-added plugin.',
  '**Failure Mode (Execution):** The plan focuses on "verification protocols" (engineering) rather than "Cost of Non-Compliance" (sales). **Fix:** Replace the engineering-heavy objectives with a requirement to secure three Letters of Intent (LOIs) from CISOs.',
];

describe('productFixes', () => {
  it('takes the fixes that change what the company sells and leaves the one about how it works', () => {
    const fixes = productFixes(LIVE_PLAN_FINDINGS);
    expect(fixes).toHaveLength(3);
    expect(fixes[0]).toContain('commercial compliance needs');
    expect(fixes.join(' ')).toContain('signed SBOM attestation');
    expect(fixes.join(' ')).not.toContain('20-maintainer manual validation test');
  });

  it('reads the chair\'s other spelling too — `**Fix:** …` after a bolded failure mode', () => {
    const fixes = productFixes(LIVE_FIX_COLON_FINDINGS);
    expect(fixes).toHaveLength(2);
    expect(fixes[0]).toContain('insurance-backed remediation service');
    expect(fixes[1]).toContain('security-focused CI/CD platform');
    // The subject is read out of `**Failure Mode (Execution):**`, not off the first word of the line, so the
    // process fix is still left where it belongs — in the next plan.
    expect(fixes.join(' ')).not.toContain('Letters of Intent');
  });

  it('reads nothing out of a finding that proposes nothing', () => {
    expect(productFixes(['Demand: nobody wants it.', 'Economics: the price is wrong.'])).toEqual([]);
  });
});

describe('pivotTitle', () => {
  it('names what the board wants instead, not what it said was wrong', () => {
    // Ruling W4-7: the article comes off with the verb, so the title is a thing and never an instruction.
    expect(pivotTitle(pressurePivot(LIVE_BRIEF_TEST), 'the founder brief')).toBe('High-intent, affiliate-driven deployment service');
  });

  it('never titles a card with a verb phrase, and names the customer the wedge aimed at (W4-7)', () => {
    // Both live cases. The chore the owner was asked to rule on — `Ideas/secure-at-least-one-anchor-customer…`
    // — and the wedge the chair actually wrote on `Ideas/speedaudit.md`.
    expect(pivotTitle('Secure at least one anchor customer who has documented a ≥$500 monthly bill spike', 'this cycle\'s plan'))
      .toBe('Anchor customer who has documented a ≥$500 monthly bill spike');
    expect(pivotTitle('WEDGE: E-commerce founders doing $10k–$50k/month on Shopify whose checkout mobile load times exceed 4 seconds, targeted via a 60-second personalized Loom screen-recording audit', 'Ideas/speedaudit'))
      // A product, then who it is for — cut to a filename's worth of words, not to the first clause of a complaint.
      .toBe('60-second personalized Loom screen-recording audit for E-commerce…');
  });

  it("uses the chair's own PIVOT TITLE line when it wrote one (W4-7)", () => {
    const said = 'VERDICT: PIVOT REQUIRED\nWEDGE: teams with a documented bill spike\nPIVOT TITLE: Anchor-customer pilots for teams with a documented bill spike';
    expect(pivotTitle(said, 'the founder brief')).toBe('Anchor-customer pilots for teams with a documented bill spike');
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
    expect(card.body).toContain('Nothing is planned against it until you keep it.');
    // Ruling W4-7: the chair's own sentence is the first line of the card's prose.
    expect(card.body.split('## What changed')[1].trim().split('\n')[0]).toBe(live.pivot);
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

  // ── W6-6: a wedge is not an idea ───────────────────────────────────────────────────────────────────────
  describe('a wedge is not an idea (W6-6)', () => {
    /** Dry-run 3, the 17:06 sitting: an audience segment, filed as `Ideas/founders-of-high-traffic-saas-…`. */
    const WEDGE = 'founders of high-traffic SaaS landing pages (>100 k visits/month) who have just missed a Core Web Vitals threshold and cannot afford agency rates';

    it('reads no product out of a wedge that names only a customer', () => {
      expect(pivotProduct(WEDGE, 'the founder brief')).toBeNull();
      expect(pivotNamesAProduct(WEDGE, { title: 'PageSpeedAudit — free weekly audits' })).toBeNull();
    });

    it('files no card for it, so no research or estimate job follows one', () => {
      expect(fileBoardPivot(vault, { ...live, pivot: WEDGE, product: 'PageSpeedAudit — free weekly audits' })).toBeNull();
      expect(listIdeas(vault)).toEqual([]);
    });

    it('files no card when the pivot names the product the company already sells', () => {
      const same = 'PageSpeedAudit for e-commerce merchants with a documented revenue drop';
      expect(pivotNamesAProduct(same, { title: 'PageSpeedAudit — free weekly audits' })).toBeNull();
      expect(fileBoardPivot(vault, { ...live, pivot: same, product: 'PageSpeedAudit — free weekly audits' })).toBeNull();
    });

    it('still files the card when the chair proposed a different product', () => {
      const real = 'PIVOT TITLE: Automated speed-fix implementation for e-commerce stores with documented revenue drops';
      // "Automated" comes off with the leading verb, as W4-7 asks: the title is a thing, never an instruction.
      expect(pivotNamesAProduct(real, { title: 'PageSpeedAudit — free weekly audits' })).toContain('Speed-fix implementation');
      const slug = fileBoardPivot(vault, { ...live, pivot: real, product: 'PageSpeedAudit — free weekly audits' });
      expect(slug).toBeTruthy();
      expect(readIdea(vault, slug!)!.data.title).toContain('Speed-fix implementation');
    });
  });
});
