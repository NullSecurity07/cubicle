import { describe, expect, it } from 'vitest';
import {
  cover, dealMoves, dealShots, fits, lensOf, lensPhrase, MOVE_NAMES, MOVES, moveOf, motionMoves, registerOf, settle, sizeOf,
  stillMoves, stillOf, zooms,
} from './moves.ts';
import { fallbackOf, parseSpec, type Scene } from './spec.ts';
import { composition, type Shot } from './templates/index.ts';

const picture = (extra: Partial<Scene> = {}): Scene => ({ layout: 'picture', image_prompt: 'a kettle on a hob', ...extra });
const words = (extra: Partial<Scene> = {}): Scene => ({ layout: 'statement', text: 'A line.', ...extra });
const moves = (scenes: Scene[]) => scenes.map((one) => one.move);

describe('the table', () => {
  it('has every move once, each with a kind, a register and a clause a clip model can read', () => {
    expect(Object.keys(MOVES).sort()).toEqual([...MOVE_NAMES].sort());
    expect(MOVE_NAMES).toHaveLength(21);
    for (const move of Object.values(MOVES)) {
      expect(['still', 'motion']).toContain(move.kind);
      expect(['calm', 'steady', 'brisk']).toContain(move.energy);
      expect(move.wan.split(' ').length, move.name).toBeGreaterThan(3);
      expect(move.wan, move.name).not.toMatch(/[,.]$/);
    }
    expect(stillMoves.length + motionMoves.length).toBe(21);
    expect(motionMoves.map((one) => one.name).sort()).toEqual(['crane up', 'drone pull back', 'handheld', 'orbit', 'tracking']);
  });

  it('draws nothing for a still camera or for a move only a clip can make', () => {
    expect(MOVES.static.css(4)).toBeNull();
    for (const move of motionMoves) expect(move.css(4), move.name).toBeNull();
    for (const move of stillMoves.filter((one) => one.name !== 'static')) expect(move.css(4), move.name).not.toBeNull();
  });

  it('never slides a picture so far that its edge comes into the frame, at any length of shot', () => {
    for (const move of stillMoves) {
      for (const seconds of [1, 2, 3.5, 5, 8]) {
        const recipe = move.css(seconds);
        if (!recipe) continue;
        for (const frame of recipe.frames) {
          expect(frame.scale, `${move.name} over ${seconds}s`).toBeGreaterThanOrEqual(cover(frame.x, frame.y) - 0.0001);
          expect(frame.at).toBeGreaterThanOrEqual(0);
          expect(frame.at).toBeLessThanOrEqual(1);
        }
        expect(recipe.frames[0].at).toBe(0);
        expect(recipe.frames.at(-1)!.at).toBe(1);
      }
    }
  });

  it('moves a short shot less far rather than faster', () => {
    const long = Math.abs(MOVES['truck right'].css(5)!.frames.at(-1)!.x);
    const short = Math.abs(MOVES['truck right'].css(1.5)!.frames.at(-1)!.x);
    expect(short).toBeLessThan(long);
    expect(MOVES['push in'].css(1.5)!.frames.at(-1)!.scale).toBeLessThan(MOVES['push in'].css(6)!.frames.at(-1)!.scale);
  });

  it('slides the picture the opposite way to the camera', () => {
    const left = MOVES['pan left'].css(5)!.frames;
    expect(left.at(-1)!.x).toBeGreaterThan(left[0].x);
    const up = MOVES['tilt up'].css(5)!.frames;
    expect(up.at(-1)!.y).toBeGreaterThan(up[0].y);
  });

  it('reads the names a model really writes', () => {
    expect(moveOf('Push-In')?.name).toBe('push in');
    expect(moveOf('dolly out')?.name).toBe('pull out');
    expect(moveOf('Ken Burns')?.name).toBe('push in');
    expect(moveOf('crash zoom')?.name).toBe('crash zoom in');
    expect(moveOf('a dramatic swoop')).toBeUndefined();
    expect(moveOf('')).toBeUndefined();
    expect(moveOf(42)).toBeUndefined();
  });

  it('turns every move a still cannot make into the nearest one it can', () => {
    expect(stillOf('orbit')?.name).toBe('parallax arc');
    expect(stillOf('tracking')?.name).toMatch(/^truck /);
    expect(stillOf('drone pull back')?.name).toBe('pull out');
    expect(stillOf('crane up')?.name).toBe('pedestal up');
    expect(stillOf('handheld')?.name).toBe('static');
    expect(stillOf('pan left')?.name).toBe('pan left');
  });
});

describe('the shot', () => {
  it('reads sizes and lenses as loosely as they can honestly be read', () => {
    expect(sizeOf('close-up')).toBe('cu');
    expect(sizeOf('ECU')).toBe('ecu');
    expect(sizeOf('medium close-up')).toBe('mcu');
    expect(sizeOf('establishing')).toBe('ews');
    expect(sizeOf('portrait')).toBeUndefined();
    expect(lensOf('85mm')).toBe(85);
    expect(lensOf(28)).toBe(24);
    expect(lensOf(100)).toBe(85);
    expect(lensOf('a long one')).toBeUndefined();
    expect(lensOf(4000)).toBeUndefined();
  });

  it('says a lens as focus and distance, never as anybody', () => {
    expect(lensPhrase(85)).toBe('shallow depth of field, compressed background');
    expect(lensPhrase(135)).toBe(lensPhrase(85));
    expect(lensPhrase(24)).toBe('wide view, deep focus');
    expect(lensPhrase(35)).toBe(lensPhrase(24));
    expect(lensPhrase(50)).toBe('');
    expect(lensPhrase()).toBe('');
  });

  it('deals a size and a lens to every picture and clip scene that has none, and keeps one that was given', () => {
    const dealt = dealShots([picture(), words(), picture({ shot: 'ecu', lens: 135 }), { layout: 'clip', clip_prompt: 'rain' }, picture()]);
    expect(dealt[1].shot).toBeUndefined();
    expect(dealt[2]).toMatchObject({ shot: 'ecu', lens: 135 });
    for (const at of [0, 3, 4]) expect(dealt[at].shot && dealt[at].lens, `scene ${at + 1}`).toBeTruthy();
    const sizes = dealShots(Array.from({ length: 8 }, () => picture())).map((one) => one.shot);
    for (let at = 1; at < sizes.length; at += 1) expect(sizes[at]).not.toBe(sizes[at - 1]);
  });
});

describe('dealing the moves', () => {
  const film = (many: number): Scene[] => Array.from({ length: many }, (_one, at) => (at % 3 === 2 ? words() : picture()));

  it('gives every picture a still move, every clip a move a clip can make, and nothing else a move at all', () => {
    const dealt = dealMoves([picture(), words(), { layout: 'clip', clip_prompt: 'a kettle boiling' }, picture(), picture(), words()], 'calm', 'clean');
    expect(dealt[1].move).toBeUndefined();
    expect(dealt[5].move).toBeUndefined();
    for (const at of [0, 3, 4]) expect(moveOf(dealt[at].move)?.kind).toBe('still');
    expect(fits(dealt[2].move, 'clip')).toBe(true);
  });

  it('is the same deal every time', () => {
    expect(moves(dealMoves(film(9), 'punchy', 'creator'))).toEqual(moves(dealMoves(film(9), 'punchy', 'creator')));
  });

  it('never makes the same move on two neighbours', () => {
    for (const look of ['documentary', 'creator', 'clean', 'neon'] as const) {
      const dealt = dealMoves(Array.from({ length: 12 }, () => picture()), 'punchy', look);
      for (let at = 1; at < dealt.length; at += 1) expect(dealt[at].move, `${look} ${at}`).not.toBe(dealt[at - 1].move);
    }
  });

  it('keeps the quiet looks quiet and lets the feed looks move fast', () => {
    const calm = dealMoves(Array.from({ length: 10 }, () => picture()), 'punchy', 'documentary').slice(0, -2);
    for (const one of calm) expect(['calm', 'steady']).toContain(moveOf(one.move)!.energy);
    const quick = dealMoves(Array.from({ length: 10 }, () => picture()), 'punchy', 'creator').slice(0, -2);
    expect(quick.some((one) => moveOf(one.move)!.energy === 'brisk')).toBe(true);
    for (const one of quick) expect(moveOf(one.move)!.energy).not.toBe('calm');
    expect(registerOf('calm', 'editorial')).toBe('calm');
    expect(registerOf('calm', 'neon')).toBe('brisk');
    expect(registerOf('punchy', 'clean')).toBe('steady');
  });

  it('holds the payoff and the close on a slow push or stands still', () => {
    const dealt = dealMoves(Array.from({ length: 6 }, () => picture()), 'punchy', 'creator');
    expect(['push in', 'static']).toContain(dealt[4].move);
    expect(['push in', 'static']).toContain(dealt[5].move);
    expect(dealt[5].move).not.toBe(dealt[4].move);
  });

  it('gives a scene the editor punches into no move that zooms', () => {
    const dealt = dealMoves(Array.from({ length: 8 }, () => picture()), 'punchy', 'creator', { punched: new Set([0, 1, 2, 3, 4, 5, 6, 7]) });
    for (const one of dealt) expect(zooms(moveOf(one.move)!), one.move).toBe(false);
  });

  it('keeps a move the storyboard chose', () => {
    const dealt = dealMoves([picture({ move: 'tilt down' }), picture(), picture({ move: 'whip pan' })], 'calm', 'documentary');
    expect(dealt[0].move).toBe('tilt down');
    expect(dealt[2].move).toBe('whip pan');
    expect(dealt[1].move).not.toBe('tilt down');
  });
});

describe('what one shot really plays', () => {
  it('turns the move round on the second shot of a scene and keeps a punch-in free of a second zoom', () => {
    expect(settle('pan left', { take: 1 })?.name).toBe('pan right');
    expect(settle('pan left', { take: 2 })?.name).toBe('pan left');
    expect(settle('push in', { punched: true })?.name).toBe('static');
    expect(settle('push past', { punched: true })?.name).toBe('truck left');
    expect(settle('truck right', { punched: true })?.name).toBe('truck right');
    expect(settle('orbit')?.name).toBe('parallax arc');
    expect(settle('nonsense')).toBeUndefined();
  });
});

describe('the move on the page', () => {
  const shot = (scene: Scene, extra: Partial<Shot> = {}): Shot => ({ scene, seconds: 4, image: 'shot-0.png', ...extra });
  const page = (shots: Shot[]) => composition({ title: 'Moves', shape: 'wide', look: 'clean', pace: 'calm', shots });

  it('puts a moving picture in a box of its own and moves the box on the film\'s clock', () => {
    const made = page([shot(picture({ move: 'truck right' }))]);
    expect(made).toContain('<div class="cam" id="cam0" data-layout-allow-overflow><img src="assets/shot-0.png"');
    // A truck right over four seconds and the overlap: the picture slides from right to left, never showing its edge.
    expect(made).toContain('tl.fromTo("#cam0", { xPercent: 3.2, yPercent: 0, scale: 1.074, rotation: 0 }, { xPercent: -3.2, yPercent: 0, scale: 1.074, rotation: 0, duration: 4.420, ease: "none" }, 0.000);');
    // A slide keeps the look's own slow push inside the box.
    expect(made).toContain('tl.fromTo("#s0 .shot img", { scale: 1 }, { scale: 1.09');
    expect(made).toContain('.cam { position: absolute; inset: 0;');
  });

  it('lets a zoom be the push rather than a second one on top of it', () => {
    const made = page([shot(picture({ move: 'push in' }))]);
    expect(made).toContain('#cam0');
    expect(made).not.toContain('tl.fromTo("#s0 .shot img", { scale: 1 }');
  });

  it('writes nothing new for a still camera, so a static shot is the shot the look always made', () => {
    const still = page([shot(picture({ move: 'static' }))]);
    const none = page([shot(picture())]);
    expect(still).toBe(none);
    expect(still).not.toContain('class="cam"');
  });

  it('keeps the editor\'s punch-in and lets it reach the picture inside the box', () => {
    const made = page([shot(picture({ move: 'slow zoom in' }), { punch: { to: 1.12, at: 1, seconds: 0.3 } })]);
    // The zoom gave way to the punch-in, so nothing moves the box at all.
    expect(made).not.toContain('#cam0');
    const slid = page([shot(picture({ move: 'pan right' }), { punch: { to: 1.12, at: 1, seconds: 0.3 } })]);
    expect(slid).toContain('#cam0');
    expect(slid).toContain('#g0 .cam > img');
  });

  it('plays the steps of a move in order, the snap first and the creep after it', () => {
    const made = page([shot(picture({ move: 'crash zoom in' }), { seconds: 3 })]);
    const steps = made.split('\n').filter((line) => line.includes('#cam0'));
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain('ease: "power4.out"');
    expect(steps[1]).toContain('tl.to("#cam0"');
  });

  it('moves only a still picture: a background behind words keeps its drift', () => {
    const made = page([shot(words({ move: 'truck left' }), { image: undefined, bg: 'bg-0.png' })]);
    expect(made).not.toContain('cam0');
  });
});

describe('the shot on the storyboard', () => {
  const read = (scene: Record<string, unknown>) => parseSpec({ title: 'One', scenes: [{ layout: 'picture', image_prompt: 'a kettle', ...scene }] }).scenes[0];

  it('takes a size, a lens and a move as a model writes them', () => {
    expect(read({ shot: 'close-up', lens: '85mm', move: 'Push-In' })).toMatchObject({ shot: 'cu', lens: 85, move: 'push in' });
    expect(read({ shot: 'ews', lens: 24, move: 'orbit' })).toMatchObject({ shot: 'ews', lens: 24, move: 'orbit' });
  });

  it('leaves out a size or a lens that is none of ours, and keeps an unknown move for the critic to deal with', () => {
    const scene = read({ shot: 'heroic', lens: 'fisheye', move: 'Dramatic swoop!' });
    expect(scene.shot).toBeUndefined();
    expect(scene.lens).toBeUndefined();
    expect(scene.move).toBe('dramatic swoop');
    expect(read({ move: '' }).move).toBeUndefined();
  });

  it('keeps how a clip was framed when it has to become a picture, with a move a still can make', () => {
    const fell = fallbackOf({ layout: 'clip', clip_prompt: 'rain on a window', shot: 'cu', lens: 85, move: 'tracking' });
    expect(fell).toMatchObject({ layout: 'picture', shot: 'cu', lens: 85, move: 'truck right' });
    expect(fallbackOf({ layout: 'clip', clip_prompt: 'rain' }).move).toBeUndefined();
  });
});
