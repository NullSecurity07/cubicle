import { describe, expect, it } from 'vitest';
import type { Scene } from './spec.ts';
import { alphaOf, FACING, facesLens, fault, filled, isLettered, LETTERED, planes } from './sight.ts';
import { composition, type Shot } from './templates/index.ts';
import { deepSteps, DEPTH } from './templates/layouts.ts';
import { redrawnFor, type Visual } from './visuals.ts';

// A depth map with three real planes in it: a far wall, a table half way, and somebody near. Bright is near.
const room = (far = 30, mid = 120, near = 220): Uint8Array => {
  const map = new Uint8Array(100 * 100).fill(far);
  for (let y = 50; y < 100; y += 1) for (let x = 0; x < 100; x += 1) map[y * 100 + x] = mid;
  for (let y = 30; y < 100; y += 1) for (let x = 35; x < 65; x += 1) map[y * 100 + x] = near;
  return map;
};

describe('where a still is cut', () => {
  it('finds the two cuts between three planes, the same way every time', () => {
    const cuts = planes(room())!;
    expect(cuts.mid).toBeGreaterThan(30);
    expect(cuts.mid).toBeLessThan(120);
    expect(cuts.fore).toBeGreaterThan(120);
    expect(cuts.fore).toBeLessThan(220);
    expect(planes(room())).toEqual(cuts);
  });

  it('refuses a picture with no depth in it, which gets the flat push it always got', () => {
    // A wall photographed square-on is one plane. Cutting it in three and sliding the pieces is a special effect.
    expect(planes(new Uint8Array(10_000).fill(128))).toBeNull();
    expect(planes(room(100, 112, 124))).toBeNull();
    expect(planes(new Uint8Array(0))).toBeNull();
    // A near plane that is one stray highlight, and one that is the whole frame with nothing behind it.
    const sliver = new Uint8Array(10_000).fill(20);
    sliver.fill(130, 5_000);
    sliver.fill(250, 9_990);
    expect(planes(sliver)).toBeNull();
  });

  it('gives a plane a soft edge a few levels deep rather than a staircase', () => {
    const alpha = alphaOf(Uint8Array.from([0, 91, 100, 109, 255]), 100);
    expect([...alpha]).toEqual([0, 0, 128, 255, 255]);
  });

  it('guesses what is behind a plane from what is around it, all the way to the middle', () => {
    // A red subject on a blue wall. What is behind the subject is wall, and none of the subject may be left
    // in it: a far plane that keeps its own copy is a ghost walking a step behind everybody.
    const [wide, high] = [60, 60];
    const rgb = new Uint8Array(wide * high * 3);
    const hole = new Uint8Array(wide * high);
    for (let y = 0; y < high; y += 1) for (let x = 0; x < wide; x += 1) {
      const inside = x >= 15 && x < 45 && y >= 15 && y < 45;
      rgb.set(inside ? [220, 20, 20] : [20, 40, 200], (y * wide + x) * 3);
      hole[y * wide + x] = inside ? 255 : 0;
    }
    const out = filled(rgb, hole, wide, high, 2);
    const at = (x: number, y: number) => [...out.slice((y * wide + x) * 3, (y * wide + x) * 3 + 3)];
    for (const [x, y] of [[16, 16], [30, 30], [44, 30]]) {
      expect(at(x, y)[0], `${x},${y}`).toBeLessThan(40);
      expect(at(x, y)[2], `${x},${y}`).toBeGreaterThan(180);
    }
  });
});

describe('what was seen in a picture', () => {
  it('draws the line in the gap the studio\'s own stills left', () => {
    // The portrait that opened a real reel, two silhouettes in profile, a screen of gibberish.
    expect(facesLens({ facing: 0.56, lettered: 0.32 })).toBe(true);
    expect(facesLens({ facing: 0.31, lettered: 0.89 })).toBe(false);
    expect(isLettered({ facing: 0.31, lettered: 0.89 })).toBe(true);
    expect(isLettered({ facing: 0.56, lettered: 0.32 })).toBe(false);
    expect(FACING).toBeGreaterThan(0.31);
    expect(LETTERED).toBeGreaterThan(0.32);
  });

  it('keeps a picture nothing could look at, and prefers the redraw only when it is better', () => {
    expect(fault(null)).toBe(0);
    expect(fault({ facing: 0.2, lettered: 0.2 })).toBe(0);
    expect(fault({ facing: 0.5, lettered: 0.2 })).toBeLessThan(fault({ facing: 0.7, lettered: 0.2 }));
  });

  it('asks the second time for a place seen from further off, with the people taken out of the words', () => {
    const visual: Visual = { at: 0, scene: 0, take: 0, line: 'a founder waits', subject: 'a founder waiting by a window in an empty office', kind: 'medium', room: 'foot' };
    const face = redrawnFor(visual, { face: true });
    expect(face.kind).toBe('wide');
    expect(face.subject).not.toMatch(/founder/);
    expect(face.subject).toMatch(/window/);
    const writing = redrawnFor({ ...visual, kind: 'wide' }, { face: false });
    expect(writing.kind).toBe('environment');
    expect(writing.subject).toBe(visual.subject);
  });
});

describe('a camera moving through a still', () => {
  const scene = (one: Partial<Scene> & { layout: Scene['layout'] }): Scene => one as Scene;
  const plies = { back: 'frame-0-0.back.webp', mid: 'frame-0-0.mid.webp', fore: 'frame-0-0.fore.webp' };
  const shots: Shot[] = [
    { scene: scene({ layout: 'statement', text: 'The quiet cost of waiting' }), seconds: 5, bg: 'frame-0-0.png', plies },
    { scene: scene({ layout: 'picture', text: 'A year later' }), seconds: 4, image: 'frame-1-0.png', plies, punch: { to: 1.06, at: 1, seconds: 0.3 } },
    { scene: scene({ layout: 'statement', text: 'Nothing had moved' }), seconds: 4, bg: 'frame-2-0.png' },
  ];

  it('stacks the three planes where the whole picture was, and moves the near one furthest', () => {
    const page = composition({ title: 'One', shape: 'wide', look: 'documentary', shots });
    for (const ply of ['back', 'mid', 'fore']) {
      expect(page).toContain(`<img class="ply ply--${ply}" src="assets/frame-0-0.${ply}.webp"`);
      expect(page).toContain(`"#bg0 .ply--${ply}"`);
      expect(page).toContain(`"#s1 .shot .ply--${ply}"`);
    }
    // The whole picture is not drawn under its own planes, and nothing pushes in on a plane a second time.
    expect(page).not.toContain('src="assets/frame-0-0.png"');
    expect(page).not.toContain('"#bg0 img"');
    expect(page).not.toContain('"#s1 .shot img"');
    // A still that could not be cut keeps the flat push it always had.
    expect(page).toContain('src="assets/frame-2-0.png"');
    expect(page).toContain('"#bg2 img"');
    // A punch-in is a move of the camera, so it moves the stack and never one plane.
    expect(page).toContain('#g1 .deep');
    expect(page).not.toMatch(/#g1 \.bg img/);
  });

  it('keeps to the research: a push of four to eight per cent, the far plane a quarter to two fifths as far', () => {
    expect(DEPTH.fore.push).toBeGreaterThanOrEqual(0.04);
    expect(DEPTH.fore.push).toBeLessThanOrEqual(0.08);
    for (const what of ['push', 'drift'] as const) {
      expect(DEPTH.back[what] / DEPTH.fore[what]).toBeGreaterThanOrEqual(0.25);
      expect(DEPTH.back[what] / DEPTH.fore[what]).toBeLessThanOrEqual(0.4);
      expect(DEPTH.mid[what]).toBeGreaterThan(DEPTH.back[what]);
      expect(DEPTH.mid[what]).toBeLessThan(DEPTH.fore[what]);
    }
    // A short shot gets a shorter move rather than a faster one, and a camera on a slider does not ease.
    const long = deepSteps(shots[0], 0, '#bg0', 0, 0.5).join('\n');
    const short = deepSteps({ ...shots[0], seconds: 2 }, 0, '#bg0', 0, 0.5).join('\n');
    const pushed = (steps: string) => Number(/ply--fore", \{ scale: 1\.035[^}]*\}, \{ scale: ([\d.]+)/.exec(steps)![1]);
    expect(pushed(short)).toBeLessThan(pushed(long));
    expect(long).not.toMatch(/ease: "(?!none)/);
  });

  it('is the long-form look\'s and nobody else\'s', () => {
    const page = composition({ title: 'One', shape: 'wide', look: 'editorial', shots });
    expect(page).not.toContain('class="ply');
    expect(page).toContain('src="assets/frame-0-0.png"');
  });
});

describe('a headline that fits the room it has', () => {
  const scene = (one: Partial<Scene> & { layout: Scene['layout'] }): Scene => one as Scene;
  const sizeOf = (page: string, cls: string) => Number(new RegExp(`class="${cls} rise"[^>]* style="font-size: (\\d+)px"`).exec(page)?.[1] ?? 0);

  it('starts at nine per cent and steps down only as far as it must, never under the floor every look answers to', () => {
    // A tall frame has about five hundred and fifty pixels to write in once a phone's own top and bottom are kept
    // clear. A six-word heading over three bullets, in a heavy serif at nine per cent, came out taller than that
    // and was cut off by the top of the frame.
    const long: Shot[] = [{ scene: scene({ layout: 'bullets', heading: 'What the delay really costs', bullets: ['Twelve months of runway', 'The first ten customers', 'The team that believed you'] }), seconds: 5 }];
    const tall = composition({ title: 'One', shape: 'tall', look: 'documentary', shots: long });
    const floor = Math.round(1280 * (1 - 2 * 0.055) * 0.06);
    expect(sizeOf(tall, 'heading')).toBeGreaterThanOrEqual(floor);
    expect(sizeOf(tall, 'heading')).toBeLessThan(Math.round(1280 * (1 - 2 * 0.055) * 0.09));
    // The same words on a wide frame have the room, so they stay where the look asked for them.
    expect(composition({ title: 'One', shape: 'wide', look: 'documentary', shots: long })).not.toMatch(/class="heading rise"[^>]* style="font-size/);
    // A short line keeps its nine per cent on a tall frame too.
    const short: Shot[] = [{ scene: scene({ layout: 'statement', text: 'It just happens.' }), seconds: 4 }];
    expect(composition({ title: 'One', shape: 'tall', look: 'documentary', shots: short })).not.toMatch(/class="display rise"[^>]* style="font-size/);
    // …and a look that never asked for more than the floor is never touched.
    expect(composition({ title: 'One', shape: 'tall', look: 'editorial', shots: long })).not.toMatch(/class="heading rise"[^>]* style="font-size/);
  });
});
