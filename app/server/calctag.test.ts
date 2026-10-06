import { describe, expect, it } from 'vitest';
import { calcTagsHeld } from './calctag.ts';

// Journey 16: every line of a reply marked "(calc)" with no calc call in the turn.
describe('a "(calc)" tag', () => {
  it('stands beside a figure a calc working gave, and goes everywhere else', () => {
    const reply = 'Break-even: 33 subscribers (calc)\nRunway: 5.6 months (calc)\nGross margin: €294.02 (calc)';
    expect(calcTagsHeld(reply, ['ceil(1900 / 59) = 33', 'round(6000 / (1900 - 14 * 59), 1) = 5.6'])).toBe('Break-even: 33 subscribers (calc)\nRunway: 5.6 months (calc)\nGross margin: €294.02');
    expect(calcTagsHeld(reply, [])).toBe('Break-even: 33 subscribers\nRunway: 5.6 months\nGross margin: €294.02');
    // A rounding of the working's result counts as the result.
    expect(calcTagsHeld('About 31 studios (calc).', ['900 / 29 = 31.03448276'])).toBe('About 31 studios (calc).');
    expect(calcTagsHeld('No tag here.', [])).toBe('No tag here.');
  });
});
