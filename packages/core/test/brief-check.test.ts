import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { checkFounderBrief, briefCheckContext, briefFromProposalBody } from '../src/brief-check.js';
import { INTERVIEW_PATH, DISCOVERY_INBOX, INTERVIEW_QUESTIONS, renderInterviewAsked, closeInterview, parseCeoAnswers } from '../src/discovery.js';
import { loadGates, criteriaFor } from '../src/gates.js';

/**
 * The brief the research manager actually filed in the owner's first live run, in miniature: three claims, none
 * of which any file in the vault carries. Every other section is honest, so each test below is about exactly
 * the claim it names.
 */
const sections = (opts: { exists: string; fit: string; verdict: string; company?: string }): string => [
  '## What the company is', '',
  opts.company ?? 'A platform matching independent creators with sponsors, in the owner\'s own words.', '',
  '## Who it is for', '',
  'Creators with 10–50k followers who sell their own sponsorships by hand today.', '',
  '## What already exists', '',
  opts.exists, '',
  '## What success looks like', '',
  'Unstated: the owner has not said what three months from now should look like.', '',
  '## Constraints', '',
  'Free tier only; no paid advertising.', '',
  '## Candidate ideas', '',
  '- `Ideas/sponsor-matching.md` — a matching service between creators and sponsors.', '',
  '## What we do not know', '',
  'Who the owner is, what they have built before, and whether any creator has asked for this.', '',
  '## Pressure test', '',
  '**Core Assumption:** creators will pay to be matched with sponsors rather than pitch them directly.',
  '**Three Fatal Flaws:** the sponsors hold the budget and the creator is not their buyer; a two-sided market with no way to seed the sponsor side; every agency already does this for the top 1%.',
  '**Problem Validation:** a painkiller at best — creators use a spreadsheet and a cold-email template today.',
  `**Founder-Market Fit:** ${opts.fit}`,
  `**Brutal Verdict:** ${opts.verdict}`, '',
].join('\n');

/** The live-run brief: a brand the company does not have, an interview nobody answered, an invented fit. */
const LIVE_RUN_BRIEF = sections({
  company: 'A platform matching independent creators with sponsors. The owner selected SponsorMatch.',
  exists: [
    '- Brand name is SponsorMatch (`Brand/name.md`).',
    '- Discovery Interview: structured responses in `Discovery/interview.md`.',
  ].join('\n'),
  fit: 'the owner has spent years in creator marketing and knows 200 sponsors personally.',
  verdict: 'STRONG — the pain is real and the owner is the right person for it.',
});

/** The same brief with the three claims replaced by what the files actually say. */
const HONEST_BRIEF = sections({
  exists: [
    '- Name & Brand: none yet — `Brand/name.md` carries an empty `name`.',
    '- The interview (`Discovery/interview.md`) has no answers yet: it holds the six questions only.',
  ].join('\n'),
  fit: 'unstated — nothing in the material says who the owner is or what they have done before.',
  verdict: 'WEAK — nothing about the demand or the founder is established yet.',
});

let dir: string; let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-brief-check-'));
  vault = (await scaffoldVault(dir)).vault;
  // The vault as the live run left it: the six questions asked, nothing answered, nothing in the inbox.
  vault.writeText(INTERVIEW_PATH, renderInterviewAsked('2026-09-13T08:40:00.000Z'), 'ceo');
  vault.writeText('Ideas/sponsor-matching.md', '---\nid: sponsor-matching\n---\n# Sponsor matching\n', 'research_manager');
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('checkFounderBrief (ruling FR-4)', () => {
  it('refuses the three false claims the first live run filed, naming each one', () => {
    const r = checkFounderBrief(vault, LIVE_RUN_BRIEF, briefCheckContext(vault));
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(3);
    const all = r.findings.join('\n');
    expect(all).toContain('SponsorMatch');                      // the name the company does not have
    expect(all).toContain('Brand/name.md');
    expect(all).toContain('structured responses');              // the interview nobody answered
    expect(all).toContain('Discovery/interview.md');
    expect(all).toMatch(/Founder-Market Fit/);                  // the fit nothing establishes
    expect(all).toContain('unstated');
  });

  it('passes the same brief once every claim is what the files say', () => {
    expect(checkFounderBrief(vault, HONEST_BRIEF, briefCheckContext(vault))).toEqual({ ok: true, findings: [] });
  });

  it('passes a pressure test that ends on "PIVOT REQUIRED." — two words are one verdict (ruling FR-5)', () => {
    const brief = HONEST_BRIEF.replace(/\*\*Brutal Verdict:\*\*.*/, '**Brutal Verdict:** PIVOT REQUIRED.');
    expect(brief).toContain('PIVOT REQUIRED.');
    expect(checkFounderBrief(vault, brief, briefCheckContext(vault))).toEqual({ ok: true, findings: [] });
  });

  it('refuses a citation to a file nobody wrote, and takes the citation that exists', () => {
    const r = checkFounderBrief(vault, HONEST_BRIEF.replace('`Ideas/sponsor-matching.md`', '`Ideas/sponsor-crm.md`'), briefCheckContext(vault));
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toContain('Ideas/sponsor-crm.md');
    expect(r.findings[0]).toMatch(/no such file/);
  });

  it('never reads a tool name, a directory or the template\'s own `Ideas/<slug>.md` as a citation', () => {
    const md = HONEST_BRIEF.replace('## What we do not know', '## What we do not know\n\nFiled with `idea.card`; the inbox is `Discovery/inbox`; one card per `Ideas/<slug>.md`.\n');
    expect(checkFounderBrief(vault, md, briefCheckContext(vault)).findings).toEqual([]);
  });

  it('refuses a pressure test that hedges, or that never votes at all', () => {
    const hedge = HONEST_BRIEF.replace(/\*\*Brutal Verdict:\*\*.*/, '**Brutal Verdict:** it has potential, but the demand is unproven.');
    expect(checkFounderBrief(vault, hedge, briefCheckContext(vault)).findings.join('')).toContain('does not end on a verdict');
    const none = HONEST_BRIEF.replace(/\*\*Brutal Verdict:\*\*.*/, '**Brutal Verdict:** too early to say.');
    expect(checkFounderBrief(vault, none, briefCheckContext(vault)).findings.join('')).toContain('PIVOT REQUIRED');
  });

  it('says so when the brief never wrote a pressure test at all', () => {
    const r = checkFounderBrief(vault, HONEST_BRIEF.split('## Pressure test')[0], briefCheckContext(vault));
    expect(r.findings.join('')).toContain('no written ## Pressure test');
  });

  it('lets the brief cite the interview as answers once the owner has answered it', () => {
    vault.writeText(INTERVIEW_PATH, closeInterview(renderInterviewAsked('2026-09-13T08:40:00.000Z'), 'I am building a sponsor marketplace. I ran creator marketing at an agency for six years.'), 'ceo');
    const ctx = briefCheckContext(vault);
    expect(ctx.interviewAnswered).toBe(true);
    const answered = HONEST_BRIEF
      .replace('- The interview (`Discovery/interview.md`) has no answers yet: it holds the six questions only.', '- The owner\'s answers in `Discovery/interview.md`: six years running creator marketing at an agency.')
      .replace(/\*\*Founder-Market Fit:\*\*.*/, '**Founder-Market Fit:** six years in creator marketing, per the interview answer.');
    expect(checkFounderBrief(vault, answered, ctx)).toEqual({ ok: true, findings: [] });
  });

  it("the CEO's own answers are not the owner's: a self-interview is not answered (ruling P8-13)", () => {
    const answers = parseCeoAnswers('1. A sponsor marketplace. [from the idea]\n2. Creators. [from the idea]');
    vault.writeText(INTERVIEW_PATH, renderInterviewAsked('2026-09-13T08:40:00.000Z', INTERVIEW_QUESTIONS, answers), 'ceo');
    expect(briefCheckContext(vault).interviewAnswered).toBe(false);
    // A brief that reads those answers back as the owner's word is exactly the live run's fabrication.
    const claim = HONEST_BRIEF.replace('- The interview (`Discovery/interview.md`) has no answers yet: it holds the six questions only.', '- The owner said in `Discovery/interview.md` that this is a sponsor marketplace.');
    expect(checkFounderBrief(vault, claim, briefCheckContext(vault)).ok).toBe(false);
    // The honest sentence about the same transcript passes.
    const honest = HONEST_BRIEF.replace('- The interview (`Discovery/interview.md`) has no answers yet: it holds the six questions only.', "- `Discovery/interview.md` holds the CEO's own answers; the owner has not added to them or endorsed them.");
    expect(checkFounderBrief(vault, honest, briefCheckContext(vault))).toEqual({ ok: true, findings: [] });
  });

  it("an owner who reads the CEO's answers and says go has answered (ruling P8-13)", () => {
    const asked = renderInterviewAsked('2026-09-13T08:40:00.000Z', INTERVIEW_QUESTIONS, parseCeoAnswers('1. A sponsor marketplace. [from the idea]'));
    vault.writeText(INTERVIEW_PATH, closeInterview(asked, 'go', '2026-09-13T09:00:00.000Z'), 'ceo');
    expect(briefCheckContext(vault).interviewAnswered).toBe(true);
    const endorsed = HONEST_BRIEF.replace('- The interview (`Discovery/interview.md`) has no answers yet: it holds the six questions only.', '- The owner endorsed the answers in `Discovery/interview.md`.');
    expect(checkFounderBrief(vault, endorsed, briefCheckContext(vault))).toEqual({ ok: true, findings: [] });
  });

  it('stops asking for "unstated" once the owner has dropped a file in, even with no interview', () => {
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'I ran creator marketing at an agency for six years and want to build this.', 'owner');
    const ctx = briefCheckContext(vault);
    expect(ctx).toEqual({ interviewAnswered: false, inboxFiles: 1 });
    const fit = HONEST_BRIEF.replace(/\*\*Founder-Market Fit:\*\*.*/, '**Founder-Market Fit:** six years in creator marketing, from `Discovery/inbox/pitch.md`.');
    expect(checkFounderBrief(vault, fit, ctx)).toEqual({ ok: true, findings: [] });
  });
});

describe('briefFromProposalBody', () => {
  it('takes the brief out of the "## Proposed content" fence the dispatcher adopts from', () => {
    const body = `Here is what I understood.\n\n## Proposed content\n\n\`\`\`\`\n${HONEST_BRIEF}\n\`\`\`\`\n\nSet approved: true.`;
    expect(briefFromProposalBody(body)).toBe(HONEST_BRIEF);
  });

  it('checks a body that forgot its fence as written — a brief with no fence is still a brief', () => {
    expect(briefFromProposalBody(LIVE_RUN_BRIEF)).toBe(LIVE_RUN_BRIEF);
  });
});

/**
 * FR-4 and FR-5 on the other side of the gate: the reviewer who passed the live run's citations unread, and
 * then returned a correct brief because "PIVOT REQUIRED is two words".
 */
describe('what good looks like for a discovery job (config/gates.yaml)', () => {
  const criteria = criteriaFor(loadGates(), 'discovery');

  it('tells the reviewer to open every cited file and to return the file and the false sentence', () => {
    expect(criteria).toContain('vault.read');
    expect(criteria).toMatch(/open every file the brief cites/i);
    expect(criteria).toMatch(/quotes the file and the false sentence/i);
    expect(criteria).toContain('Brand/name.md');
    expect(criteria).toContain('unstated');
  });

  it('quotes the three verdicts and says two words are one verdict', () => {
    for (const v of ['STRONG', 'WEAK', 'PIVOT REQUIRED']) expect(criteria, v).toContain(v);
    expect(criteria).toMatch(/PIVOT REQUIRED is two words/);
    expect(criteria).not.toMatch(/one word/i);
  });
});
