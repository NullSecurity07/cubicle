import { describe, expect, it } from 'vitest';
import { evidenceCheck, heardFrom, markClaims, markFeedback, markUnbacked, readableSources } from './evidence.ts';

const TEMPLATE = '# Evaluation\n\n## 2. Three specific ways it dies\n\n1. — survivable? — cheapest test:\n\n## 3. Is the pain real?\n\nVitamin — painkiller — hair on fire:\n\nWhat it costs them per month:\n\nReal customer conversations done (of ten to twenty):\n\n## 5. Verdict\n\nOne word (STRONG / WEAK / PIVOT REQUIRED):\n';
// Journey 10's founder: twelve beta users, two paying, forty playtest sessions logged. Nobody talked to anyone.
const FOUNDER = 'I run Kindling, a playtest tool for board game designers. We have 12 beta users (2 paying), MRR €78, and 40 playtest sessions logged.';
const BRIEF = '# Company brief\n\n## Numbers\n\n- Beta users: 12 (2 paying)\n- MRR: €78\n';
const pain = (text: string) => TEMPLATE.replace('Real customer conversations done (of ten to twenty):\n', `Real customer conversations done (of ten to twenty):\n\n${text}\n`);
const check = (after: string, said = [FOUNDER]) => evidenceCheck({ before: TEMPLATE, after, counts: [...said, BRIEF, TEMPLATE], said });
const refusal = (after: string, said?: string[]) => { try { check(after, said); return null; } catch (error) { return (error as Error).message; } };

describe('a count on a team doc line', () => {
  it('is refused when nothing read gives it for the thing counted, even when it is ten or less', () => {
    // Journey 10: Meera took the two paying users for two customer conversations.
    expect(refusal(TEMPLATE.replace('Real customer conversations done (of ten to twenty):', 'Real customer conversations done (of ten to twenty): 2 (beta users currently paying)')))
      .toMatch(/^not written: "2" \(in "Real customer conversations done \(of ten to twenty\): 2/);
    // Ananya and Meera: "3+ hours per test", which the founder never said.
    expect(refusal(TEMPLATE.replace('What it costs them per month:', 'What it costs them per month: 3+ hours per test')))
      .toMatch(/^not written: "3\+" \(in "What it costs them per month: 3\+ hours per test"\) is not in any founder message, document or tool result read/);
    // The 2 paying users are real; the retention is what nobody said.
    expect(refusal(pain('Painkiller: retention OK among the 2 paying.'))).toMatch(/^not written: "retention OK"/);
  });

  it('stands when the founder gave it, in their words or the brief\'s', () => {
    expect(check(pain('40 playtest sessions logged so far.')).text).toContain('40 playtest sessions logged so far.');
    expect(check(pain('Beta users: 12, of whom 2 are paying users.')).text).toContain('2 are paying');
    // Said in words by the founder: "six years" gives "6 years".
    expect(check(pain('Designers run 6 playtests a month.'), [FOUNDER, 'Our designers run six playtests a month.']).text).toContain('6 playtests');
    // Said to the founder's own chat: any room's founder words count.
    expect(check(TEMPLATE.replace('Real customer conversations done (of ten to twenty):', 'Real customer conversations done (of ten to twenty): 3'), [FOUNDER, 'I have had 3 customer conversations this week.']).text)
      .toContain('done (of ten to twenty): 3');
  });

  it('leaves alone list numbers, years, dates, scores, money, plans and what was already there', () => {
    const plan = TEMPLATE
      .replace('1. — survivable? — cheapest test:', '1. Hosts stop after 2026 — survivable? — cheapest test: interview 5 hosts by 11 October')
      .replace('One word (STRONG / WEAK / PIVOT REQUIRED):', 'One word (STRONG / WEAK / PIVOT REQUIRED): WEAK\n\nScore: 5/10 (Assumption: 1/2, Pain: 1/2) (3)\n\nNext 7-day action: conduct 8 more conversations; MRR is €78.');
    expect(check(plan).text).toBe(plan);
    // A count marked "(unsourced)" by the writer is theirs to own.
    expect(refusal(TEMPLATE.replace('What it costs them per month:', 'What it costs them per month: 3 (unsourced) hours per test'))).toBeNull();
  });
});

describe('an evidence claim on a pain, conversations or traction section', () => {
  it('is refused when no founder message or tool result says it', () => {
    expect(refusal(TEMPLATE.replace('Vitamin — painkiller — hair on fire:', 'Vitamin — painkiller — hair on fire: Painkiller (some pay, retention OK — workable)')))
      .toMatch(/^not written: "retention OK" in "3\. Is the pain real\?": no founder message or tool result says this\./);
    expect(refusal(pain('Customers love the reports.'))).toMatch(/"Customers love".*no founder message or tool result says this/);
    expect(refusal(pain('The pain is validated.'))).toMatch(/"validated"/);
    expect(refusal(pain("We've had two real customer conversations."))).toMatch(/"We've had two real customer conversations"/);
    // A document is no source for it: only the founder's words or a tool result.
    expect(refusal(pain('Retention is good.'), [FOUNDER])).toMatch(/no founder message or tool result says this/);
  });

  it('stands when the founder said it, when it is denied, and only on evidence sections', () => {
    expect(check(pain('Retention is good.'), [FOUNDER, 'Retention is good: 9 of the 12 came back this month.']).text).toContain('Retention is good.');
    expect(check(pain('Not validated yet: no conversations are recorded.')).text).toContain('Not validated yet');
    const deaths = TEMPLATE.replace('1. — survivable? — cheapest test:', '1. Customers love it but will not pay — survivable? — cheapest test: a paid pilot');
    expect(check(deaths).text).toBe(deaths);
  });

  it('keeps an opinion, marked "(assumption)" by the guard when the writer did not', () => {
    const out = check(pain('I think retention is likely OK. Likely a painkiller (assumption).'));
    expect(out.text).toContain('I think retention is likely OK (assumption). Likely a painkiller (assumption).');
    expect(out.marked).toEqual(['I think retention is likely OK.']);
  });
});

// A count on a line with no section, held to what was read: null when it stands, else what is not written.
const unbacked = (line: string, read: string[]) => { try { evidenceCheck({ before: '', after: line, counts: read, said: read }); return null; } catch (error) { return (error as Error).message; } };

describe('matching a count to what was read', () => {
  // Each row: the line written, what was read, whether the count stands.
  const CASES: [string, string[], boolean][] = [
    ['Beta users: 12', [FOUNDER], true],
    ['12 beta users so far.', [FOUNDER], true],
    ['Paying users: 2', [BRIEF], true],
    ['40 playtest sessions logged.', [FOUNDER], true],
    ['1,200 sign-ups from the launch.', ['We got 1200 sign-ups from the launch.'], true],
    ['1200 sign-ups from the launch.', ['We got 1,200 sign-ups.'], true],
    ['12 testers joined.', ['Twelve testers joined in March.'], true],
    ['12 hosts on the waitlist.', ['A dozen hosts are on the waitlist.'], true],
    ['25 designers signed up.', ['Twenty-five designers signed up.'], true],
    ['12 users in the beta.', ['There are 12.0 users in the beta.'], true],
    ['| Beta users | 12 |', ['| Beta users | 12 |'], true],
    ['Customer conversations: 3', ['I had three customer calls this week.'], true],
    // Journey 10: two paying users are not two conversations, nor forty sessions forty hosts.
    ['Real customer conversations done: 2', [FOUNDER, BRIEF], false],
    ['Only 2 real customer conversations have been conducted.', [FOUNDER, BRIEF], false],
    ['What it costs them per month: 3+ hours per test', [FOUNDER, BRIEF], false],
    ['Your 40 playtest hosts are active.', [FOUNDER], false],
    ['10 non-paying beta users contacted for testing.', [FOUNDER, BRIEF], false],
    // The same number in the same sentence, but said of something far from it.
    ['2 sessions a week.', [FOUNDER], false],
    // Word overlap alone was enough before: "12" and "users" are both in the founder's sentence, not together.
    ['12 paying users.', ['We have 12 beta testers and 3 paying users.'], false],
  ];
  it.each(CASES)('%s', (line, read, stands) => {
    const out = unbacked(line, read);
    if (stands) expect(out).toBeNull();
    else expect(out).toMatch(/^not written: "\d+\+?"/);
  });
});

describe('what of a colleague\'s answer backs a count', () => {
  it('keeps only the sentences whose counts the colleague read, plans and orders held too', () => {
    expect(heardFrom('The founder has 12 beta users. They signed 7 paid pilots. We should interview 5 hosts.', [FOUNDER]))
      .toEqual(['The founder has 12 beta users.']);
    expect(heardFrom('Twelve beta users, I think.', [])).toEqual([]);
  });
});

// Journey 12: Omar worked out a runway of 8 months and 32 paying studios with calc from the brief's figures, and the
// doc marked both "(unsourced)", since the sum names no months and no studios.
describe('a count worked out with calc', () => {
  const BRIEF12 = '# Company brief\n\n- Paying studios: 3 at €29 a month\n- Cash: €7,200\n- Burn: €1,400 a month';
  const ASKED = 'If we cut burn to €900 a month, what is our runway and how many paying studios do we need?';
  const mark = (after: string, read: string[]) => markUnbacked({ before: '# Unit economics\n', after: `# Unit economics\n${after}`, read });
  it('is backed by the sum, its rounding and its inputs when every input was read', () => {
    const out = mark('- Gross runway: 8 months\n- Break-even: 32 studios (exact: 31.03)\n- 900 a month of burn', [BRIEF12, ASKED, '7200 / 900 = 8', '900 / 29 = 31.03448276 (exact: 31.03448275862069)']);
    expect(out.marked).toEqual([]);
    expect(out.text).not.toContain('(unsourced)');
  });
  it('builds on an earlier sum', () => {
    expect(mark('- Net runway: 8 months, burn 813', [BRIEF12, ASKED, '7200 / 813 = 8.856088561 (exact: 8.85608856088561)', '900 - 87 = 813', 'MRR €87']).marked).toEqual([]);
  });
  it('inherits "unsourced" when an input was not read', () => {
    const out = mark('- Gross runway: 8 months', [BRIEF12, '7200 / 900 = 8']);
    expect(out.marked).toEqual([{ label: '8', line: '- Gross runway: 8 (unsourced) months' }]);
    expect(readableSources([BRIEF12, '7200 / 900 = 8'])).not.toContain('7200 / 900 = 8');
    expect(readableSources([BRIEF12, ASKED, '7200 / 900 = 8'])).toContain('7200 / 900 = 8');
  });
  it('is no sum when the arithmetic is wrong', () => {
    expect(mark('- Gross runway: 9 months', [BRIEF12, ASKED, '7200 / 900 = 9']).marked).toHaveLength(1);
  });
  it('is not backed by a mark or a report that quotes it marked, said again later in the turn', () => {
    const first = mark('- Gross runway: 8 months', [BRIEF12]);
    const report = `Marked as unsourced: "8" (in "${first.marked[0].line}")`;
    const again = markUnbacked({ before: '# Unit economics\n', after: '# Unit economics\n- Gross runway: 8 months', read: [BRIEF12, first.text, report] });
    expect(again.marked).toHaveLength(1);
  });
});

describe('a claim that the product works', () => {
  it('is refused on an evidence section when nobody said it, and marked as a view when hedged', () => {
    expect(refusal(pain('The product itself works for designers.'))).toMatch(/"The product itself works" in "3\. Is the pain real\?"/);
    expect(refusal(pain('We have proven to work with board game designers.'))).toMatch(/proven to work/);
    expect(check(pain('The product probably works for designers.')).text).toContain('(assumption)');
    expect(refusal(pain('The product itself works for designers.'), [FOUNDER, 'Designers tell me the app works every session.'])).toBeNull();
  });
  it('is marked "(assumption)" in a reason when nothing backs it', () => {
    expect(markClaims('The product itself works. 3 pay.', [FOUNDER])).toBe('The product itself works (assumption). 3 pay.');
  });
});

// Journey 13: Lena's customer notes put feedback in the pilot offices' mouths that nobody ever gave.
describe('feedback put in customers\' mouths', () => {
  const PICKUP = '**Engagement:** Strong initial pickup on Tuesday evenings; staff appreciate the convenience and freshness of local produce.';
  const PERK = '**Office manager feedback:** HR/Office managers report it acts as a popular perk and talking point in the office.';
  const BRIEF13 = '# Company brief\n\nWe deliver boxes of local produce to offices on Tuesdays for evening pickup. 5 pilot offices, 3 paying.';
  const ASK = 'Make a new doc with customer notes: what we actually know about our five pilot offices and what we still need to find out about churn after month three.';
  const plain = (line: string, read = [BRIEF13, ASK]) => markFeedback({ before: '# Customer notes\n', after: `# Customer notes\n\n${line}`, read });

  it('is marked "(assumption)" in a plain doc when nothing read says it', () => {
    expect(plain(PICKUP).text).toContain('freshness of local produce (assumption).');
    expect(plain(PERK).text).toContain('talking point in the office (assumption).');
    expect(plain(`${PICKUP}\n${PERK}`).marked).toHaveLength(2);
  });
  it('stands when notes read say it, by shared words', () => {
    const notes = 'Interview notes, Acme office: the office manager said the box is a nice perk and people talk about it at lunch.';
    expect(plain(PERK, [BRIEF13, notes]).marked).toEqual([]);
    expect(plain('Staff appreciate the freshness of the produce.', [BRIEF13, 'Survey: 7 of 9 staff said the freshness was the best part.']).marked).toEqual([]);
    // A record about something else backs nothing.
    expect(plain(PERK, [BRIEF13, 'The founder said churn after month three is the worry.']).marked).toHaveLength(1);
    expect(plain('Customers love it.', ['Founder: our customers love it.']).marked).toEqual([]);
  });
  it('leaves alone questions, things to find out and "no feedback on record"', () => {
    for (const line of [
      'Do office managers report it as a perk?',
      'Find out whether staff appreciate the Tuesday slot.',
      'Office manager feedback: no feedback on record.',
      'We do not know if the boxes are popular yet.',
      'Five pilot offices, three of them paying.',
    ]) expect(plain(line).marked).toEqual([]);
  });
  it('is refused on a team doc under any heading, and marked when hedged', () => {
    const before = '# Evaluation\n\n## Notes\n\n';
    const run = (line: string) => evidenceCheck({ before, after: `${before}${line}\n`, counts: [BRIEF13, ASK], said: [ASK] });
    expect(() => run(PERK)).toThrow(/"Office managers report" in "Notes".*no feedback on record/s);
    expect(run('Office managers probably see it as a popular perk.').text).toContain('popular perk (assumption).');
  });
  it('is marked in a partner\'s reason', () => {
    expect(markClaims('Keep going because staff engagement remains high.', [ASK])).not.toContain('(assumption)');
    expect(markClaims('Keep going: the offices report strong engagement.', [ASK])).toContain('(assumption)');
  });
});
