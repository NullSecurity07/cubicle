import { describe, expect, it } from 'vitest';
import { correctionLines, correctionsIn, inUnits, keepCorrections, saysWrong, unitFix, unitsFix } from './corrections.ts';
import { economicsOf } from './economics.ts';

// Journey 15, day 1: the founder's pushback on the verdict, word for word.
export const PUSHBACK = "I don't buy it. You gave me no kill signal at all, and break-even is 50 print jobs a month, not 50 paying hosts: one host is not €12 a month of revenue. "
  + 'Give me a sharper call with a kill signal that can actually fail, tied to my 10-jobs goal.';
export const PRINTNEAR = '- Price: €12 per print job (paid by the maker)\n- Printers listed: 9\n- Print jobs done: 4\n- Paying hosts: 1\n- Cash: €2,500\n- Burn: €600 a month\n- Makers contacted: 60';

describe('a founder correction', () => {
  it('reads what is wrong and what is right from the journey 15 pushback', () => {
    expect(correctionsIn(PUSHBACK)).toEqual([
      { wrong: '50 paying hosts', right: '50 print jobs a month', said: 'You gave me no kill signal at all, and break-even is 50 print jobs a month, not 50 paying hosts' },
      { wrong: '€12 a month', about: 'one host', said: 'one host is not €12 a month of revenue' },
    ]);
  });

  it('reads "no, it is", "not X but Y" and "X, not Y", and nothing from a plain "not"', () => {
    expect(correctionsIn('No, it is 40 jobs.')).toEqual([{ right: '40 jobs', said: 'No, it is 40 jobs' }]);
    expect(correctionsIn('Burn is €600, not €900.')).toEqual([{ right: '€600', wrong: '€900', said: 'Burn is €600, not €900' }]);
    expect(correctionsIn('Revenue is not €0 but €48 a month.')[0]).toMatchObject({ wrong: '€0', right: '€48 a month' });
    expect(correctionsIn('We have not even 3 users yet, so do not hurry.')).toEqual([]);
    expect(correctionsIn('Write the update, not the deck.')).toEqual([]);
  });

  it('is kept dated, newest last, and a new word on the same figure replaces the old one', () => {
    const held = keepCorrections([], correctionsIn(PUSHBACK), '2026-10-06');
    expect(correctionLines(held)).toEqual(['- one host: not "€12 a month" (founder, 2026-10-06)', '- "50 print jobs a month", not "50 paying hosts" (founder, 2026-10-06)']);
    expect(keepCorrections(held, correctionsIn('Break-even is 44 print jobs a month, not 50 paying hosts.'), '2026-10-08')).toHaveLength(2);
  });

  it('finds a line that says the wrong figure, plural or not', () => {
    const said = correctionsIn(PUSHBACK);
    expect(saysWrong('Break-even point: 50 paying hosts', said)?.wrong).toBe('50 paying hosts');
    expect(saysWrong('- MRR: €12 a month', said)?.wrong).toBe('€12 a month');
    expect(saysWrong('Price: €12 per print job', said)).toBeUndefined();
    expect(saysWrong('We have 1 paying host', said)).toBeUndefined();
  });

  it('says break-even in the unit the founder gave, and only where break-even is said', () => {
    const fixes = unitFix(correctionsIn(PUSHBACK));
    expect(fixes).toEqual([{ wrong: 'paying hosts', right: 'print jobs' }]);
    expect(unitsFix('Now 44 paying hosts needed to break even. We have 1 paying host.', fixes)).toBe('Now 44 print jobs needed to break even. We have 1 paying host.');
    const old = { unit: 'paying hosts', working: [{ line: 'Break-even: ceil(600 / 12) = 50 paying hosts to cover the burn' }] };
    expect(inUnits(old, fixes)).toEqual({ unit: 'print jobs', working: [{ line: 'Break-even: ceil(600 / 12) = 50 print jobs to cover the burn' }] });
    expect(inUnits(economicsOf(PRINTNEAR), fixes)?.unit).toBe('print jobs a month');
  });
});
