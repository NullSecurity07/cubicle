import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, RoleFrontmatter, listInbox, founderBriefProposalBody,
  INTERVIEW_PATH, FOUNDER_BRIEF, renderInterviewAsked, hasProposedContentFence, briefFromProposalBody,
} from '@cubicle/core';
import { parseToolsConfig, type ToolContext } from '../src/index.js';
import { proposalCreate, resetBriefTries, BRIEF_CHECK_TRIES } from '../src/tools/proposal.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string;
let vault: Vault;
const ctx = (job = 'job_discovery1'): ToolContext => ({
  vault, events: vault.events, roleId: 'research_manager',
  role: RoleFrontmatter.parse(vault.readNoteOrNull('Roles/research_manager.md')!.data),
  jobId: job, config: cfg, env: {},
  workspace: `.cubicle/workspace/${job}`, now: () => new Date('2026-09-13T09:00:00.000Z'),
  scheduler: { enqueue: () => 'job_x' },
} as ToolContext);

const brief = (opts: { exists: string; fit: string }): string => [
  '## What the company is', '', 'A platform matching independent creators with sponsors.', '',
  '## Who it is for', '', 'Creators with 10–50k followers who sell their own sponsorships by hand today.', '',
  '## What already exists', '', opts.exists, '',
  '## What success looks like', '', 'Unstated: the owner has not said what three months from now should look like.', '',
  '## Constraints', '', 'Free tier only; no paid advertising.', '',
  '## Candidate ideas', '', '- sponsor-matching — a matching service between creators and sponsors.', '',
  '## What we do not know', '', 'Who the owner is, and whether any creator has asked for this.', '',
  '## Pressure test', '',
  '**Core Assumption:** creators will pay to be matched rather than pitch sponsors directly.',
  '**Three Fatal Flaws:** the sponsor holds the budget; no way to seed the sponsor side; agencies already serve the top 1%.',
  '**Problem Validation:** a painkiller at best — a spreadsheet and a cold-email template today.',
  `**Founder-Market Fit:** ${opts.fit}`,
  '**Brutal Verdict:** WEAK — nothing about the demand or the founder is established yet.', '',
].join('\n');

const FALSE_BRIEF = brief({
  exists: '- Brand name is SponsorMatch (`Brand/name.md`).\n- Discovery Interview: structured responses in `Discovery/interview.md`.',
  fit: 'the owner has spent years in creator marketing and knows 200 sponsors personally.',
});
const TRUE_BRIEF = brief({
  exists: '- Name & Brand: none yet — `Brand/name.md` carries an empty `name`.\n- The interview (`Discovery/interview.md`) has no answers yet: the six questions only.',
  fit: 'unstated — nothing in the material says who the owner is.',
});

const file = (b: string, opts: { job?: string; title?: string } = {}) => proposalCreate.handler(
  { kind: 'founder_brief', title: opts.title ?? 'What I understood', body: founderBriefProposalBody(b, ['Discovery/interview.md']), target: FOUNDER_BRIEF },
  ctx(opts.job),
);
const briefsFiled = () => listInbox(vault).filter((n) => n.data.kind === 'founder_brief').length;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-brief-truth-'));
  vault = (await scaffoldVault(dir)).vault;
  vault.writeText(INTERVIEW_PATH, renderInterviewAsked('2026-09-13T08:40:00.000Z'), 'ceo');
  resetBriefTries();
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

/**
 * Ruling FR-4. The first live run's brief reached the owner because nothing between the model and `00 Inbox/`
 * ever opened the files it cited. This is that check, where the author can still act on it.
 */
describe('proposal.create checks a founder_brief against the vault before filing it', () => {
  it('hands the findings back, files nothing, and files the corrected brief on the next call', async () => {
    const bad = await file(FALSE_BRIEF);
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('SponsorMatch');
    expect(bad.text).toContain('structured responses');
    expect(bad.text).toContain('unstated');
    expect(briefsFiled()).toBe(0);

    const good = await file(TRUE_BRIEF);
    expect(good.ok).toBe(true);
    expect(briefsFiled()).toBe(1);                       // one proposal, not two: the false one was never filed
  });

  it(`refuses outright after ${BRIEF_CHECK_TRIES} returns rather than inviting a third rewrite`, async () => {
    for (let i = 0; i < BRIEF_CHECK_TRIES; i++) expect((await file(FALSE_BRIEF)).text).toContain('call proposal.create again');
    const third = await file(FALSE_BRIEF);
    expect(third.ok).toBe(false);
    expect(third.text).toContain('Do not file it again');
    expect(third.text).toContain('## What we do not know');
    expect(briefsFiled()).toBe(0);
  });

  it('leaves every other proposal kind alone', async () => {
    const r = await proposalCreate.handler({ kind: 'file_change', title: 'A note', body: 'Brand name is SponsorMatch.', target: 'Docs/notes.md' }, ctx());
    expect(r.ok).toBe(true);
  });

  /**
   * Ruling C1. Discovery filed the live brief as the note's body, with no `## Proposed content` fence, and three
   * readers depend on that fence being there: the dispatcher adopts what is inside it, the rejection path hands
   * the research office the brief out of it, and the owner's rejection comment is read as what lies outside it.
   * The last of those handed the owner a thousand characters of the company's own prose back as their words.
   */
  describe('the note has one shape, whatever the author sent (ruling C1)', () => {
    it('wraps an unfenced brief into the block the dispatcher adopts from', async () => {
      const r = await proposalCreate.handler({ kind: 'founder_brief', title: 'What I understood', body: TRUE_BRIEF, target: FOUNDER_BRIEF }, ctx());
      expect(r.ok).toBe(true);
      const note = listInbox(vault).find((n) => n.data.kind === 'founder_brief')!;
      expect(hasProposedContentFence(note.body)).toBe(true);
      // The bytes inside the fence are the brief the author wrote — that is what gets adopted — under the
      // title ruling W6-12 gives it, because the H1 of the company's founding document is not the author's to
      // choose (the third dry-run's author titled it "Proposed content").
      const inside = briefFromProposalBody(note.body).trim();
      expect(inside.split('\n')[0]).toBe('# Founder brief');
      expect(inside).toContain(TRUE_BRIEF.trim());
      // …and the wrapper says where it was read from, taken from the brief's own citations.
      expect(note.body).toContain('**Read from:**');
      expect(note.body).toContain('Discovery/interview.md');
    });

    it('leaves the covering note of a brief that already carries the fence exactly as it is', async () => {
      const body = founderBriefProposalBody(TRUE_BRIEF, ['Discovery/interview.md']);
      const r = await proposalCreate.handler({ kind: 'founder_brief', title: 'What I understood', body, target: FOUNDER_BRIEF }, ctx());
      expect(r.ok).toBe(true);
      const note = listInbox(vault).find((n) => n.data.kind === 'founder_brief')!;
      // Everything around the fence is the author's and is untouched; only the document inside it is titled.
      expect(note.body).toContain(body.split('## Proposed content')[0].trim());
      expect(briefFromProposalBody(note.body).trim()).toBe(`# Founder brief\n\n${TRUE_BRIEF.trim()}`);
    });

    it('a brief the check refuses is not wrapped and not filed', async () => {
      const r = await proposalCreate.handler({ kind: 'founder_brief', title: 'What I understood', body: FALSE_BRIEF, target: FOUNDER_BRIEF }, ctx());
      expect(r.ok).toBe(false);
      expect(briefsFiled()).toBe(0);
    });
  });

  // SP8, ruling P8-6: under `board_dialogue: full` the brief the discovery job files is not finished — the
  // board pressure-tests it and its findings become the `## Pressure test` section. A tool cannot hold a board
  // session, so it says so and the daemon finishes the document before the owner is asked to rule on it.
  describe('a brief the board has not sat on yet says so (SP8)', () => {
    it('stamps board_pending on a full-dialogue vault, and never on a brief-dialogue one', async () => {
      expect(vault.constitution().board_dialogue).toBe('full');
      expect((await file(TRUE_BRIEF)).ok).toBe(true);
      expect(listInbox(vault).find((n) => n.data.kind === 'founder_brief')!.data.board_pending).toBe(true);
    });

    it('leaves it off when the board holds the brief session it always held', async () => {
      vault.writeText('Memory/constitution.md', vault.readText('Memory/constitution.md').replace(/^board_dialogue:.*$/m, 'board_dialogue: brief'), 'owner');
      expect((await file(TRUE_BRIEF)).ok).toBe(true);
      expect(listInbox(vault).find((n) => n.data.kind === 'founder_brief')!.data.board_pending).toBeUndefined();
    });

    it('marks nothing but the founder brief', async () => {
      const r = await proposalCreate.handler({ kind: 'brand_change', title: 'A name', body: 'Call it X.', target: 'Brand/name.md' }, ctx());
      expect(r.ok).toBe(true);
      expect(listInbox(vault).find((n) => n.data.kind === 'brand_change')!.data.board_pending).toBeUndefined();
    });
  });

  /**
   * Ruling W3-4. The third live run's discovery job filed the brief at step 31 and filed it again at step 33:
   * two proposals, two board sessions on the same document (32 model calls), two question messages, and two
   * notes to adopt — of which adopting either left the other open for ever.
   */
  describe('one open brief per discovery job (ruling W3-4)', () => {
    const REVISED = TRUE_BRIEF.replace('Creators with 10–50k followers', 'Creators with 10–100k followers');
    const briefNote = () => listInbox(vault).find((n) => n.data.kind === 'founder_brief')!;

    it('updates the note it already filed instead of filing a second one, title and all', async () => {
      const first = await file(TRUE_BRIEF);
      expect(first.ok).toBe(true);
      expect(first.text).toContain('do not file again — finish the job');

      const second = await file(REVISED, { title: 'What I understood (again)' });
      expect(second.ok).toBe(true);
      expect(second.text).toContain('updated the brief you already filed');
      expect(second.text).toContain(briefNote().path);
      expect(second.text).toContain('do not file again');
      expect(briefsFiled()).toBe(1);
      // The note carries the second draft, under the second title, still inside the fence the dispatcher adopts from.
      const note = briefNote();
      expect(note.body.split('\n')[0]).toBe('# What I understood (again)');
      expect(hasProposedContentFence(note.body)).toBe(true);
      expect(briefFromProposalBody(note.body)).toContain('10–100k followers');
      expect(note.data.board_pending).toBe(true);              // untouched: the board has still not sat
    });

    it('gives a different discovery job its own note — a second brief is a genuinely new document', async () => {
      expect((await file(TRUE_BRIEF)).ok).toBe(true);
      expect((await file(REVISED, { job: 'job_discovery2' })).ok).toBe(true);
      expect(briefsFiled()).toBe(2);
      const jobs = listInbox(vault).filter((n) => n.data.kind === 'founder_brief').map((n) => n.data.job);
      expect(jobs.sort()).toEqual(['job_discovery1', 'job_discovery2']);
    });

    it('never rewrites a brief the owner has already ruled on', async () => {
      expect((await file(TRUE_BRIEF)).ok).toBe(true);
      const path = briefNote().path;
      vault.updateNote(path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'owner');
      const again = await file(REVISED);
      expect(again.text).toContain('they have ruled on it');
      expect(again.text).toContain('do not file again — finish the job');
      expect(briefsFiled()).toBe(1);
      expect(briefFromProposalBody(briefNote().body)).toContain('10–50k followers');   // the document they said yes to
    });

    it('never throws away the board\'s pressure test by rewriting the note under it', async () => {
      expect((await file(TRUE_BRIEF)).ok).toBe(true);
      // What `runBriefBoardSession` leaves behind: its findings written in, the flag off.
      vault.updateNote(briefNote().path, (n) => ({ data: { ...n.data, board_pending: false }, body: n.body }), 'daemon');
      const again = await file(REVISED);
      expect(again.text).toContain('already pressure-tested');
      expect(again.text).toContain('do not file again — finish the job');
      expect(briefsFiled()).toBe(1);
      expect(briefFromProposalBody(briefNote().body)).toContain('10–50k followers');
    });

    it('still checks the brief against the vault first: a false rewrite gets the findings, not an update', async () => {
      expect((await file(TRUE_BRIEF)).ok).toBe(true);
      const bad = await file(FALSE_BRIEF);
      expect(bad.ok).toBe(false);
      expect(bad.text).toContain('call proposal.create again');
      expect(briefFromProposalBody(briefNote().body)).toContain('10–50k followers');
      // The two-returns rule is still counting on the same job, so the third attempt is refused outright.
      expect((await file(FALSE_BRIEF)).text).toContain('call proposal.create again');
      expect((await file(FALSE_BRIEF)).text).toContain('Do not file it again');
      expect(briefsFiled()).toBe(1);
    });
  });
});
