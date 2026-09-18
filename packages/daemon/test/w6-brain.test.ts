/**
 * The third dry-run's board-and-ideas defects (W6).
 *
 * Every case here is something the owner actually read on 2026-09-18: a card that never recorded the idea they
 * picked, a board that judged two different customers ten minutes apart, an audience segment filed as an idea,
 * frontmatter instructions beside the buttons that replaced them, and a founding document titled "Proposed
 * content".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createProposal, ownerDecide, readIdea, listIdeas, keptIdeas, BRAND_NAME_PATH } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler } from '@cubicle/harness';
import { dispatchProposals } from '../src/index.js';
import { priorSittingBlock, renderBriefPressureSection, WEDGE_NOT_A_CARD } from '../src/board-dialogue.js';
import { ideaVerdictBody, chairPivotText } from '../src/heartbeat.js';

const root = path.resolve(__dirname, '../../..');

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-w6-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const deps = () => ({
  vault,
  registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })),
  toolsConfig: parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8')),
  scheduler: vaultScheduler(vault, 'daemon'),
  env: {} as NodeJS.ProcessEnv,
});

/** The three the CEO filed after "surprise me", in the shape the dry-run's note had. */
const THREE = [
  '1. SponsorMatch — A curated directory matching indie newsletter creators with niche software sponsors.',
  '2. PageSpeedAudit — A free weekly performance audit for three landing pages, driving leads to a premium service.',
  '3. RemoteJunior — A hand-curated weekly newsletter showcasing entry-level remote developer roles.',
].join('\n');

describe('W6-5: the owner’s pick is kept, on the surprise path too', () => {
  it('files and keeps the card when the pick resolves, before any discovery job has run', async () => {
    const { id } = createProposal(vault, {
      kind: 'brand_change', from: 'ceo', target: BRAND_NAME_PATH, title: 'Three company ideas — pick one', body: THREE,
    }, 'ceo');
    ownerDecide(vault, id, { approved: true, chosen: 2 });

    expect(await dispatchProposals(deps())).toBe(1);

    expect(vault.readText(BRAND_NAME_PATH)).toContain('PageSpeedAudit');
    const card = readIdea(vault, 'pagespeedaudit')!;
    expect(card.data.decision).toBe('keep');
    expect(card.data.decided_by).toBe('owner');
    expect(card.data.decided_at).not.toBe('');
    expect(keptIdeas(vault).map((i) => i.id)).toEqual(['pagespeedaudit']);
    expect(vault.events.query({ types: ['guardrail.blocked'] })).toHaveLength(0);
  });

  it('is idempotent across a second dispatch: one card, one decision', async () => {
    const { id } = createProposal(vault, {
      kind: 'brand_change', from: 'ceo', target: BRAND_NAME_PATH, title: 'Three company ideas — pick one', body: THREE,
    }, 'ceo');
    ownerDecide(vault, id, { approved: true, chosen: 2 });
    await dispatchProposals(deps());
    const at = readIdea(vault, 'pagespeedaudit')!.data.decided_at;
    await dispatchProposals(deps());
    expect(listIdeas(vault).map((i) => i.id)).toEqual(['pagespeedaudit']);
    expect(readIdea(vault, 'pagespeedaudit')!.data.decided_at).toBe(at);
  });
});

describe('W6-6: the wedge goes in the pressure test, not in Ideas/', () => {
  it('writes it into the brief’s own section, saying nothing was filed against it', () => {
    const section = renderBriefPressureSection(
      { 'Brutal Verdict': 'the pain is thin' }, 'PIVOT REQUIRED', 'Meetings/2026-09-18-1706-board-founder-brief.md',
      'founders of high-traffic SaaS landing pages who have just missed a Core Web Vitals threshold',
    );
    expect(section).toContain('**Wedge:**');
    expect(section).toContain('high-traffic SaaS landing pages');
    expect(section).toContain(WEDGE_NOT_A_CARD);
  });

  it('says nothing about a wedge when the board did not name one', () => {
    expect(renderBriefPressureSection({}, 'WEAK', 'Meetings/x.md')).not.toContain('**Wedge:**');
  });
});

describe('W6-4: the board does not contradict itself across sittings', () => {
  it('hands a second sitting the first’s verdict and wedge, and asks it to confirm or say what changed', () => {
    const block = priorSittingBlock({
      opened: '2026-09-18T11:36:34.509Z', verdict: 'PIVOT REQUIRED', rubric: '4/10',
      wedge: 'founders of high-traffic SaaS landing pages', path: 'Meetings/2026-09-18-1706-board-founder-brief.md',
    });
    expect(block).toContain('PIVOT REQUIRED');
    expect(block).toContain('4/10');
    expect(block).toContain('founders of high-traffic SaaS landing pages');
    expect(block).toContain('2026-09-18');
    expect(block.toLowerCase()).toContain('what changed');
  });

  it('shows both verdicts in the note the owner rules on when they differ', () => {
    const body = ideaVerdictBody({
      slug: 'pagespeedaudit', title: 'PageSpeedAudit', score: 53, band: 'park',
      reason: 'the board returned it.', board: 'return', findings: [], research: '', estimate: '',
      decidesAfterHours: 24, pressure: 'WEAK', rubric: { core_assumption: 0, fatal_flaws: 0, pain: 1, founder_fit: 0, why_now: 0 },
      priorSitting: { opened: '2026-09-18T11:36:34.509Z', verdict: 'PIVOT REQUIRED', rubric: '4/10', wedge: '', path: 'Meetings/2026-09-18-1706-board-founder-brief.md', changed: 'the card now names e-commerce merchants, not indie founders' },
    });
    expect(body).toContain('The board sat twice');
    expect(body).toContain('PIVOT REQUIRED (4/10)');
    expect(body).toContain('WEAK (1/10)');
    expect(body).toContain('e-commerce merchants');
  });
});

describe('W6-6: a wedge is not an idea', () => {
  const CHAIR = [
    'VERDICT: PIVOT REQUIRED',
    'RUBRIC: core assumption 0, fatal flaws 2, pain 1, founder fit 1, why now 0 — out of 10.',
    'WEDGE: founders of high-traffic SaaS landing pages (>100 k visits/month) who have just missed a Core Web Vitals threshold.',
    'PIVOT TITLE: AuditToolkit for high-traffic SaaS landing pages',
  ].join('\n');

  it('carries the chair’s PIVOT TITLE line through to whatever files the card', () => {
    // Dry-run 3 filed `Ideas/founders-of-high-traffic-saas-landing-pages-100` — the wedge — because the title
    // line never reached `pivotTitle`.
    expect(chairPivotText({ text: CHAIR, findings: [] })).toContain('AuditToolkit');
  });
});
