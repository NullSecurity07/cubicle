import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { writeIdeaCard, updateIdea } from '../src/ideas.js';
import { checkPlan, planObjectives, PLAN_IDEA_MARKER, NOTHING_PLANNED } from '../src/plan-check.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-plan-check-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function keep(slug: string, title: string): void {
  writeIdeaCard(vault, { slug, title, source: 'discovery' }, 'daemon');
  updateIdea(vault, slug, { decision: 'keep', decided_by: 'owner' }, 'daemon');
}

/**
 * The plan the third live run actually wrote (R3-1), objective for objective: the board ruled PIVOT REQUIRED, the
 * CEO "aligned the plan with the board's recommendations", and every objective became something the owner had
 * never seen. Not one of them names an idea.
 */
const LIVE_PLAN = [
  '# Plan', '', '## Objectives', '',
  '### operations',
  '- Verify verification protocols and ensure weekly review integrity with zero discrepancies, moving review reconciliation time from 2 hours to 0 hours. stream: first-product', '',
  '### revenue',
  '- Acquire the first 10 commercial compliance design partners and validate pricing offer demand for signed SBOM attestations. stream: first-product', '',
  '### technology',
  '- Execute direct outreach and manual validation test with 20 maintainers on active supply-chain friction, replacing the static landing page build. stream: first-product', '',
  '- [[Jobs/job_divplan_job_20260913_6a8105_operations_1_3.md]]', '',
  '- job_divplan_job_20260913_6a8105_revenue_1_3',
].join('\n');

describe('planObjectives', () => {
  it('reads one objective per bullet, under the header the CEO wrote', () => {
    const o = planObjectives(LIVE_PLAN);
    expect(o.map((x) => x.team)).toEqual(['operations', 'revenue', 'technology']);
    expect(o.every((x) => x.idea === null)).toBe(true);
  });

  it('never asks a job link to name an idea — those are what came of the plan, not the plan', () => {
    // The three job bullets under `### technology` in the live plan are the division leads' own record.
    expect(planObjectives(LIVE_PLAN).filter((o) => /Jobs\/|job_/.test(o.text))).toEqual([]);
  });

  it('skips a bullet that is nothing but a wikilink, whatever it points at', () => {
    // The shape the division lead's goal asks for, plus the two other spellings the live vault carries.
    const plan = '### technology\n- Publish 20 pages. idea: altstack\n- [[Jobs/job_x.md]]\n- Jobs/job_y.md\n- job_z\n- [[Streams/first-product]]\n';
    expect(planObjectives(plan).map((o) => o.text)).toEqual(['Publish 20 pages. idea: altstack']);
  });

  it('takes the marker off the bullet or off a continuation line under it', () => {
    const plan = '## Objectives\n\n### technology\n- Ship the directory. stream: first-product idea: altstack\n- Write the newsletter.\n  idea: altstack\n';
    expect(planObjectives(plan).map((o) => o.idea)).toEqual(['altstack', 'altstack']);
  });

  it('lower-cases the slug, so `idea: AltStack` is the card it names', () => {
    expect(planObjectives('### revenue\n- Sell it. idea: AltStack\n')[0].idea).toBe('altstack');
  });

  it('reads the marker however it is written: a bare slug, a wikilink, a path, backticks', () => {
    // A rewrite spent on punctuation is a rewrite spent on nothing. Every one of these names the same card.
    const forms = [
      '- A. idea: altstack',
      '- B. idea: [[Ideas/altstack]]',
      '- C. idea: [[Ideas/altstack.md]]',
      '- D. idea: Ideas/altstack',
      '- E. idea: `altstack`',
      '- F — ship it (idea: altstack)',
    ].join('\n');
    expect(planObjectives(`### dev\n${forms}\n`).map((o) => o.idea)).toEqual(Array(6).fill('altstack'));
  });
});

describe('checkPlan', () => {
  it('returns the live plan: SBOM work, and not one objective naming a kept idea', () => {
    keep('altstack', 'AltStack: open-source SaaS alternatives');
    const r = checkPlan(vault, LIVE_PLAN);
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(3);
    expect(r.findings[1]).toContain('compliance design partners');
    expect(r.findings[1]).toContain(PLAN_IDEA_MARKER);
    expect(r.findings[1]).toContain('altstack');
  });

  it('passes a plan whose every objective names the kept idea', () => {
    keep('altstack', 'AltStack: open-source SaaS alternatives');
    const plan = '## Objectives\n\n### technology\n- Publish 20 alternative pages. stream: first-product idea: altstack\n\n### revenue\n- Get 200 newsletter subscribers. stream: first-product idea: altstack\n';
    expect(checkPlan(vault, plan)).toEqual({ ok: true, findings: [] });
  });

  it('refuses an objective that serves an idea the company parked or scrapped, and says which', () => {
    keep('altstack', 'AltStack');
    writeIdeaCard(vault, { slug: 'sbom-attestations', title: 'Signed SBOM attestations', source: 'board' }, 'daemon');
    updateIdea(vault, 'sbom-attestations', { decision: 'park' }, 'daemon');
    const r = checkPlan(vault, '### revenue\n- Sell attestations. idea: sbom-attestations\n');
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toContain('parked');
  });

  it('refuses an objective naming an idea nobody has ruled on, and one that names no card at all', () => {
    keep('altstack', 'AltStack');
    writeIdeaCard(vault, { slug: 'memory-integration', title: 'Persistent agent memory', source: 'intelligence' }, 'daemon');
    const r = checkPlan(vault, '### revenue\n- A. idea: memory-integration\n- B. idea: nothing-at-all\n');
    expect(r.findings[0]).toContain('has not ruled on');
    expect(r.findings[1]).toContain('not an idea card at all');
  });

  it('refuses the whole plan when the company has kept no idea yet (ruling W4-5)', () => {
    // It used to pass and say nothing, on the reasoning that the cycle after the brief is adopted has nothing
    // kept. That exemption is how the second dry-run planned for four days against five undecided cards, every
    // plan passing a check that never looked at one. With nothing kept the company writes no plan and says so.
    writeIdeaCard(vault, { slug: 'altstack', title: 'AltStack', source: 'discovery' }, 'daemon');
    const r = checkPlan(vault, LIVE_PLAN);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toContain(NOTHING_PLANNED);
  });

  it('says nothing about a plan with no objectives — there is nothing to check', () => {
    keep('altstack', 'AltStack');
    expect(checkPlan(vault, '# Plan\n\n## Objectives\n\n_Nothing this cycle._\n')).toEqual({ ok: true, findings: [] });
  });
});
