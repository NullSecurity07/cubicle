import { describe, expect, it } from 'vitest';
import {
  disappointment, matching, mostDisappointed, npsOf, npsValue, percent, pmfOf, questionFor, questionsForForms, questionsText, readExport,
  responseKey, resultsOf, segmentsOf, similarity, splitCsv, surveyBlock, templateQuestions, topReasons, type Question, type SurveyResponse,
} from './survey.ts';

const PMF = templateQuestions('pmf');
const NPS = templateQuestions('nps');
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const reply = (answers: Record<string, string>, at = Date.UTC(2026, 8, 20)): SurveyResponse => ({ id: responseKey(at, answers), at, from: 'test', answers });

// A Tally export as it comes: its three bookkeeping columns, the questions as the founder typed them into Tally with
// the product's name in, a quoted answer holding a comma, and one row nobody filled in.
const TALLY = [
  'Submission ID,Respondent ID,Submitted at,How would you feel if you could no longer use Acme?,What type of people do you think would most benefit from Acme?,What is the main benefit you receive from Acme?,How can we improve Acme for you?',
  'a1,p1,2026-09-20 10:00:00,Very disappointed,Agency founders,"It saves me the Monday report, every week",Faster exports',
  'a2,p2,2026-09-20 11:00:00,Very disappointed,agency founders,Saves me the Monday report,More integrations',
  'a3,p3,2026-09-21 09:00:00,Somewhat disappointed,Agency founders,Nice dashboards,Faster exports please',
  'a4,p4,2026-09-21 12:00:00,Very disappointed,Freelancers,The Monday report writes itself,',
  'a5,p5,2026-09-22 08:00:00,Not disappointed,Freelancers,Not much,Cheaper',
  'a6,p6,2026-09-22 09:00:00,Somewhat disappointed,Freelancers,Dashboards,Faster exports',
  'a7,p7,2026-09-22 10:00:00,Very disappointed,Founders of agencies,Client reporting on autopilot,Mobile app',
  'a8,p8,2026-09-23 10:00:00,Not disappointed,Students,Free plan,Cheaper plan',
  'a9,p9,2026-09-23 11:00:00,Somewhat disappointed,Students,Dashboards look nice,Mobile app',
  'a10,p10,2026-09-24 11:00:00,Very disappointed,Agency founders,Saves hours on the Monday report,',
  'a11,p11,2026-09-24 12:00:00,,,,',
].join('\n');

describe('templates and copying out', () => {
  it('writes the Sean Ellis four, the NPS three, and nothing for a blank', () => {
    expect(PMF.map((question) => question.role)).toEqual(['disappointed', 'segment', 'benefit', 'improve']);
    expect(PMF[0].options).toEqual(['Very disappointed', 'Somewhat disappointed', 'Not disappointed']);
    expect(NPS.map((question) => question.type)).toEqual(['scale', 'text', 'text']);
    expect(templateQuestions('blank')).toEqual([]);
  });

  it('copies a numbered list with the product named, for an email and for a form editor', () => {
    expect(questionsText(PMF, 'Acme').split('\n')[0]).toBe('1. How would you feel if you could no longer use Acme? (Very disappointed / Somewhat disappointed / Not disappointed)');
    expect(questionsText(PMF).split('\n')[3]).toBe('4. How can we improve the product for you?');
    const forms = questionsForForms(PMF, 'Acme');
    expect(forms.split('\n\n')[0]).toBe('1. How would you feel if you could no longer use Acme?\n   [Multiple choice, one answer]\n   - Very disappointed\n   - Somewhat disappointed\n   - Not disappointed');
    expect(forms).toContain('2. What type of people do you think would most benefit from Acme?\n   [Long answer]');
    expect(questionsForForms(NPS, 'Acme')).toContain('[Linear scale, 0 to 10]');
  });
});

describe('reading an export', () => {
  it('splits CSV with quoted commas, doubled quotes, line breaks inside quotes, a BOM and semicolons', () => {
    expect(splitCsv('﻿a,b\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
    expect(splitCsv('a;b\n1;"two\nlines"')).toEqual([['a', 'b'], ['1', 'two\nlines']]);
    expect(splitCsv('"q, with comma";b\n1;2')).toEqual([['q, with comma', 'b'], ['1', '2']]);
    expect(splitCsv('a\tb\r\n1\t2\r\n\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('scores a header against a question with the product name taken out of both', () => {
    expect(similarity('How would you feel if you could no longer use Acme?', PMF[0].text, 'Acme')).toBe(1);
    expect(similarity('Main benefit you get from Acme', PMF[2].text, 'Acme')).toBeGreaterThan(0.45);
    expect(similarity('Submitted at', PMF[0].text)).toBe(0);
  });

  it('maps a Tally export question by question, skips the empty row and says so', () => {
    const read = readExport(TALLY, PMF, 'Acme');
    expect(read.mapping.map((one) => [one.question, one.column])).toEqual([['disappointed', 3], ['segment', 4], ['benefit', 5], ['improve', 6]]);
    expect(read.rows).toHaveLength(10);
    expect(read.skipped).toEqual(['row 12: no answer to any of the survey\'s questions']);
    expect(read.rows[0].answers.benefit).toBe('It saves me the Monday report, every week');
    expect(read.rows[0].at).toBe(Date.parse('2026-09-20 10:00:00'));
    expect(read.unmatchedColumns).toEqual([]);
  });

  it('reads a Google Forms export whose headers were reworded, finding the Sean Ellis column by its answers', () => {
    const csv = 'Timestamp,Your feelings,Who is it for?,Role\n2026/09/20 10:00:00,Very disappointed,Agencies,CEO\n2026/09/21 10:00:00,Not disappointed,Students,Student';
    const read = readExport(csv, PMF);
    expect(read.mapping.find((one) => one.question === 'disappointed')).toMatchObject({ header: 'Your feelings', by: 'answers' });
    expect(read.unmatchedColumns).toContain('Role');
    expect(read.rows).toHaveLength(2);
  });

  it('refuses a file that answers none of the questions, and a survey with none', () => {
    expect(readExport('Name,Email\nAda,ada@x.io', PMF).skipped).toEqual(['no column matched any question: are these answers to this survey?']);
    expect(readExport('a\n1', []).skipped).toEqual(['the survey has no questions yet']);
    expect(readExport('only,a,header', PMF).skipped).toEqual(['the file has a header row and no answers']);
  });

  it('keys a response by what was said and when, so a second import of the same file adds nothing', () => {
    expect(responseKey(1, { a: 'x', b: 'y' })).toBe(responseKey(1, { b: 'y', a: 'x' }));
    expect(responseKey(1, { a: 'x' })).not.toBe(responseKey(2, { a: 'x' }));
  });
});

describe('counting', () => {
  it('reads the Sean Ellis answer by its words or by its place among the choices', () => {
    expect(disappointment('Very disappointed')).toBe('very');
    expect(disappointment('somewhat disappointed ')).toBe('somewhat');
    expect(disappointment("I wouldn't be disappointed")).toBe('not');
    expect(disappointment('Not disappointed (it really isn\'t that useful)')).toBe('not');
    expect(disappointment('Gutted', ['Gutted', 'Meh', 'Fine'])).toBe('very');
    expect(disappointment('N/A - I no longer use it')).toBeNull();
    expect(disappointment('')).toBeNull();
  });

  it('never rounds a share up past the benchmark', () => {
    expect(percent(9, 23)).toBe(39);
    expect(percent(2, 5)).toBe(40);
    expect(percent(0, 0)).toBe(0);
    const pmf = pmfOf([...Array(9)].map(() => reply({ disappointed: 'Very disappointed' })).concat([...Array(14)].map(() => reply({ disappointed: 'Somewhat disappointed' }))), PMF[0]);
    expect(pmf).toMatchObject({ answered: 23, very: 9, score: 39, passes: false, trusted: false });
  });

  it('passes at exactly 40%, and trusts it from 30 answers', () => {
    const pmf = pmfOf([...Array(12)].map(() => reply({ disappointed: 'Very disappointed' })).concat([...Array(18)].map(() => reply({ disappointed: 'Not disappointed' }))), PMF[0]);
    expect(pmf).toMatchObject({ answered: 30, score: 40, passes: true, trusted: true });
  });

  it('counts NPS as promoters less detractors, from however the scale was written', () => {
    expect(npsValue('9 - Very likely')).toBe(9);
    expect(npsValue('10 (Extremely likely)')).toBe(10);
    expect(npsValue('10.0')).toBe(10);
    expect(npsValue('eleven')).toBeNull();
    const nps = npsOf(['10', '9', '9', '8', '7', '6', '0', 'x'].map((score) => reply({ nps: score })), NPS[0]);
    expect(nps).toMatchObject({ answered: 7, promoters: 3, passives: 2, detractors: 2, score: 14 });
    expect(npsOf(['0', '0', '9'].map((score) => reply({ nps: score })), NPS[0]).score).toBe(-33);
  });

  it('groups segments written differently, and picks the most disappointed among groups of three or more', () => {
    const rows = readExport(TALLY, PMF, 'Acme').rows.map((row) => reply(row.answers, row.at));
    const segments = segmentsOf(rows, PMF[1], PMF[0]);
    expect(segments[0]).toEqual({ name: 'Agency founders', answered: 5, very: 4, score: 80 });
    expect(segments.find((one) => one.name === 'Freelancers')).toMatchObject({ answered: 3, very: 1, score: 33 });
    expect(mostDisappointed(segments)?.name).toBe('Agency founders');
    // A group of two that all loved it is still too small to be the answer.
    expect(mostDisappointed([{ name: 'Tiny', answered: 2, very: 2, score: 100 }])).toBeNull();
  });

  it('clusters reasons by the words people share and quotes the shortest answer in each', () => {
    const reasons = topReasons(['It saves me the Monday report, every week', 'Saves me the Monday report', 'The Monday report writes itself', 'Client reporting on autopilot', 'Saves hours on the Monday report', 'Dashboards', 'Nice dashboards']);
    expect(reasons[0]).toEqual({ term: 'monday report', count: 4, quote: 'Saves me the Monday report' });
    expect(reasons[1]).toMatchObject({ term: 'dashboard', count: 2, quote: 'Dashboards' });
    expect(reasons).toHaveLength(2);
    expect(topReasons(['one thing', 'another'])).toEqual([]);
  });

  it('finds the scored questions after the founder rewords them and drops their roles', () => {
    const edited: Question[] = [{ id: 'q1', type: 'choice', text: 'Imagine Acme vanished. Your reaction?', options: ['Very disappointed', 'Somewhat disappointed', 'Not disappointed'] }];
    expect(questionFor(edited, 'disappointed')?.id).toBe('q1');
    expect(questionFor([{ id: 'q', type: 'scale', text: 'Would you recommend us?' }], 'nps')?.id).toBe('q');
  });
});

describe('what the card and a wired person read', () => {
  const rows = readExport(TALLY, PMF, 'Acme').rows.map((row) => reply(row.answers, row.at));
  const card = { title: 'September PMF', template: 'pmf' as const, product: 'Acme', questions: PMF };

  it('puts the score, the segment, the reasons and the asks together', () => {
    const results = resultsOf(card, rows);
    expect(results.pmf).toMatchObject({ answered: 10, very: 5, somewhat: 3, not: 2, score: 50, passes: true, trusted: false });
    expect(results.top?.name).toBe('Agency founders');
    // Reasons come from the very disappointed only: nobody who loves it named the dashboards.
    expect(results.reasons.map((reason) => reason.term)).toEqual(['monday report']);
    // Asks come from the somewhat disappointed: two of the three want faster exports.
    expect(results.asks[0]).toMatchObject({ term: 'faster export', count: 2 });
    expect(results.last).toBe(Date.parse('2026-09-24 11:00:00'));
  });

  it('writes a two-line block that ends on the day of the newest answer', () => {
    expect(surveyBlock(card, rows, '2026-09-25', day)).toBe([
      `- PMF survey "September PMF": 10 answers, 50% very disappointed (at or above 40%). Most disappointed: agency founders (80%, 5 answers). Top reason: 'Saves me the Monday report'.`,
      `  Under 30 answers: too few to trust. Raw answers with read_survey. Newest answer ${day(Date.parse('2026-09-24 11:00:00'))}.`,
    ].join('\n'));
    expect(surveyBlock({ ...card, title: '' }, [], '2026-09-25', day)).toBe('- PMF survey "PMF survey": 4 questions, no answers yet; the founder imports them from Tally or Google Forms. Read it with read_survey. Today is 2026-09-25.');
  });

  it('says NPS signed, and finds answers holding every word of a query', () => {
    const nps = { title: 'Q3 NPS', template: 'nps' as const, questions: NPS };
    const scored = ['10', '9', '3'].map((score, at) => reply({ nps: score, reason: at ? 'too slow' : 'fast exports' }, Date.UTC(2026, 8, 20 + at)));
    expect(surveyBlock(nps, scored, '2026-09-25', day)).toContain(': 3 answers; NPS +33 (3 scores).');
    expect(matching(scored, 'slow').map((one) => one.answers.nps)).toEqual(['9', '3']);
    expect(matching(scored, 'fast export').map((one) => one.answers.nps)).toEqual(['10']);
  });
});
