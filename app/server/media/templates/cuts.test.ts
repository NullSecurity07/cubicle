import { describe, expect, it } from 'vitest';
import type { Scene } from '../spec.ts';
import { actBreaks, composition, PACK, type Shot } from './index.ts';

const shot = (layout: Scene['layout'], seconds = 3, more: Partial<Shot> = {}): Shot => ({ scene: { layout, text: 'A line.', heading: 'A line' } as Scene, seconds, ...more });
const reel = ['hook', 'statement', 'picture', 'statement', 'cta'] as const;

describe('where a film\'s acts break', () => {
  it('a short reel has one, and it is the turn into the close', () => {
    expect([...actBreaks(reel.map((one) => shot(one)))]).toEqual([4]);
  });
  it('a longer film has the end of its opening and its chapter cards too, never two within ten seconds', () => {
    const long = ['title', 'hook', 'statement', 'picture', 'statement', 'title', 'statement', 'picture', 'statement', 'cta', 'outro'] as const;
    // Starts: the body at 8 s, the chapter card at 20 s, the close at 36 s.
    expect([...actBreaks(long.map((one) => shot(one, 4)))].sort((a, b) => a - b)).toEqual([2, 5, 9]);
    // The same film cut twice as fast: the chapter card is now six seconds after the opening, and gives way to it.
    expect([...actBreaks(long.map((one) => shot(one, 2)))].sort((a, b) => a - b)).toEqual([2, 9]);
  });
  it('the closing run breaks once, on its first scene', () => {
    expect([...actBreaks([shot('hook'), shot('statement', 8), shot('cta'), shot('logo'), shot('outro')])]).toEqual([2]);
  });
  it('a picture change inside one scene is not a break, and a film of two scenes has none', () => {
    // …so the break goes to the next place that earns one: the end of the opening.
    expect([...actBreaks([shot('hook'), shot('statement', 9), shot('cta', 3, { take: 1 })])]).toEqual([1]);
    expect(actBreaks([shot('hook'), shot('cta')]).size).toBe(0);
    expect(actBreaks([shot('statement'), shot('statement'), shot('statement')]).size).toBe(0);
  });
});

describe('the cuts of a film whose pack has a break transition', () => {
  const film = (look: 'creator' | 'neon' | 'clean', shots = reel.map((one) => shot(one))) => composition({ title: 'One', shape: 'tall', look, shots });

  it('cuts hard through the body and makes the pack\'s move at the break, once', () => {
    for (const look of ['creator', 'neon', 'clean', 'brand'] as const) expect(PACK[look].cuts).toEqual(['cut']);
    const page = film('creator');
    // The body: the match cut, a twentieth of scale over a tenth of a second.
    for (const index of [1, 2, 3]) expect(page).toContain(`tl.fromTo("#g${index}", { scale: 1.05 }, { scale: 1, duration: 0.10`);
    // The break: both scenes travel one frame under a sideways blur, and the scene arriving wrote both halves.
    expect(page).toContain('<filter id="regwhip"');
    expect(page).toContain('tl.fromTo("#g4", { xPercent: 100 }, { xPercent: 0, duration: 0.3, ease: "power1.inOut" }, 12.000);');
    expect(page).toContain('tl.fromTo("#g3", { xPercent: 0 }, { xPercent: -100, duration: 0.3, ease: "power1.inOut" }, 12.000);');
    expect(page).not.toContain('tl.fromTo("#g4", { scale: 1.05 }');
    // The scene leaving on the break makes no move of its own, and is held exactly as long as the break takes.
    expect(page).not.toMatch(/tl\.to\("#g3", \{ opacity: 0, duration: 0\.06/);
    expect(page).toContain('id="s3" data-start="9" data-duration="3.3"');
    expect(page.match(/id="regwhip"/g)).toHaveLength(1);
  });
  it('neon pushes through with the registry\'s light sweep and strobe; clean dips through white', () => {
    const neon = film('neon');
    expect(neon).toContain('<div class="reg-zt" id="regzt"');
    expect(neon).toContain('tl.fromTo("#g4", { clipPath: "inset(0% 100% 0% 0%)", x: 60, scale: 1.04 }');
    expect(neon).toContain('id="s3" data-start="9" data-duration="3.5"');
    const clean = film('clean');
    expect(clean).toContain('<div class="reg-flash" id="regflash"');
    // White is rising over the scene that is leaving, full on the cut, and falling over the one that arrived.
    expect(clean).toContain('tl.fromTo("#regflash", { opacity: 0 }, { opacity: 1, duration: 0.225, ease: "sine.inOut" }, 11.750);');
    expect(clean).toContain('tl.to("#regflash", { opacity: 0, duration: 0.250, ease: "sine.inOut" }, 12.000);');
  });
  it('a moving picture on either side of a break is cut to, not whipped — but white goes over anything', () => {
    const moving = reel.map((one, index) => shot(one, 3, index === 3 ? { video: 'clip-3.mp4' } : {}));
    expect(film('creator', moving)).not.toContain('regwhip');
    expect(film('creator', moving)).toContain('tl.fromTo("#g4", { scale: 1.05 }');
    expect(film('clean', moving)).toContain('id="regflash"');
  });
  it('the packs without one cut as they always have', () => {
    const page = composition({ title: 'One', shape: 'wide', look: 'editorial', shots: reel.map((one) => shot(one)) });
    expect(page).not.toMatch(/regwhip|regzt|regflash/);
    expect(page).toContain('clipPath: "inset(0% 0% 0% 100%)"');
  });
});
