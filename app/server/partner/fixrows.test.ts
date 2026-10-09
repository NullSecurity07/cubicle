import { describe, expect, it } from 'vitest';
import { inputFixesIn } from './corrections.ts';
import { stateOf } from './economics.ts';
import { fixRows, movedLine } from './fixrows.ts';

// Journey 21: "6 cafés pay €39 a month" and "310 bookings" were taken as the numbers and never put in the brief.
describe('a founder\'s correction on the brief\'s rows', () => {
  const BRIEF = '# Company brief\n\n## Numbers\n\n- Price: €4 per booking\n- Bookings last month: 280\n- Paying cafés: 4 at €39 a month\n- Burn: €1,300 a month\n- Cash: €5,400\n- Runway: 4.2 months (calc: round(5400 / 1300, 1) = 4.2)\n';
  it('writes each input on its own row, says which row moved, and works the derived rows again', () => {
    const state = stateOf(BRIEF.split('## Numbers')[1]);
    const fixes = inputFixesIn('No: 6 cafés pay €39 a month, and bookings last month were 310.', state, '2026-10-09');
    expect(fixes.map((one) => [one.field, one.value])).toEqual([['paying', 6], ['volume', 310]]);
    const out = fixRows(BRIEF, fixes, state, '2026-10-09');
    expect(out.text).toContain('- Bookings last month: 310 (founder, 2026-10-09)\n- Paying cafés: 6 at €39 a month (founder, 2026-10-09)');
    expect(movedLine(out.moved, 'Company brief')).toBe('Company brief: Paying cafés 4 → 6; Bookings last month 280 → 310.');
    expect(out.text).toContain('- Runway: cash-positive');
    // Read back, the brief gives what the founder said, in their words.
    const after = stateOf(out.text.split('## Numbers')[1], { fixes });
    expect([after.inputs.paying?.value, after.inputs.paying?.source, after.inputs.volume?.value]).toEqual([6, 'founder', 310]);
  });
  it('puts a new price on the paying row, and a money row the brief lacks as a new row', () => {
    const state = stateOf(BRIEF.split('## Numbers')[1].replace('- Cash: €5,400\n', ''));
    const out = fixRows(BRIEF.replace('- Cash: €5,400\n', ''), [{ field: 'plan', value: 45, said: 'x', day: 'd', over: { value: 39 } }, { field: 'cash', value: 5200, said: 'x', day: 'd' }], state, '2026-10-09');
    expect(out.text).toContain('- Paying cafés: 4 at €45 a month (founder, 2026-10-09)');
    expect(out.text).toContain('- Cash: €5,200 (founder, 2026-10-09)');
    expect(out.moved).toEqual(['price per paying café €39 → €45', 'Cash €5,200 (new row)']);
  });
});
