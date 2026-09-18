import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, writeIdeaCard, updateIdea, setSection, readIdea, ideaPath, stringifyNote,
  checkPlan, checkPlanRewrite, planIdeaSlugs, objectiveProduct, productWords, ideaProductText,
  planPivotDisagreement,
} from '../src/index.js';

/** The plan the second dry-run left behind, and the one it archived, quoted from `~/Vaults/Cubicle-dryrun`. */
const DRIFTED_PLAN = `# Plan

## Objectives

### revenue
- Secure the first 3 pilot users for the SpeedAudit diagnostic service by deploying targeted outreach and validating pricing willingness. idea: speedaudit

### technology
- Ship a zero-install, read-only public URL scanner with automated Stripe webhook replay protection and static snapshot analysis, complete with automated tests and a green CI record. idea: speedaudit
`;

const FAITHFUL_PLAN = `# Plan

## Objectives

### technology
- Ship the initial SpeedAudit diagnostic service baseline on free infrastructure with comprehensive automated tests and a green CI record. idea: speedaudit
`;

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-w4-plan-'));
  vault = (await scaffoldVault(dir)).vault;
  // The card as the run left it: the owner's own idea, and the board's pivot written into `## The board`.
  const slug = writeIdeaCard(vault, {
    slug: 'speedaudit', title: 'SpeedAudit — Free Website Performance Diagnostics & Consulting Upsell',
    source: 'discovery', evidence: ['Research/speedaudit-discovery/report.md'],
    why_it_matters: 'Allows the owner to rule on whether SpeedAudit is cheap enough to try and valuable enough if it works.',
  }, 'daemon');
  updateIdea(vault, slug, { decision: 'keep', decided_by: 'owner', decided_at: '2026-09-14T06:25:44.000Z' }, 'daemon', {
    heading: '## Research',
    content: 'SpeedAudit provides founders with three manual, actionable website speed fixes directly to their inboxes to pitch deep-dive optimization consulting.',
  });
  updateIdea(vault, slug, {}, 'daemon', {
    heading: '## The board',
    content: 'WEDGE: E-commerce founders doing $10k–$50k/month on Shopify whose checkout mobile load times exceed 4 seconds.\n\n- **Economics:** the margins do not work; *Fix:* Ship a zero-install public URL scanner with Stripe webhook replay protection.',
  });
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('a plan may not pivot the product silently (W4-2)', () => {
  it("reads the card's own account of the product and not the board's pivot into it", () => {
    const text = ideaProductText(vault, 'speedaudit');
    expect(text).toContain('SpeedAudit');
    expect(text).not.toContain('zero-install');
    expect(text).not.toContain('WEDGE');
  });

  it('names what an objective promises', () => {
    expect(objectiveProduct('Ship a zero-install, read-only public URL scanner with automated Stripe webhook replay protection. idea: speedaudit'))
      .toBe('a zero-install, read-only public URL scanner');
  });

  it('counts only words that could name a product', () => {
    const words = productWords('Ship a zero-install public URL scanner, complete with automated tests and a green CI record. idea: speedaudit');
    expect(words).toContain('install');
    expect(words).toContain('scanner');
    for (const filler of ['automated', 'test', 'green', 'record', 'zero', 'ship']) expect(words).not.toContain(filler);
  });

  it('refuses the live run\'s drifted objective and keeps the faithful one', () => {
    const drift = checkPlan(vault, DRIFTED_PLAN);
    expect(drift.ok).toBe(false);
    expect(drift.findings).toHaveLength(1);
    expect(drift.findings[0]).toContain('zero-install');
    expect(drift.findings[0]).toContain('SpeedAudit');
    expect(checkPlan(vault, FAITHFUL_PLAN)).toEqual({ ok: true, findings: [] });
  });

  it('refuses a rewrite that reaches for an idea the vetoed plan did not serve', () => {
    expect(planIdeaSlugs(DRIFTED_PLAN)).toEqual(['speedaudit']);
    const rewrite = '# Plan\n\n## Objectives\n\n### technology\n- Ship webhook replay protection. idea: automated-stripe-webhook-replay-protection\n';
    const check = checkPlanRewrite(rewrite, ['speedaudit']);
    expect(check.ok).toBe(false);
    expect(check.findings[0]).toContain('automated-stripe-webhook-replay-protection');
    // Dropping an objective is doing what the board asked, and is never refused.
    expect(checkPlanRewrite('# Plan\n\n## Objectives\n\n### technology\n- Nothing this cycle.\n', ['speedaudit'])).toEqual({ ok: true, findings: [] });
    expect(checkPlanRewrite(DRIFTED_PLAN, [])).toEqual({ ok: true, findings: [] });
  });

  it('puts the disagreement to the owner with both options in it', () => {
    expect(planPivotDisagreement('a-conversion-loss-dollar-estimator'))
      .toBe('The board and the CEO disagree: approve the plan as written, or keep the pivot card [[Ideas/a-conversion-loss-dollar-estimator]].');
  });
});
