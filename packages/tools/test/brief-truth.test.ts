import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, RoleFrontmatter, listInbox, founderBriefProposalBody,
  INTERVIEW_PATH, FOUNDER_BRIEF, renderInterviewAsked,
} from '@cubicle/core';
import { parseToolsConfig, type ToolContext } from '../src/index.js';
import { proposalCreate, resetBriefTries, BRIEF_CHECK_TRIES } from '../src/tools/proposal.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string;
let vault: Vault;
const ctx = (): ToolContext => ({
  vault, events: vault.events, roleId: 'research_manager',
  role: RoleFrontmatter.parse(vault.readNoteOrNull('Roles/research_manager.md')!.data),
  jobId: 'job_discovery1', config: cfg, env: {},
  workspace: '.cubicle/workspace/job_discovery1', now: () => new Date('2026-09-13T09:00:00.000Z'),
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

const file = (b: string) => proposalCreate.handler(
  { kind: 'founder_brief', title: 'What I understood', body: founderBriefProposalBody(b, ['Discovery/interview.md']), target: FOUNDER_BRIEF },
  ctx(),
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
});
