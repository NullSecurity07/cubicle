import { describe, expect, it } from 'vitest';
import { CUTTING, cuttingFor, editFilm, keywordOf, whenSaid, type Take } from './editor.ts';
import type { Word } from './timings.ts';

// One second of narration a word, with a breath every four: enough to have real phrase boundaries to land on.
const saying = (text: string, from = 0): Word[] => {
  const words = text.split(/\s+/).filter(Boolean);
  let at = from;
  return words.map((word) => {
    const one = { word, at: Math.round(at * 1000) / 1000, seconds: 0.4 };
    at += 0.4 + (/[.!?]$/.test(word) ? 0.3 : 0.02);
    return one;
  });
};

const take = (index: number, from: number, to: number, over: Partial<Take> = {}): Take => ({
  scene: { layout: 'statement', text: `Line ${index}`, say: `Line ${index}.` }, index, from, to, ...over,
});

describe('the shot list the editor draws', () => {
  const script = 'Investors never fund an idea they fund evidence. Show them one number that moved. '
    + 'Traction beats a beautiful deck every single time. Send them the number today.';
  const words = saying(script);
  const spoken = words.at(-1)!.at + words.at(-1)!.seconds;
  const takes = [
    take(0, 0, spoken * 0.3, { scene: { layout: 'hook', text: 'Investors never fund an idea', say: 'Investors never fund an idea they fund evidence.' } }),
    take(1, spoken * 0.3, spoken * 0.6),
    take(2, spoken * 0.6, spoken * 0.85),
    take(3, spoken * 0.85, spoken, { scene: { layout: 'cta', text: 'Send the number', say: 'Send them the number today.' } }),
  ];
  const style = cuttingFor('creator', 'punchy');
  const edit = editFilm(takes, words, style);

  it('never holds a shot under the floor, and never holds a still one past three seconds', () => {
    expect(edit.shots.length).toBeGreaterThan(takes.length);
    for (const shot of edit.shots) {
      expect(shot.seconds, `shot on scene ${shot.scene}`).toBeGreaterThanOrEqual(style.min - 0.001);
      // A shot can only run past the ceiling where the sentence under it could not be cut without landing inside a
      // thought — and then it is not allowed to be still.
      if (shot.seconds > 3) expect(shot.punch, `a ${shot.seconds}s shot with nothing moving in it`).toBeDefined();
    }
  });

  it('changes picture at the rate the style asks for, tightening its own mean until it does', () => {
    const [least, most] = style.changes;
    // Within a tick of the floor: the one long hold the film is allowed on its payoff pulls the average down on
    // purpose, and that hold is what stops the rhythm being metronomic.
    expect(edit.changesPer10s).toBeGreaterThan(least - 0.5);
    expect(edit.changesPer10s).toBeLessThanOrEqual(most + 2);
    // Every shot but that hold is inside the length the style asks for.
    const body = edit.shots.filter((one) => one.scene !== 2);
    for (const shot of body) expect(shot.seconds, `a ${shot.seconds}s shot`).toBeLessThanOrEqual(style.max);
    // A quiet film is allowed to be quiet: the same narration in the editorial look changes picture far less.
    const quiet = editFilm(takes, words, cuttingFor('editorial', 'calm'));
    expect(quiet.changesPer10s).toBeLessThan(edit.changesPer10s);
  });

  it('runs end to end with no gap and no overlap', () => {
    let clock = 0;
    for (const shot of edit.shots) {
      expect(shot.at).toBeCloseTo(clock, 2);
      clock = Math.round((clock + shot.seconds) * 1000) / 1000;
    }
    expect(edit.total).toBeCloseTo(clock, 2);
  });

  it('cuts where the speaker stops rather than on a grid', () => {
    // Every cut inside a scene should sit on or beside the end of a word, never in the middle of one.
    const inside = edit.shots.filter((one) => one.take > 0);
    expect(inside.length).toBeGreaterThan(0);
    for (const shot of inside) {
      const mid = words.find((word) => shot.at > word.at + 0.02 && shot.at < word.at + word.seconds - 0.02);
      expect(mid, `cut at ${shot.at} landed inside "${mid?.word}"`).toBeUndefined();
    }
  });

  it('edits the same film the same way twice', () => {
    expect(editFilm(takes, words, style)).toEqual(edit);
  });

  it('leaves a moving shot whole and never pushes into it', () => {
    const moving = [take(0, 0, 8, { moving: true, scene: { layout: 'clip', clip_prompt: 'a kite', say: 'A kite over a field in the long grass.' } })];
    const made = editFilm(moving, saying('A kite over a field in the long grass.'), style);
    expect(made.shots).toHaveLength(1);
    expect(made.shots[0].punch).toBeUndefined();
  });
});

describe('what moves, and why', () => {
  const words = saying('Traction beats a beautiful deck every single time.');
  const style = cuttingFor('creator', 'punchy');

  it('pushes in on the word the line turns on, not at an interval', () => {
    const one = [take(0, 0, words.at(-1)!.at + 0.4, { scene: { layout: 'statement', text: 'Traction wins', emphasis: 'Traction', say: 'Traction beats a beautiful deck every single time.' } })];
    const made = editFilm(one, words, style);
    const pushed = made.shots.filter((shot) => shot.punch);
    expect(pushed.length).toBeGreaterThan(0);
    // The push starts where the word is said, give or take the frame before it.
    const said = whenSaid(words, 'Traction')!;
    expect(pushed[0].punch!.at).toBeGreaterThanOrEqual(said - 0.1);
    expect(pushed[0].punch!.to).toBeLessThanOrEqual(style.punch[1]);
    expect(pushed[0].punch!.to).toBeGreaterThan(1);
  });

  it('never leaves a frame static past three seconds', () => {
    const held = [take(0, 0, 0, { least: 5.5, scene: { layout: 'picture', image_prompt: 'a kite' } })];
    const made = editFilm(held, [], cuttingFor('editorial', 'calm'));
    for (const shot of made.shots) if (shot.seconds > 3) expect(shot.punch, `a ${shot.seconds}s shot with nothing moving`).toBeDefined();
  });

  it('never pushes two shots in a row', () => {
    const script = 'Investors never fund an idea they fund evidence. Show them one number that moved. Traction beats a deck.';
    const said = saying(script);
    const made = editFilm([take(0, 0, said.at(-1)!.at + 0.4)], said, style);
    const pushed = made.shots.map((shot) => !!shot.punch);
    for (let at = 1; at < pushed.length; at += 1) expect(pushed[at] && pushed[at - 1]).toBe(false);
  });

  it('reads the word the line turns on, and takes the founder\'s word for it where there is one', () => {
    expect(keywordOf('Investors want evidence', undefined)).toBe('investors');
    expect(keywordOf('Investors want evidence', 'evidence')).toBe('evidence');
    expect(keywordOf('It is the that', undefined)).toBeUndefined();
  });
});

describe('sound, and how little of it there is', () => {
  const words = saying('Investors never fund an idea. They fund evidence. Show them one number. Send it today. That is the whole of it.');
  const many = Array.from({ length: 9 }, (_one, index) => take(index, index * 2.2, index * 2.2 + 2.0, {
    scene: { layout: index === 0 ? 'hook' : index === 8 ? 'cta' : index % 2 ? 'stat' : 'statement', text: `L${index}`, heading: '3x' },
  }));

  it('caps a film at five sounds and puts each on a cut', () => {
    const made = editFilm(many, words, cuttingFor('creator', 'punchy'));
    expect(made.cues.length).toBeLessThanOrEqual(CUTTING.creator.sfx);
    const cuts = new Set(made.shots.map((one) => one.at));
    for (const cue of made.cues) expect(cuts.has(cue.at), `a sound at ${cue.at} that is not on a cut`).toBe(true);
    // In order, and never the same moment twice.
    expect(made.cues.map((one) => one.at)).toEqual([...made.cues.map((one) => one.at)].sort((a, b) => a - b));
  });

  it('makes no sound at all when the founder turned it off', () => {
    expect(editFilm(many, words, cuttingFor('creator', 'punchy'), { sfxOn: false }).cues).toEqual([]);
  });

  it('tells the bed to get out of the way wherever somebody is speaking', () => {
    const made = editFilm(many, words, cuttingFor('creator', 'punchy'));
    expect(made.ducks).toHaveLength(many.length);
    for (const duck of made.ducks) {
      expect(duck.db).toBeGreaterThanOrEqual(18);
      expect(duck.db).toBeLessThanOrEqual(25);
    }
  });
});

describe('the table each look cuts to', () => {
  it('gives the reel the fast end and the quiet one room', () => {
    expect(CUTTING.creator.changes[1]).toBeGreaterThan(CUTTING.editorial.changes[1]);
    expect(CUTTING.editorial.mean).toBeGreaterThan(CUTTING.creator.mean);
    // Nothing anywhere cuts under the 1.2 seconds a viewer needs to process a shot.
    for (const style of Object.values(CUTTING)) expect(style.min).toBeGreaterThanOrEqual(1.2);
    // A look nobody wrote a row for still cuts like something.
    expect(cuttingFor('nothing-like-this', 'calm')).toEqual(CUTTING.clean);
    // The long-form look holds longest of the lot.
    expect(CUTTING.documentary.mean).toBeGreaterThanOrEqual(CUTTING.editorial.mean);
  });
});
