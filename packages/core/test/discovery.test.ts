import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import {
  DISCOVERY_INBOX, INTERVIEW_PATH, FOUNDER_BRIEF, LONG_PROMPT_CHARS,
  isLongPrompt, listDiscoveryInputs, discoveryDigest, hasFounderBrief,
  INTERVIEW_QUESTIONS, renderInterviewAsk, renderInterviewAsked, interviewPhase, closeInterview, interviewAnswer, isSkip,
  FOUNDER_BRIEF_SECTIONS, missingBriefSections, founderBriefTemplate, founderBriefProposalBody,
} from '../src/discovery.js';

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-discovery-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('the three discovery inputs (spec §1)', () => {
  it('tells a one-line idea from a long prompt by length or by shape', () => {
    expect(isLongPrompt('A meal-planning site for busy parents')).toBe(false);
    expect(isLongPrompt('x'.repeat(LONG_PROMPT_CHARS))).toBe(true);
    expect(isLongPrompt('one\ntwo\nthree\nfour\nfive')).toBe(true);
    expect(isLongPrompt('one\ntwo\nthree\nfour')).toBe(false);
    // A markdown heading is chrome, not content: it must not tip a short idea over the line.
    expect(isLongPrompt('# Title\n\nA meal-planning site')).toBe(false);
  });

  it('lists what the owner dropped in, saying which files it can actually read', () => {
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, '# Pitch\n\nWe sell meal kits.', 'owner');
    vault.writeText(`${DISCOVERY_INBOX}/numbers.csv`, 'month,revenue\n1,100\n', 'owner');
    vault.writeText(`${DISCOVERY_INBOX}/deck.pdf`, '%PDF-1.7', 'owner');
    const inputs = listDiscoveryInputs(vault);
    // the README the template ships is skipped
    expect(inputs.map((i) => i.path)).toEqual([`${DISCOVERY_INBOX}/deck.pdf`, `${DISCOVERY_INBOX}/numbers.csv`, `${DISCOVERY_INBOX}/pitch.md`]);
    expect(inputs.find((i) => i.path.endsWith('.pdf'))!.readable).toBe(false);
    expect(inputs.find((i) => i.path.endsWith('pitch.md'))!.chars).toBeGreaterThan(0);
  });

  it('digests the material so the same inputs never queue a second discovery job', () => {
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits.', 'owner');
    const first = discoveryDigest(vault, 'the owner typed this');
    expect(discoveryDigest(vault, 'the owner typed this')).toBe(first);
    expect(discoveryDigest(vault, 'something else')).not.toBe(first);
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries.', 'owner');
    expect(discoveryDigest(vault, 'the owner typed this')).not.toBe(first);
    vault.writeText(INTERVIEW_PATH, '# Founder interview\n', 'ceo');
    const withInterview = discoveryDigest(vault, 'the owner typed this');
    vault.writeText(INTERVIEW_PATH, '# Founder interview\n\n## Answer\n\nWe sell to nurseries.\n', 'ceo');
    expect(discoveryDigest(vault, 'the owner typed this')).not.toBe(withInterview);
  });

  it('knows whether a founder brief has been adopted', () => {
    expect(hasFounderBrief(vault)).toBe(false);
    vault.writeText(FOUNDER_BRIEF, '   \n', 'daemon');
    expect(hasFounderBrief(vault)).toBe(false);
    vault.writeText(FOUNDER_BRIEF, '## What the company is\n\nMeal kits.\n', 'daemon');
    expect(hasFounderBrief(vault)).toBe(true);
  });
});

describe('the cabin interview (spec §1.4)', () => {
  it('asks at most six questions in one message, and says how to skip', () => {
    expect(INTERVIEW_QUESTIONS.length).toBe(6);
    const ask = renderInterviewAsk();
    expect(ask.match(/^\d+\. /gm)!.length).toBe(6);
    expect(ask).toContain('skip');
    expect(ask.split('\n')[0]).toMatch(/[Ss]ix questions/);
    // T13-3: the plan is written in the same cycle these go out, so the message must not promise otherwise.
    expect(ask).not.toMatch(/[Bb]efore I plan/);
    expect(ask.split('\n')[0]).toMatch(/starting from what you have already given me/);
  });

  it('reads its own state out of the transcript, with no cache anywhere', () => {
    expect(interviewPhase(null)).toBe('none');
    expect(interviewPhase('   ')).toBe('none');
    const asked = renderInterviewAsked('2026-09-11T10:00:00.000Z');
    expect(interviewPhase(asked)).toBe('asked');
    expect(interviewPhase(closeInterview(asked, 'We sell meal kits to nurseries.', '2026-09-11T11:00:00.000Z'))).toBe('answered');
    expect(interviewPhase(closeInterview(asked, 'skip', '2026-09-11T11:00:00.000Z'))).toBe('skipped');
  });

  it('recognises a skip only as a whole answer, never as a word inside one', () => {
    expect(isSkip('skip')).toBe(true);
    expect(isSkip('  Skip. ')).toBe(true);
    expect(isSkip('not now')).toBe(true);
    expect(isSkip('Do not skip the security review')).toBe(false);
  });

  it("keeps the owner's own words, and keeps them out of a skipped transcript", () => {
    const asked = renderInterviewAsked('2026-09-11T10:00:00.000Z');
    const answered = closeInterview(asked, 'We sell meal kits.\nTwo nurseries already pay.', '2026-09-11T11:00:00.000Z');
    expect(interviewAnswer(answered)).toBe('We sell meal kits.\nTwo nurseries already pay.');
    expect(answered).toContain(INTERVIEW_QUESTIONS[0]);
    expect(interviewAnswer(closeInterview(asked, 'skip'))).toBe('');
    expect(interviewAnswer(null)).toBe('');
  });
});

describe('the founder brief (spec §1.7)', () => {
  it('has eight sections and names the ones a draft is missing', () => {
    expect(FOUNDER_BRIEF_SECTIONS.length).toBe(8);
    // The empty template carries all eight headings and has answered exactly one of them: none. `## Pressure
    // test` is the section whose body is checked, so the template is short of it until someone writes it
    // (ruling H5) — which is the point of §4, "the brief takes the test once".
    expect(missingBriefSections(founderBriefTemplate())).toEqual(['## Pressure test']);
    expect(missingBriefSections('## What the company is\n\nMeal kits.')).toEqual([...FOUNDER_BRIEF_SECTIONS].slice(1));
    // A heading mentioned inside prose is not a section.
    expect(missingBriefSections('We never wrote ## Constraints anywhere real')).toContain('## Constraints');
  });

  it('asks the owner to approve the exact text that becomes the brief', () => {
    const body = founderBriefProposalBody('## What the company is\n\nMeal kits.', ['Discovery/inbox/pitch.md', 'Discovery/interview.md']);
    expect(body).toContain('## Proposed content');
    expect(body).toContain('```\n## What the company is\n\nMeal kits.\n```');
    expect(body).toContain('- Discovery/inbox/pitch.md');
    expect(body).toContain('`approved: true`');
    expect(founderBriefProposalBody('x', [])).toContain('nothing but this conversation');
  });
});
