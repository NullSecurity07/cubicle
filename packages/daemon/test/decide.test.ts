/**
 * SP8 §1: deciding inside CUBICLE is deciding.
 *
 * The one thing these tests exist to prove is the thing ruling P8-1 is about — that the dispatcher applies an
 * `ownerDecide` write **exactly** as it applies an Obsidian edit, and emits no `guardrail.blocked` doing it.
 * The guard that would refuse it is not hypothetical: it compares the note against the last system write, and a
 * decision taken in the office *is* a system write, so without an explicit path for the owner's name the
 * owner's own click is what the guard was written to stop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, createProposal, findInboxById, parseNote, listJobs, readIdea, writeIdeaCard, updateIdea,
  ownerDecide, decidedByOwner, FOUNDER_BRIEF, nowIso,
} from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler } from '@cubicle/harness';
import { dispatchProposals } from '../src/index.js';
import { briefRejectionComment } from '../src/discovery.js';
import { ADOPTED_BRIEF } from './helpers/brief.js';

const root = path.resolve(__dirname, '../../..');

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-decide-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const deps = () => ({
  vault,
  registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })),
  toolsConfig: parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8')),
  scheduler: vaultScheduler(vault, 'daemon'),
  env: {} as NodeJS.ProcessEnv,
});

const blocked = () => vault.events.query({ types: ['guardrail.blocked'] });

const THREE = [
  '1. Northwind — kits of ready-prepped food for nursery kitchens.',
  '2. Tuckbox — a weekly box a nursery cook can serve straight from.',
  '3. Provender — nursery catering priced per child per week.',
  '',
  'Set `chosen: 1|2|3` and `approved: true`; the chosen line\'s name becomes the company name.',
].join('\n');

describe('a plan_verdict decided in the office', () => {
  it('is applied on the next dispatch, with no guardrail.blocked', async () => {
    const { id, path: rel } = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'The plan for this cycle', body: 'Three bets.' }, 'ceo');

    ownerDecide(vault, id, { approved: true });
    expect(decidedByOwner(vault, rel)).toBe(true);

    expect(await dispatchProposals(deps())).toBe(1);
    const note = findInboxById(vault, id)!;
    expect(note.data.resolved_at).toBeTruthy();
    expect(note.body).toContain('the divisions plan against it');
    expect(blocked()).toHaveLength(0);
    expect(vault.events.query({ types: ['proposal.resolved'] }).map((e) => e.payload.id)).toContain(id);
  });

  it('is still refused when the daemon writes the flag itself — the guard has not been widened', async () => {
    const { id, path: rel } = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'The plan', body: 'b' }, 'ceo');
    vault.updateNote(rel, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'daemon');

    expect(await dispatchProposals(deps())).toBe(0);
    expect(findInboxById(vault, id)!.data.resolved_at ?? null).toBeNull();
    expect(blocked().map((e) => e.payload.reason)).toEqual([expect.stringContaining('was not set by the owner')]);
  });
});

describe('a brand_change decided with a chip', () => {
  it('chosen: 2 sets the second line\'s name, exactly as an Obsidian edit would', async () => {
    const { id } = createProposal(vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'Three company ideas — pick one', body: THREE }, 'ceo');

    ownerDecide(vault, id, { approved: true, chosen: 2 });
    expect(await dispatchProposals(deps())).toBe(1);

    const brand = parseNote(vault.readText('Brand/name.md')).data as { name: string; tagline: string };
    expect(brand.name).toBe('Tuckbox');
    expect(brand.tagline).toBe('a weekly box a nursery cook can serve straight from.');
    expect(blocked()).toHaveLength(0);
    expect(findInboxById(vault, id)!.body).toContain('applied to Brand/name.md');
    // The approval also queues the site reconcile, or says why it did not — same as any other brand approval.
    expect(findInboxById(vault, id)!.data.resolved_at).toBeTruthy();
  });

  it('a chosen the note has no line for is refused before anything is written', () => {
    const { id } = createProposal(vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'Pick one', body: THREE }, 'ceo');
    expect(() => ownerDecide(vault, id, { approved: true, chosen: 9 })).toThrow(/matches no option/);
    expect(findInboxById(vault, id)!.data.approved).toBeNull();
  });
});

describe('a founder brief sent back with a comment', () => {
  const briefNote = () => createProposal(vault, {
    kind: 'founder_brief', from: 'ceo', target: FOUNDER_BRIEF, title: 'The founder brief',
    body: `This is what I understood from what you gave me.\n\n## Proposed content\n\n\`\`\`md\n${ADOPTED_BRIEF}\`\`\`\n\nSet \`approved: true\` to adopt it.`,
  }, 'ceo');

  it('the comment is what the rejection path reads, and the re-run is queued on it', async () => {
    const { id } = briefNote();
    const comment = 'Not nurseries. Find me something a single owner can run from a laptop.';

    ownerDecide(vault, id, { approved: false, comment });

    // One comment, in one place, read back by the reader the dispatcher itself uses (ruling P8-1).
    expect(briefRejectionComment(findInboxById(vault, id)!)).toBe(comment);

    let answered: { comment: string; brief: string; discoveryJob: string } | null = null;
    expect(await dispatchProposals({ ...deps(), onBriefRejected: (_n, ctx) => { answered = ctx; } })).toBe(1);

    expect(answered!.comment).toBe(comment);
    expect(answered!.brief).toContain('A meal-kit service for nurseries.');
    const job = listJobs(vault).find((j) => j.id === answered!.discoveryJob)!;
    expect(job).toBeTruthy();
    expect(blocked()).toHaveLength(0);
    const note = findInboxById(vault, id)!;
    expect(note.body).toContain('discovery re-runs as');
    expect(note.body).toContain('the CEO has answered it');
    // The brief itself was never adopted: a send-back is a rewrite request, not an adoption.
    expect(vault.readTextOrNull(FOUNDER_BRIEF) ?? '').not.toContain('A meal-kit service for nurseries.');
  });

  it('adopting it writes the brief', async () => {
    const { id } = briefNote();
    ownerDecide(vault, id, { approved: true });
    expect(await dispatchProposals(deps())).toBe(1);
    expect(vault.readText(FOUNDER_BRIEF)).toContain('A meal-kit service for nurseries.');
    expect(blocked()).toHaveLength(0);
  });
});

describe('an idea_verdict decided with a chip', () => {
  it('chosen: 3 scraps an idea the board would have kept', async () => {
    const slug = writeIdeaCard(vault, { title: 'Meal kits for nurseries', source: 'discovery', evidence: ['Discovery/x.md'], created: nowIso(), what_changed: 'x', why_it_matters: 'y' }, 'daemon');
    updateIdea(vault, slug, { board_verdict: 'pass', score_inputs: { value: 5, evidence: 5, effort: 5, fit: 5 } }, 'daemon');
    const { id, path: rel } = createProposal(vault, { kind: 'idea_verdict', from: 'ceo', target: `Ideas/${slug}.md`, title: 'Keep, park or scrap', body: 'Recommendation: **keep**.' }, 'ceo');
    vault.updateNote(rel, (n) => ({ data: { ...n.data, board_verdict: 'pass', band: 'keep', band_reason: 'the arithmetic says keep' }, body: n.body }), 'daemon');

    ownerDecide(vault, id, { approved: true, chosen: 3 });
    expect(await dispatchProposals(deps())).toBe(1);

    expect(readIdea(vault, slug)!.data.decision).toBe('scrap');
    expect(readIdea(vault, slug)!.data.decided_by).toBe('owner');
    expect(blocked()).toHaveLength(0);
  });
});
