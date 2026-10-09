import { describe, expect, it } from 'vitest';
import { briefChangeLine, derivedAsInput, numbersRefusal, rowChanges } from './briefrows.ts';

describe('the brief\'s Numbers rows', () => {
  const brief = '- Price: €4 per booking\n- Paying cafés: 8 at €39 a month (founder, 2026-10-11)\n- Burn: €1,300 a month\n- Runway: cash-positive (calc: 5400 / 1300 = 4.2)';
  it('sees a row changed, added or taken out, and never a derived row or a stamp', () => {
    expect(rowChanges(brief, brief.replace(' (founder, 2026-10-11)', '').replace('4.2', '9'))).toEqual([]);
    expect(rowChanges(brief, brief.replace('€1,300', '€1300'))).toEqual([]);
    expect(rowChanges(brief, brief.replace('- Burn: €1,300 a month', '- Burn: -€54 a month'))).toEqual([{ label: 'Burn', from: '€1,300 a month', to: '-€54 a month' }]);
    expect(rowChanges(brief, brief.replace('- Burn: €1,300 a month\n', ''))).toEqual([{ label: 'Burn', from: '€1,300 a month' }]);
  });
  it('knows a worked-out figure written as an input', () => {
    expect(derivedAsInput('Burn', '-€54 a month (cash-positive)')).toBe(true);
    expect(derivedAsInput('Burn', '€1,000 a month, calculated as 1,300 − 300 = 1,000 (calc)')).toBe(true);
    expect(derivedAsInput('Burn', '€1,300 a month')).toBe(false);
    expect(derivedAsInput('Net burn', '-€54 a month (calc: …)')).toBe(false);
  });
  it('refuses a colleague, and the partner only a worked-out figure', () => {
    const maya = brief.replace('€1,300 a month', '-€54 a month (cash-positive)');
    expect(numbersRefusal(brief, maya, false)).toMatch(/^the brief's numbers are the founder's and the partner's/);
    expect(numbersRefusal(brief, maya, true)).toMatch(/"Burn: -€54 a month \(cash-positive\)" is a figure worked out from the others/);
    expect(numbersRefusal(brief, brief.replace('8 at', '9 at'), true)).toBeNull();
    expect(numbersRefusal(brief, brief, false)).toBeNull();
  });
  it('says each change in the morning note with who made it', () => {
    expect(briefChangeLine({ label: 'Burn', from: '€1,300 a month', to: '-€54 a month', at: 1, by: 'Maya' })).toBe('Company brief: Burn €1,300 a month → -€54 a month (by Maya).');
    expect(briefChangeLine({ label: 'Burn', from: '€1,300 a month', at: 1, by: 'Maya' })).toContain('the Burn row (€1,300 a month) was taken out (by Maya)');
  });
});
