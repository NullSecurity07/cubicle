import { describe, expect, it } from 'vitest';
import { afforded, DRAFT_PICTURES, isDraft, makingSeconds, makingWords, secondsEach, shotsIn } from './film-time.ts';

describe('how long a film takes to make', () => {
  it('knows a picture drawn here is most of a minute, a draft a little over half that, and one drawn away is seconds', () => {
    expect(secondsEach(false)).toBeLessThan(10);
    expect(secondsEach(true)).toBeGreaterThan(40);
    expect(secondsEach(true, true)).toBeLessThan(secondsEach(true) * 0.7);
  });

  it('tells a founder the truth about a reel drawn on this computer, which is not "about a minute"', () => {
    const pictures = afforded(shotsIn(15), true);
    const said = makingWords({ seconds: 15, pictures, clips: 0, narrate: true, here: true });
    expect(Number(/about (\d+) minutes/.exec(said)?.[1])).toBeGreaterThanOrEqual(6);
    expect(said).toContain('this computer draws');
  });

  it('makes a draft of the same reel in two or three minutes, even with every picture drawn here', () => {
    const pictures = afforded(shotsIn(15), true, 8, true);
    expect(pictures).toBeLessThanOrEqual(DRAFT_PICTURES);
    const { all } = makingSeconds({ seconds: 15, pictures, clips: 0, narrate: true, here: true, draft: true });
    expect(all / 60).toBeLessThanOrEqual(3.25);
    expect(all / 60).toBeGreaterThan(1.5);
    expect(makingWords({ seconds: 15, pictures, clips: 0, narrate: true, here: true, draft: true })).toMatch(/^about [23] minutes/);
  });

  it('says a film whose pictures come from a free service is quick, and does not blame this computer for it', () => {
    const said = makingWords({ seconds: 15, pictures: 7, clips: 0, narrate: true, here: false });
    expect(said).toMatch(/^about [12] minutes?$/);
  });

  it('does not count the listening twice: pictures are drawn while the narration is listened back to', () => {
    const base = { seconds: 30, pictures: 6, clips: 0, here: true };
    const silent = makingSeconds({ ...base, narrate: false }).all;
    const spoken = makingSeconds({ ...base, narrate: true }).all;
    // Only the recording is added; the listening hides behind six pictures.
    expect(spoken - silent).toBeLessThan(30 * 0.3);
  });

  it('reads the founder\'s choice and nothing else as a draft', () => {
    expect(isDraft('draft')).toBe(true);
    for (const other of ['full', 'auto', '', undefined, true]) expect(isDraft(other)).toBe(false);
  });
});
