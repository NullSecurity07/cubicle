import { describe, it, expect } from 'vitest';
import {
  INTERVIEW_QUESTIONS, INTERVIEW_COVERAGE, INTERVIEW_CUES_NEEDED,
  coveredQuestions, openInterviewQuestions, briefSectionBody, sectionAnswers,
  interviewPhase, renderInterviewAsk, renderInterviewCovered, interviewAskTitle,
  founderBriefTemplate, missingBriefSections, FOUNDER_BRIEF_SECTIONS, FOUNDER_BRIEF_SECTIONS_V1,
  PRESSURE_TEST_SECTION, PRESSURE_TEST_SINCE,
} from '../src/discovery.js';

const TEMPLATE = founderBriefTemplate();

describe('the <Context> rule: do not ask what the owner already told you (spec §5)', () => {
  // Answers 1 (what you are building), 3 (what already exists) and 5 (what you tried); says nothing about who
  // it is for, what three months looks like, or what is off the table.
  const THREE_OF_SIX = [
    'We are building a weekly meal-kit box. The product is a Saturday delivery of five prepped dinners.',
    'We already have a waitlist of 90 people and the domain; the repo has a landing page on it.',
    'We tried a Facebook group first and it did not work — nobody posted after week two, so we abandoned it.',
  ].join('\n\n');

  it('covers exactly the three the material answers', () => {
    expect(coveredQuestions(THREE_OF_SIX)).toEqual([true, false, true, false, true, false]);
  });

  it('so the CEO asks the other three, in its own order', () => {
    expect(openInterviewQuestions(THREE_OF_SIX)).toEqual([INTERVIEW_QUESTIONS[1], INTERVIEW_QUESTIONS[3], INTERVIEW_QUESTIONS[5]]);
  });

  it('an empty vault is asked all six, which is what it always was', () => {
    expect(coveredQuestions('')).toEqual([false, false, false, false, false, false]);
    expect(openInterviewQuestions('')).toEqual([...INTERVIEW_QUESTIONS]);
    expect(openInterviewQuestions('hi')).toHaveLength(6);
  });

  it('one cue in passing is not an answer: two are', () => {
    expect(INTERVIEW_CUES_NEEDED).toBe(2);
    expect(coveredQuestions('We tried to call you.')[4]).toBe(false);
    expect(coveredQuestions('We tried ads and it did not work.')[4]).toBe(true);
  });

  it('every question has a cue set, index-aligned with the six', () => {
    expect(INTERVIEW_COVERAGE).toHaveLength(INTERVIEW_QUESTIONS.length);
    for (const q of INTERVIEW_COVERAGE) expect(q.cues.length).toBeGreaterThanOrEqual(INTERVIEW_CUES_NEEDED);
  });
});

describe('a written founder brief answers its own questions (Decision 15)', () => {
  const WRITTEN = [
    '## What the company is', '', 'A weekly meal-kit box delivered to nurseries before seven in the morning, priced per child.', '',
    '## Who it is for', '', 'Independent nursery managers running twenty to sixty places, who plan menus on a shared spreadsheet.', '',
  ].join('\n');

  it('reads the section, not the heading', () => {
    expect(briefSectionBody(WRITTEN, '## Who it is for')).toContain('Independent nursery managers');
    expect(briefSectionBody(WRITTEN, '## Constraints')).toBe('');
    expect(sectionAnswers(WRITTEN, '## What the company is', TEMPLATE)).toBe(true);
    expect(sectionAnswers(WRITTEN, '## Constraints', TEMPLATE)).toBe(false);
  });

  it('the empty template has answered nothing, however many headings it carries', () => {
    expect(coveredQuestions('', TEMPLATE, TEMPLATE)).toEqual([false, false, false, false, false, false]);
    for (const h of FOUNDER_BRIEF_SECTIONS) expect(sectionAnswers(TEMPLATE, h, TEMPLATE), h).toBe(false);
  });

  it('a written brief covers its questions even when the raw material says nothing', () => {
    const covered = coveredQuestions('', WRITTEN, TEMPLATE);
    expect(covered[0]).toBe(true);
    expect(covered[1]).toBe(true);
    expect(covered[2]).toBe(false);
  });

  it('a one-word section is a shrug, not an answer', () => {
    expect(sectionAnswers('## Constraints\n\nNone.', '## Constraints', TEMPLATE)).toBe(false);
  });
});

describe('what the owner reads, and what the transcript says', () => {
  it('the message says how many it is not asking, and why', () => {
    const msg = renderInterviewAsk([INTERVIEW_QUESTIONS[1], INTERVIEW_QUESTIONS[3]], 4);
    expect(msg).toContain('you have answered 4 of my six questions');
    expect(msg).toContain('1. Who is it for');
    expect(msg).toContain('2. What would have to be true');
    expect(msg).not.toContain('What are you building');
    expect(msg).toContain('Reply "skip"');
  });

  it('and reads exactly as it always did when all six are open', () => {
    const msg = renderInterviewAsk();
    expect(msg.startsWith('I am starting from what you have already given me. Six questions,')).toBe(true);
    for (const q of INTERVIEW_QUESTIONS) expect(msg).toContain(q);
  });

  it('titles itself by the count', () => {
    expect(interviewAskTitle(6)).toBe('Six questions, while I get started');
    expect(interviewAskTitle(3)).toBe('Three questions, while I get started');
    expect(interviewAskTitle(1)).toBe('One question, while I get started');
  });

  it('all six covered is a fifth phase, not a skip the owner never chose (Decision 16)', () => {
    const t = renderInterviewCovered('2026-09-12T09:00:00.000Z');
    expect(interviewPhase(t)).toBe('covered');
    expect(t).toContain('already answered all 6 questions');
    expect(interviewPhase(null)).toBe('none');
    expect(interviewPhase('# Founder interview\n\n## Questions\n\n1. x')).toBe('asked');
    expect(interviewPhase('# Founder interview\n\n## Answer\n\nwe sell x')).toBe('answered');
    expect(interviewPhase('# Founder interview\n\n## Skipped\n\n_skipped_')).toBe('skipped');
  });
});

describe('the founder brief takes the test once (spec §4)', () => {
  it('the eighth section is additive: the seven that were always there are still required', () => {
    expect(FOUNDER_BRIEF_SECTIONS).toHaveLength(8);
    expect(FOUNDER_BRIEF_SECTIONS_V1).toHaveLength(7);
    for (const h of FOUNDER_BRIEF_SECTIONS_V1) expect(FOUNDER_BRIEF_SECTIONS).toContain(h);
    expect(FOUNDER_BRIEF_SECTIONS[7]).toBe(PRESSURE_TEST_SECTION);
    expect(missingBriefSections(TEMPLATE)).toEqual([]);
  });

  it('the template names the five parts, in the owner\'s order', () => {
    const body = briefSectionBody(TEMPLATE, PRESSURE_TEST_SECTION);
    let at = -1;
    for (const part of ['Core Assumption', 'Three Fatal Flaws', 'Problem Validation', 'Founder-Market Fit', 'Brutal Verdict']) {
      const i = body.indexOf(part); expect(i, part).toBeGreaterThan(at); at = i;
    }
    expect(body).toContain('Docs/pressure-test-handbook.md');
  });

  it('a brief written now owes all eight', () => {
    const seven = FOUNDER_BRIEF_SECTIONS_V1.map((h) => `${h}\n\nsomething real here\n`).join('\n');
    expect(missingBriefSections(seven)).toEqual([PRESSURE_TEST_SECTION]);
    expect(missingBriefSections('## What the company is\n\nMeal kits.')).toEqual([...FOUNDER_BRIEF_SECTIONS].slice(1));
  });

  it('a brief proposed before the handbook existed is adopted, not refused for a section nobody had thought of', () => {
    const seven = FOUNDER_BRIEF_SECTIONS_V1.map((h) => `${h}\n\nsomething real here\n`).join('\n');
    expect(missingBriefSections(seven, '2026-09-11T23:59:00.000Z')).toEqual([]);
    expect(missingBriefSections(seven, `${PRESSURE_TEST_SINCE}T00:00:01.000Z`)).toEqual([PRESSURE_TEST_SECTION]);
    // It excuses the one new section and nothing else.
    expect(missingBriefSections('## What the company is\n\nx', '2026-01-01')).toContain('## Constraints');
    expect(missingBriefSections('## What the company is\n\nx', '2026-01-01')).not.toContain(PRESSURE_TEST_SECTION);
  });
});
