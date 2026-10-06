import { describe, expect, it } from 'vitest';
import { codeSpans, replaceOutsideCodes, withoutFigures } from './figures.ts';
import { preciseFigures } from './media/grounding.ts';
import { figureIn } from './media/wording.ts';
import { numbersIn } from './deck/critic.ts';
import { markUnbacked } from './tools/evidence.ts';

// Each code, the line it sits in, and the code itself: whatever a guard strips, the code comes through whole.
const CODES: [string, string][] = [
  ['First print on 2026-10-19 (day 19), 74% of makers came.', '2026-10-19'],
  ['First print on 19 Oct 2026, 74% of makers came.', '19 Oct 2026'],
  ['First print on Oct 19, 74% of makers came.', 'Oct 19'],
  ['First print on October 19th, 2026, 74% of makers came.', 'October 19th, 2026'],
  ['First print on 10/19/2026, 74% of makers came.', '10/19/2026'],
  ['First print at 06:30, 74% of makers came.', '06:30'],
  ['Runs on v2.1 and 1.4.2 of the slicer, 74% of makers came.', '1.4.2'],
  ['Hosts call +44 20 7946 0958, 74% of makers came.', '+44 20 7946 0958'],
  ['Support line 555-123-4567, 74% of makers came.', '555-123-4567'],
];

describe('a date, a time, a version or a phone number is one thing', () => {
  it.each(CODES)('finds the code in "%s"', (line, code) => {
    expect(codeSpans(line).some(([from, to]) => line.slice(from, to).includes(code))).toBe(true);
  });

  it.each(CODES)('the film guard takes only the measurement out of "%s"', (line, code) => {
    const figures = preciseFigures(line);
    expect(figures).toEqual(['74%']);
    const kept = withoutFigures(line, figures);
    expect(kept).toContain(code);
    expect(kept).not.toContain('74%');
  });

  it('never leaves "-10- (day )" of the date the film agent saw', () => {
    const line = 'First print on 2026-10-19 (day 19).';
    expect(withoutFigures(line, preciseFigures(line))).toBe(line);
    // Even when a figure is the same digits as part of the date, the date is not where it is struck from.
    expect(withoutFigures('On 2026-10-19 we had 19 makers.', ['19'])).toBe('On 2026-10-19 we had  makers.');
    expect(withoutFigures('We had 190 makers and 19 hosts.', ['19'])).toBe('We had 190 makers and  hosts.');
  });

  it.each(CODES)('a stat scene is never a piece of the code in "%s"', (line) => {
    expect(figureIn(line)).toBe('74%');
  });

  it.each(CODES)('the deck and site guards strip around the code in "%s"', (line, code) => {
    expect(numbersIn(line)).toEqual(['74%']);
    expect(replaceOutsideCodes(line, /\d[\d,.]*%?/g, () => ' ')).toContain(code);
  });

  it.each(CODES)('the evidence guard reads no count in the code of "%s"', (line) => {
    const plain = line.replace(', 74% of makers came', ' for makers');
    expect(markUnbacked({ before: '', after: plain, read: ['We rent idle 3D printers.'] }).text).toBe(plain);
  });
});
