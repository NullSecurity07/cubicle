import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import {
  DISCOVERY_INBOX, INTERVIEW_PATH, FOUNDER_BRIEF, LONG_PROMPT_CHARS,
  isLongPrompt, listDiscoveryInputs, discoveryDigest, hasFounderBrief,
  INTERVIEW_QUESTIONS, renderInterviewAsk, renderInterviewAsked, interviewPhase, closeInterview, interviewAnswer, isSkip, closesInterview,
  parseCeoAnswers, ceoAnswersFrom, unstatedAnswers, endorsesInterview, ownerAnsweredInterview, interviewAnswersSection, CEO_UNKNOWN,
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
  it('puts six questions and the CEO\'s own six answers in one message, and says how to skip (P8-13)', () => {
    expect(INTERVIEW_QUESTIONS.length).toBe(6);
    const ask = renderInterviewAsk();
    expect(ask.match(/^\*\*\d+\. /gm)!.length).toBe(6);
    expect(ask.match(/^\*\*CEO:\*\* /gm)!.length).toBe(6);
    expect(ask).toContain('skip');
    // The owner is not asked to answer: they are shown answers to add to (the live-run complaint).
    expect(ask.split('\n')[0]).toBe('Here is how I would answer these six from what I have — add anything, correct me, or say go.');
    // T13-3: the plan is written in the same cycle these go out, so the message must not promise otherwise.
    expect(ask).not.toMatch(/[Bb]efore I plan/);
  });

  it('carries the CEO\'s answers and their tags, and reads them back out of its own message (P8-13)', () => {
    const answers = parseCeoAnswers([
      '1. A weekly meal kit for nurseries. [from the idea]',
      '2. Nursery managers; today they cook from scratch. [from the vault]',
      '3. I do not know what already exists. [unstated]',
      '4. Ten paying nurseries. [from the idea]',
      '5. Nothing has been tried yet that I know of.',
      '6. Nothing is off the table that anyone has told me. [unstated]',
    ].join('\n'));
    expect(answers.map((a) => a.tag)).toEqual(['from the idea', 'from the vault', 'unstated', 'from the idea', 'unstated', 'unstated']);
    expect(answers[0].text).toBe('A weekly meal kit for nurseries.');
    const ask = renderInterviewAsk(INTERVIEW_QUESTIONS, 0, answers);
    expect(ask).toContain('**CEO:** A weekly meal kit for nurseries. [from the idea]');
    expect(ask).toContain('[unstated]');
    // The resume path reads the answers back off the message the owner can already see.
    expect(ceoAnswersFrom(ask)).toEqual(answers);
  });

  it('fills in for a model that answered badly, or not at all (P8-13)', () => {
    expect(parseCeoAnswers(null).every((a) => a.tag === 'unstated' && a.text === CEO_UNKNOWN)).toBe(true);
    expect(unstatedAnswers(6)).toEqual(parseCeoAnswers(''));
    const short = parseCeoAnswers('1) Meal kits. [from the idea]\n2) Nurseries.');
    expect(short.length).toBe(6);
    expect(short[0]).toEqual({ text: 'Meal kits.', tag: 'from the idea' });
    expect(short[1]).toEqual({ text: 'Nurseries.', tag: 'unstated' });   // no tag → unstated
    expect(short[5]).toEqual({ text: CEO_UNKNOWN, tag: 'unstated' });    // absent → unstated
    // A stray seventh answer, and a number out of range, are dropped rather than shifting the rest.
    expect(parseCeoAnswers('7. Nonsense. [from the idea]')[0].tag).toBe('unstated');
  });

  it('reads its own state out of the transcript, with no cache anywhere', () => {
    expect(interviewPhase(null)).toBe('none');
    expect(interviewPhase('   ')).toBe('none');
    const asked = renderInterviewAsked('2026-09-11T10:00:00.000Z');
    expect(interviewPhase(asked)).toBe('asked');
    expect(interviewPhase(closeInterview(asked, 'We sell meal kits to nurseries.', '2026-09-11T11:00:00.000Z'))).toBe('answered');
    expect(interviewPhase(closeInterview(asked, 'skip', '2026-09-11T11:00:00.000Z'))).toBe('skipped');
  });

  it('promises only what FR-6 and P8-13 do: an addition, a go or a skip closes it, a question does not', () => {
    const ask = renderInterviewAsk();
    expect(ask).not.toContain('Whatever you say next closes this');
    expect(ask).toContain('A question to me leaves this open.');
    expect(renderInterviewAsked('2026-09-13T10:00:00.000Z')).not.toContain('whatever it says');
    expect(renderInterviewAsked('2026-09-13T10:00:00.000Z')).toContain('leaves it open');
  });

  it('the owner\'s reply is an addition, a go, or a skip — never a replacement (P8-13)', () => {
    const answers = parseCeoAnswers('1. Meal kits for nurseries. [from the idea]');
    const asked = renderInterviewAsked('2026-09-13T10:00:00.000Z', INTERVIEW_QUESTIONS, answers);
    expect(interviewPhase(asked)).toBe('asked');
    expect(ownerAnsweredInterview(asked)).toBe(false);
    expect(interviewAnswersSection(asked)).toContain('**CEO:** Meal kits for nurseries. [from the idea]');

    const added = closeInterview(asked, 'Nurseries, not parents.\nTwo already pay us.', '2026-09-13T11:00:00.000Z');
    expect(added).toContain('**You:** Nurseries, not parents.');
    expect(added).toContain('**CEO:** Meal kits for nurseries. [from the idea]');   // never replaced
    expect(interviewPhase(added)).toBe('answered');
    expect(interviewAnswer(added)).toBe('Nurseries, not parents.\nTwo already pay us.');
    expect(interviewAnswersSection(added)).toContain('**You:** Nurseries, not parents.');

    const went = closeInterview(asked, 'go', '2026-09-13T11:00:00.000Z');
    expect(went).toContain('## Endorsed');
    expect(/^\*\*You:\*\*/m.test(went)).toBe(false);
    expect(interviewPhase(went)).toBe('answered');
    expect(ownerAnsweredInterview(went)).toBe(true);
    expect(interviewAnswer(went)).toBe('');

    const skipped = closeInterview(asked, 'skip', '2026-09-13T11:00:00.000Z');
    expect(interviewPhase(skipped)).toBe('skipped');
    expect(ownerAnsweredInterview(skipped)).toBe(false);
    // A skipped transcript still carries the CEO's answers, and they stay out of the Answers material's tail.
    expect(interviewAnswersSection(skipped)).toContain('**CEO:**');
    expect(interviewAnswersSection(skipped)).not.toContain('skipped the interview');
  });

  it('closes on "go" and its short cousins, and on nothing that only contains them', () => {
    for (const t of ['go', 'Go.', 'ok', 'OK!', 'looks right', 'Looks good', 'yes']) {
      expect(endorsesInterview(t)).toBe(true);
      expect(closesInterview(t)).toBe(true);
    }
    expect(endorsesInterview('go and ask the research office')).toBe(false);
    expect(endorsesInterview('that is not right')).toBe(false);
  });

  it('closes on an answer or a skip, and on nothing else (finding F5, ruling FR-6)', () => {
    expect(closesInterview('skip')).toBe(true);
    expect(closesInterview('Nurseries.\nTwo already pay us.')).toBe(true);
    expect(closesInterview('We sell meal kits to nurseries, two of them already pay us monthly.')).toBe(true);
    // The first live run's message, which would have become the six answers.
    expect(closesInterview('your text is only half')).toBe(false);
    expect(closesInterview('')).toBe(false);
    expect(closesInterview('surprise me')).toBe(false);
    // A dozen words that end in a question mark are a question, not an answer.
    expect(closesInterview('Can you tell me what the research office is going to do about this?')).toBe(false);
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
    // A transcript written before P8-13 still reads: `## Answers` is not `## Answer`.
    const legacy = '# Founder interview\n\n## Questions\n\n1. x\n\n## Answer\n\n_2026-09-11_\n\nWe sell meal kits.\n';
    expect(interviewPhase(legacy)).toBe('answered');
    expect(interviewAnswer(legacy)).toBe('We sell meal kits.');
    expect(interviewPhase(renderInterviewAsked('2026-09-11T10:00:00.000Z'))).toBe('asked');
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
