import { describe, expect, it } from 'vitest';
import { evidenceCheck } from './evidence.ts';

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
