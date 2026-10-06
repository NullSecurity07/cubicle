import { describe, expect, it } from 'vitest';
import { evidenceCheck, heardFrom, markClaims, markFeedback, markUnbacked, markUnworked, readableSources } from './evidence.ts';

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

// Journey 13: Tom's Unit Economics worked net burn and runway out in his head, forgot the produce, and both stood.
describe('a derived figure with no calc behind it', () => {
  const BRIEF13 = '# Company brief\n\n## Numbers\n\n- Monthly burn: €2,100\n- MRR: €720\n- Cash: €12,000\n- 3 paying offices; produce costs €178 a box';
  const ASK = 'Work out our unit economics in a new doc.';
  const mark = (line: string, read: string[]) => markUnworked({ before: '# Unit Economics\n', after: `# Unit Economics\n\n${line}`, read });

  it('is marked "(unsourced)" though its inputs were read', () => {
    expect(mark('Net burn at current MRR (€720): €1,380 per month', [BRIEF13, ASK]).text).toContain('Net burn at current MRR (€720): €1,380 (unsourced) per month');
    expect(mark('Runway at net burn: 8.7 months', [BRIEF13, ASK]).text).toContain('Runway at net burn: 8.7 (unsourced) months');
  });
  it('stands when a calc this turn worked it out from figures read, rounded as written', () => {
    const calcs = ['2100 - 720 = 1380', '12000 / 1380 = 8.695652174 (exact: 8.695652173913043)'];
    expect(mark('Net burn at current MRR (€720): €1,380 per month', [BRIEF13, ASK, ...calcs]).marked).toEqual([]);
    expect(mark('Runway at net burn: 8.7 months', [BRIEF13, ASK, ...calcs]).marked).toEqual([]);
    expect(mark('Net burn = 2,100 − 720 = 1,380 (calc)', [BRIEF13, ASK, ...calcs]).marked).toEqual([]);
    // The right figure, with the produce in, from a calc too.
    expect(mark('Net burn: €1,914 a month', [BRIEF13, ASK, '2100 + 3 * 178 - 720 = 1914']).marked).toEqual([]);
  });
  it('is still marked when the calc rests on a figure nothing read gives', () => {
    expect(mark('Runway: 6.3 months', [BRIEF13, ASK, '12000 / 1900 = 6.315789474']).marked).toHaveLength(1);
  });
  it('leaves alone figures read as written, lines that work nothing out, and dates', () => {
    for (const line of ['Monthly burn: €2,100 (brief)', 'Price: €178 a box for 3 offices', 'We ship on 10 Nov, 12 months of runway at most.', '5 pilot offices took part.'])
      expect(mark(line, [BRIEF13, ASK]).marked).toEqual([]);
  });
});

// Live run of the fix: an "upbeat" pilot feedback doc made up office manager quotes and eager teams.
describe('invented testimonials and eagerness', () => {
  const ASK = 'Make a doc called Pilot feedback: how the pilot offices feel about the boxes so far, what office managers say, and how pickup is going.';
  const plain = (text: string, read = [ASK]) => markFeedback({ before: '', after: text, read });
  it('marks a quote under a heading about what people said, and eager behaviour, when nothing read says it', () => {
    const doc = '# Pilot feedback\n\n## Office manager quotes\n- *"It has completely changed our Tuesday routine, everyone hangs around the kitchen."*\n\n## Office sentiment\n- **Excitement:** Teams eagerly await Tuesday deliveries.\n- **Pickup:** Evening pickups are running smoothly with steady participation.';
    const out = plain(doc);
    expect(out.marked).toHaveLength(3);
    expect(out.text).toContain('kitchen."* (assumption)');
    expect(plain('Office managers highlight the convenience as a great perk for morale.').marked).toHaveLength(1);
  });
  it('lets a quote read in interview notes stand, and does not read the founder\'s question as a record', () => {
    const notes = 'Interview notes: the Acme office manager said "it has completely changed our Tuesday routine".';
    expect(plain('## Quotes\n- "It has completely changed our Tuesday routine."', [ASK, notes]).marked).toEqual([]);
    expect(plain('## Quotes\n- "Pickup is going great for the pilot offices."').marked).toHaveLength(1);
  });
});

// Journey 15: Pia's spec read "Enable local 3 (unsourced)D printing" and "Printers listed (Current: 9 (unsourced))"
// against a brief that says "9 printers listed". A number glued to letters, a code and a ratio read are no counts.
describe('what the count guard takes as a count', () => {
  const brief = 'PrintNear rents out idle 3D printers to local makers. 9 printers listed, 4 print jobs done, 1 paying host. 60 makers contacted.';
  const mark = (line: string) => markUnbacked({ before: '', after: line, read: [brief] }).text;
  it.each([
    'Enable local 3D printing for makers.',
    'Upload a 3D model and pick a printer.',
    'Printers listed (Current: 9)',
    'Makers contacted (Current: 60)',
    'Makers reached so far: 9/60 printers to makers.',
    'Renders in 4K for the gallery.',
    'Ship in H2 with the host app.',
    'Runs on v2.1 of the slicer.',
    'Exports an mp4 of the print.',
    'Prints fit an A4 sheet.',
    'Hosts paused during COVID-19 lockdowns.',
    'Hosts call +44 20 7946 0958 for help.',
    'Support line 555-123-4567 for hosts.',
    'First print on 2026-10-19 for makers.',
    'Pickup at postcode 10115 for makers.',
    'Pickup at Torstrasse 1, 10115 Berlin.',
    'Brand colour #ff0000 and #3d00ff for hosts.',
    'Post with #3dprinting and #1 makers.',
    'The 9 printers listed so far.',
  ])('leaves "%s" as written', (line) => {
    expect(mark(line)).toBe(line);
  });
  it.each([
    ['We have 3 printers in Kreuzberg.', 'We have 3 (unsourced) printers in Kreuzberg.'],
    ['12 makers booked a print.', '12 (unsourced) makers booked a print.'],
    ['Makers reached so far: 9/70.', 'Makers reached so far: 9/70 (unsourced).'],
    ['Hosts listed 3D models: 7 printers.', 'Hosts listed 3D models: 7 (unsourced) printers.'],
  ])('marks "%s"', (line, marked) => {
    expect(mark(line)).toBe(marked);
  });
  it('takes no count from a brief\'s "3D printers"', () => {
    expect(markUnbacked({ before: '', after: '3 printers in use', read: ['We rent idle 3D printers.'] }).text).toBe('3 (unsourced) printers in use');
  });
  it('leaves "3D" alone in a derived figure line', () => {
    expect(markUnworked({ before: '', after: 'Monthly burn on 3D printing: €600', read: ['burn €600 a month'] }).text).toBe('Monthly burn on 3D printing: €600');
  });
});
