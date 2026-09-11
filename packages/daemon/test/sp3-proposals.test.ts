import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createProposal, readIdea, writeIdeaCard, updateIdea, FOUNDER_BRIEF, hasFounderBrief } from '@cubicle/core';
import { dispatchProposals } from '../src/dispatcher.js';
import { ToolRegistry, parseToolsConfig } from '@cubicle/tools';

let dir: string;
let vault: Vault;
const deps = () => ({
  vault, registry: new ToolRegistry(), toolsConfig: parseToolsConfig('tools: {}\n'),
  scheduler: { enqueue: () => 'job_x' }, env: {} as NodeJS.ProcessEnv,
});
/**
 * The dispatcher acts on an approval flag only when `vault.isOwnerChanged` says the owner set it — which means
 * the sha on disk must differ from the last sha the vault recorded. A write *through* the vault records one,
 * whatever actor it names, so approving in a test is a raw file edit, exactly as `evolution.test.ts` does it.
 */
const ownerEdit = (rel: string, f: (t: string) => string) => writeFileSync(path.join(dir, rel), f(readFileSync(path.join(dir, rel), 'utf8')));
const approve = (rel: string, flags: Record<string, string>) =>
  ownerEdit(rel, (t) => Object.entries(flags).reduce((acc, [k, v]) => acc.replace(new RegExp(`^${k}: .*$`, 'm'), `${k}: ${v}`), t));

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-sp3-prop-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('founder_brief (spec §1.7)', () => {
  const brief = ['## What the company is', 'Meal kits.', '## Who it is for', 'Nurseries.', '## What already exists', 'Two customers.',
    '## What success looks like', 'Ten nurseries.', '## Constraints', 'No money.', '## Candidate ideas', '- [[Ideas/meal-kits]]',
    '## What we do not know', 'Whether they would pay more.'].join('\n\n');

  it('writes Memory/founder-brief.md from the proposed content the owner approved', async () => {
    const { path: rel } = createProposal(vault, { kind: 'founder_brief', from: 'research_manager', target: FOUNDER_BRIEF, title: 'What I understood', body: `## Proposed content\n\n\`\`\`\n${brief}\n\`\`\`` }, 'research_manager');
    approve(rel, { approved: 'true' });
    expect(await dispatchProposals(deps())).toBeGreaterThan(0);
    expect(hasFounderBrief(vault)).toBe(true);
    expect(vault.readText(FOUNDER_BRIEF)).toContain('## What we do not know');
    expect(vault.readText(rel)).toContain('_Resolved');
  });

  it('refuses a brief that is missing sections, and says which', async () => {
    const { path: rel } = createProposal(vault, { kind: 'founder_brief', from: 'research_manager', target: FOUNDER_BRIEF, title: 'Half a brief', body: '## Proposed content\n\n```\n## What the company is\n\nMeal kits.\n```' }, 'research_manager');
    approve(rel, { approved: 'true' });
    await dispatchProposals(deps());
    expect(hasFounderBrief(vault)).toBe(false);
    expect(String(vault.readNoteOrNull(rel)!.data.refused)).toContain('## Constraints');
  });

  it('may only ever target Memory/founder-brief.md', async () => {
    const { path: rel } = createProposal(vault, { kind: 'founder_brief', from: 'research_manager', target: 'Memory/constitution.md', title: 'Nice try', body: '## Proposed content\n\n```\nx\n```' }, 'research_manager');
    approve(rel, { approved: 'true' });
    await dispatchProposals(deps());
    expect(vault.readText('Memory/constitution.md')).toContain('max_emails_per_day');
    expect(String(vault.readNoteOrNull(rel)!.data.refused)).toContain('founder_brief');
  });
});

describe('idea_verdict (spec §3.5)', () => {
  const card = () => {
    const slug = writeIdeaCard(vault, { title: 'Meal kits', source: 'discovery' }, 'research_manager');
    updateIdea(vault, slug, { score_inputs: { value: 4, evidence: 4, effort: 4, fit: 3 }, board_verdict: 'pass' }, 'daemon');
    return slug;
  };

  it('adopts the recommendation on a bare approval', async () => {
    const slug = card();
    const { path: rel } = createProposal(vault, { kind: 'idea_verdict', from: 'ceo', target: `Ideas/${slug}.md`, title: 'Keep or scrap: Meal kits', body: 'Recommendation: **keep**.' }, 'ceo');
    approve(rel, { approved: 'true' });
    await dispatchProposals(deps());
    const after = readIdea(vault, slug)!;
    expect(after.data.decision).toBe('keep');
    expect(after.data.decided_by).toBe('owner');
    expect(after.data.decided_at).not.toBe('');
    expect(after.body).toContain('## Decision');
    expect(after.body).toContain('keep');
  });

  it('lets chosen: overrule the recommendation, and reads a refusal as park', async () => {
    const slug = card();
    const { path: rel } = createProposal(vault, { kind: 'idea_verdict', from: 'ceo', target: `Ideas/${slug}.md`, title: 'x', body: 'y' }, 'ceo');
    approve(rel, { approved: 'true', chosen: '3' });
    await dispatchProposals(deps());
    expect(readIdea(vault, slug)!.data.decision).toBe('scrap');

    const slug2 = card();
    const { path: rel2 } = createProposal(vault, { kind: 'idea_verdict', from: 'ceo', target: `Ideas/${slug2}.md`, title: 'x', body: 'y' }, 'ceo');
    approve(rel2, { approved: 'false' });
    await dispatchProposals(deps());
    expect(readIdea(vault, slug2)!.data.decision).toBe('park');   // never scrap: the research behind it survives
  });

  it('may only target an Ideas/ card that exists', async () => {
    const { path: rel } = createProposal(vault, { kind: 'idea_verdict', from: 'ceo', target: 'Plans/plan.md', title: 'x', body: 'y' }, 'ceo');
    approve(rel, { approved: 'true' });
    await dispatchProposals(deps());
    expect(String(vault.readNoteOrNull(rel)!.data.refused)).toContain('Ideas/');
  });
});
