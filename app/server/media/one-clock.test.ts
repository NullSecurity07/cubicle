import { describe, expect, it } from 'vitest';
import { cuttingFor, editFilm, takesOf } from './editor.ts';
import { settleLength } from './length.ts';
import { countWords, type Scene } from './spec.ts';
import { captionLines, PACE, sceneSeconds, startsOf, type Film, type Shot } from './templates/index.ts';
import { hushPcm, sceneClock, type Word } from './timings.ts';

// The site's hero film, run 2: a storyboard that opened on a title card with nothing said over it. The voice started
// at 0 anyway, so scene 2's captions played under the title, the film ran three seconds behind its own reading, and
// the close's line was said over the picture before it. One clock for the voice, the words, the cut and the captions.
const SCENES: Scene[] = [
  { layout: 'title', heading: 'AI Teammates', text: 'Control your startup with authorized AI' },
  { layout: 'statement', text: 'A small team beside you', say: 'A company of your own, on your own machine.' },
  { layout: 'picture', image_prompt: 'a desk', say: 'Wires are access, so each person reads only what you wire.' },
  { layout: 'cta', text: 'Get it, free, on your own machine', say: 'Get it, free, on your own machine.' },
];

// The one reading of the script, on the recording's own clock: three lines, a breath between each.
function reading(scenes: Scene[]): { words: Word[]; spans: { from: number; to: number }[] } {
  const words: Word[] = [];
  const spans: { from: number; to: number }[] = [];
  let at = 0.05;
  for (const scene of scenes) {
    const line = (scene.say ?? '').split(/\s+/).filter(Boolean);
    spans.push({ from: words.length, to: words.length + line.length });
    for (const word of line) { words.push({ word, at: Math.round(at * 1000) / 1000, seconds: 0.3 }); at += 0.34; }
    if (line.length) at += 0.4;
  }
  return { words, spans };
}

function film(scenes: Scene[]) {
  const pace = 'calm' as const;
  const style = cuttingFor('clean', pace);
  const { words: heard, spans } = reading(scenes);
  const quiet = scenes.map((scene, index) => (spans[index].to > spans[index].from ? 0
    : sceneSeconds([scene.heading, scene.text].filter(Boolean).join(' '), 0, pace)));
  const clocked = sceneClock(heard, spans, quiet, { ...PACE[pace], min: style.min });
  const takes = takesOf(scenes, spans, clocked.words, { lead: PACE[pace].lead, tail: PACE[pace].tail, min: style.min, floor: PACE[pace].floor, least: quiet });
  settleLength(takes, clocked.words, 0);
  const edit = editFilm(takes, clocked.words, style, { sfxOn: false });
  const shots: (Shot & { index: number })[] = edit.shots.map((one) => ({ scene: scenes[one.scene], seconds: one.seconds, take: one.take, index: one.scene }));
  const made: Film = { title: 'Hero', shape: 'wide', look: 'clean', shots, captions: true, words: clocked.words, pace };
  return { heard, spans, quiet, clocked, takes, edit, shots, made };
}

// Which scene is on screen at a moment of the film, counted the way the renderer counts it.
const sceneAt = (shots: (Shot & { index: number })[], at: number): number => {
  const { starts } = startsOf(shots);
  let found = -1;
  starts.forEach((start, order) => { if (at >= start - 0.001) found = shots[order].index; });
  return found;
};

describe('a title card with no line is silent for its own length', () => {
  it('starts the reading on the first scene that says something, a breath after the title has gone', () => {
    const { clocked, takes, quiet } = film(SCENES);
    expect(takes[0].from).toBe(0);
    expect(takes[0].to).toBeGreaterThanOrEqual(quiet[0]);
    // The first word is said after the title, never under it.
    expect(clocked.words[0].at).toBeGreaterThanOrEqual(takes[0].to);
    // The recording is given the title's silence and the breath before the first line, both at its very start.
    expect(clocked.hushes[0].at).toBe(0);
    expect(clocked.hushes[0].seconds).toBeGreaterThanOrEqual(quiet[0]);
  });

  it('puts every caption on the scene whose line is being read, and none on the title', () => {
    const { made, shots, spans } = film(SCENES);
    const lines = captionLines({ ...made, quiet: [] });
    expect(lines.length).toBeGreaterThan(3);
    const whose = (word: Word) => spans.findIndex((span) => made.words!.indexOf(word) >= span.from && made.words!.indexOf(word) < span.to);
    for (const line of lines) {
      for (const word of line.words) {
        const at = made.words!.find((one) => one.at === word.at && one.word === word.word)!;
        expect(sceneAt(shots, word.at)).toBe(whose(at));
      }
      expect(sceneAt(shots, line.at)).not.toBe(0);
    }
  });

  it('ends on the close with its line said over it, not over the picture before it', () => {
    const { made, shots, spans } = film(SCENES);
    const close = spans[3];
    const closing = made.words!.slice(close.from, close.to);
    expect(closing.map((one) => one.word).join(' ')).toBe('Get it, free, on your own machine.');
    for (const word of closing) expect(sceneAt(shots, word.at)).toBe(3);
    // The film runs past the close's last word, and the last shot is the close.
    const { total } = startsOf(shots);
    expect(total).toBeGreaterThan(closing.at(-1)!.at + closing.at(-1)!.seconds);
    expect(shots.at(-1)!.index).toBe(3);
  });

  it('gives a wordless scene in the middle its own silence too, so the line after it is not read under it', () => {
    const scenes: Scene[] = [SCENES[1], { layout: 'picture', image_prompt: 'a lamp', text: 'Your desk' }, SCENES[2], SCENES[3]];
    const { made, shots, spans, takes } = film(scenes);
    const next = made.words![spans[2].from];
    expect(next.at).toBeGreaterThanOrEqual(takes[1].to);
    for (const [index, span] of spans.entries()) {
      for (const word of made.words!.slice(span.from, span.to)) expect(sceneAt(shots, word.at)).toBe(index);
    }
  });

  it('leaves a film whose every scene speaks exactly one breath late, as each scene has always been', () => {
    const { heard, clocked } = film(SCENES.slice(1));
    expect(clocked.hushes).toEqual([{ at: 0, seconds: PACE.calm.lead }]);
    expect(clocked.words.map((one) => one.at)).toEqual(heard.map((one) => Math.round((one.at + PACE.calm.lead) * 1000) / 1000));
    expect(countWords(clocked.words.map((one) => one.word).join(' '))).toBe(heard.length);
  });
});

describe('the recording is given the same silences as its words', () => {
  it('puts each hush into the samples where it belongs', () => {
    const rate = 10;
    const samples = Float32Array.from({ length: 30 }, (_one, at) => at + 1);
    const held = hushPcm({ rate, samples }, [{ at: 0, seconds: 0.5 }, { at: 2, seconds: 0.3 }]);
    expect(held.samples.length).toBe(38);
    expect([...held.samples.slice(0, 5)]).toEqual([0, 0, 0, 0, 0]);
    expect(held.samples[5]).toBe(1);
    // Sample 20 (two seconds in) now comes after the second silence.
    expect([...held.samples.slice(25, 28)]).toEqual([0, 0, 0]);
    expect(held.samples[28]).toBe(21);
    expect(held.samples.at(-1)).toBe(30);
  });
});
