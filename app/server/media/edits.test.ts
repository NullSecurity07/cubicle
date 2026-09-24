import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStore } from '../store.ts';
import { createMedia } from './jobs.ts';
import { fakeVideos } from './video.ts';
import {
  applyEdits, creditsLine, isRecord, notesOf, notesToEdits, parseOp, readPlainly, reuseLine, reuseOf, sceneOf, versionName,
  type FilmRecord,
} from './edits.ts';
import { lineSegments, readPcm, recordOf, silence, joinPcm, slicePcm, wavOfPcm, pcmSeconds } from './film-record.ts';
import { fitTo, reshape } from './remake.ts';
import type { Spec } from './spec.ts';
import type { Word } from './timings.ts';

const SPEC: Spec = {
  title: 'Relay in thirty seconds',
  scenes: [
    { layout: 'hook', text: 'Stop chasing updates', say: 'Stop chasing updates across six tools.' },
    { layout: 'picture', image_prompt: 'a quiet office at dawn', say: 'Relay reads them for you.' },
    { layout: 'statement', text: 'One page a week', say: 'Every Friday you get one page.' },
    { layout: 'stat', heading: '4 hours', text: 'saved a week', say: 'Teams save four hours a week.' },
    { layout: 'cta', text: 'relay.app', say: 'Try it free at relay.app.' },
  ],
};

// A film of five scenes, two seconds a scene, one picture a scene, every line said a third of a second a word.
function film(): FilmRecord {
  const words: Word[] = [];
  let clock = 0;
  const shots = SPEC.scenes.map((scene, index) => {
    const said = scene.say!.split(/\s+/);
    said.forEach((word, at) => words.push({ word, at: clock + 0.3 + at * 0.34, seconds: 0.3 }));
    const seconds = said.length * 0.34 + 0.6;
    clock += seconds;
    return { scene: index, take: 0, seconds, bg: `frame-${index}-0.png` };
  });
  return recordOf({
    title: SPEC.title, spec: SPEC, shape: 'wide', look: 'clean', pace: 'calm', captions: true, sfx: true, music: 'calm', bible: 'calm studio photography',
    shots, narrator: { voice: 'af_heart', file: 'say.wav', seconds: clock }, words,
    pictures: Object.fromEntries(shots.map((one) => [one.bg, { kind: 'drawn' as const, hash: `h${one.scene}`, subject: `subject ${one.scene}` }])),
  });
}

describe('notes read without asking anybody', () => {
  const read = (note: string) => readPlainly(note, 5);
  it('reads the plain asks', () => {
    expect(read('drop shot 3')).toEqual([{ op: 'drop', scene: 3 }]);
    expect(read('Cut the last shot')).toEqual([{ op: 'drop', scene: 5 }]);
    expect(read('trim shot 2 to 4 seconds')).toEqual([{ op: 'trim', scene: 2, seconds: 4 }]);
    expect(read('trim shot 3')).toEqual([{ op: 'trim', scene: 3 }]);
    expect(read('shorten scene two to three seconds')).toEqual([{ op: 'trim', scene: 2, seconds: 3 }]);
    expect(read('swap the picture in shot 5')).toEqual([{ op: 'swap_picture', scene: 5 }]);
    expect(read('swap the picture in shot 5 for the office')).toEqual([{ op: 'swap_picture', scene: 5, prompt: 'the office' }]);
    expect(read('replace the image in shot 2 with media/abc-desk.png')).toEqual([{ op: 'swap_picture', scene: 2, asset: 'media/abc-desk.png' }]);
    expect(read('make it faster')).toEqual([{ op: 'pace', pace: 'punchy' }]);
    expect(read('slower')).toEqual([{ op: 'pace', pace: 'calm' }]);
    expect(read('no music')).toEqual([{ op: 'music', mood: 'none' }]);
    expect(read('captions off')).toEqual([{ op: 'captions', on: false }]);
    expect(read('use the documentary look')).toEqual([{ op: 'look', look: 'documentary' }]);
    expect(read('move shot 4 before shot 2')).toEqual([{ op: 'move', scene: 4, before: 2 }]);
    expect(read('move shot 1 after shot 5')).toEqual([{ op: 'move', scene: 1, before: 'end' }]);
    expect(read('move shot 3 to the end')).toEqual([{ op: 'move', scene: 3, before: 'end' }]);
    expect(read('shot 3 should say "Every Monday, one page."')).toEqual([{ op: 'redo_line', scene: 3, say: 'Every Monday, one page.' }]);
    expect(read('retitle shot 1 "Stop chasing"')).toEqual([{ op: 'retitle', scene: 1, heading: 'Stop chasing' }]);
    expect(read('use the voice Emma')).toEqual([{ op: 'voice', voice: 'bf_emma' }]);
  });
  it('leaves what it cannot read for the model, and never guesses', () => {
    expect(read('say the last line slower')).toBeNull();
    expect(read('make shot 3 feel warmer')).toBeNull();
    expect(read('it needs more energy in the middle')).toBeNull();
  });
  it('splits notes where a founder pauses', () => {
    expect(notesOf('Trim shot 3, swap the picture in shot 5 for the office, say the last line slower'))
      .toEqual(['Trim shot 3', 'swap the picture in shot 5 for the office', 'say the last line slower']);
    expect(notesOf('drop shot 2 and make it faster. No music')).toEqual(['drop shot 2', 'make it faster', 'No music']);
    // A note that opens on a shot is a note of its own, and a quoted line is never cut in half.
    expect(notesOf('swap the picture in shot 1 for a paper boat, shot 3 should say "Friday. One page, then done."'))
      .toEqual(['swap the picture in shot 1 for a paper boat', 'shot 3 should say "Friday. One page, then done."']);
  });
});

describe('notes into edits', () => {
  it('asks nothing when every note is plain', async () => {
    let asked = 0;
    const read = await notesToEdits('drop shot 2, captions off', film(), async () => { asked += 1; return '[]'; });
    expect(asked).toBe(0);
    expect(read.ops).toEqual([{ op: 'drop', scene: 2 }, { op: 'captions', on: false }]);
    expect(read.unread).toEqual([]);
  });
  it('asks ONE small call for the rest, and reads back only the operations', async () => {
    const prompts: string[] = [];
    const read = await notesToEdits('drop shot 2, make shot 4 feel warmer, say the last line slower', film(), async (prompt) => {
      prompts.push(prompt);
      return 'Here: [{"op":"swap_picture","scene":4,"prompt":"a warm kitchen table"},{"op":"unread","note":"say the last line slower"}]';
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('4. stat');
    expect(prompts[0]).not.toContain('drop shot 2');
    expect(read.ops).toEqual([{ op: 'drop', scene: 2 }, { op: 'swap_picture', scene: 4, prompt: 'a warm kitchen table' }]);
    expect(read.unread).toEqual(['say the last line slower']);
  });
  it('says what it could not read, and takes nothing from a model that answered nonsense', async () => {
    const read = await notesToEdits('make it pop', film(), async () => '[{"op":"explode","scene":1}]');
    expect(read.ops).toEqual([]);
    expect(read.unread[0]).toContain('not an edit');
    expect((await notesToEdits('make it pop', film(), async () => 'no idea')).unread).toEqual(['make it pop']);
    expect((await notesToEdits('make it pop', film())).unread).toEqual(['make it pop']);
  });
  it('checks every operation by hand', () => {
    expect(() => parseOp({ op: 'trim', scene: 2, seconds: 0.1 })).toThrow(/between 0.5 and 60/);
    expect(() => parseOp({ op: 'redo_line', scene: 2 })).toThrow(/needs "say"/);
    expect(() => parseOp({ op: 'look', look: 'vaporwave' })).toThrow(/documentary/);
    expect(parseOp({ op: 'captions', on: 'off' })).toEqual({ op: 'captions', on: false });
    expect(parseOp({ op: 'music', mood: 'none' })).toEqual({ op: 'music', mood: 'none' });
  });
});

describe('edits on the storyboard', () => {
  it('names shots as they were watched, by number or by a few of their words', () => {
    expect(sceneOf(3, SPEC.scenes)).toBe(2);
    expect(sceneOf('one page', SPEC.scenes)).toBe(2);
    expect(sceneOf(9, SPEC.scenes)).toMatch(/no shot 9/);
    expect(sceneOf('a week', SPEC.scenes)).toMatch(/shots 3 and 4|shots 4/);
  });
  it('drops, moves, trims and rewrites deterministically', () => {
    const edited = applyEdits(film(), [
      { op: 'drop', scene: 2 }, { op: 'move', scene: 5, before: 1 }, { op: 'trim', scene: 3, seconds: 4 },
      { op: 'redo_line', scene: 4, say: 'Teams save a whole afternoon.' }, { op: 'captions', on: false }, { op: 'drop', scene: 2 },
    ]);
    expect(edited.scenes.map((one) => one.was)).toEqual([4, 0, 2, 3]);
    expect(edited.spec.scenes.map((one) => one.layout)).toEqual(['cta', 'hook', 'statement', 'stat']);
    expect(edited.scenes[2].trim).toBe(4);
    expect(edited.scenes[3].line).toBe(true);
    expect(edited.spec.scenes[3].say).toBe('Teams save a whole afternoon.');
    expect(edited.captions).toBe(false);
    expect(edited.problems).toEqual(['shot 2 is already dropped']);
    expect(edited.done).toHaveLength(5);
  });
  it('never drops the last shot', () => {
    const edited = applyEdits(film(), [1, 2, 3, 4, 5].map((scene) => ({ op: 'drop' as const, scene })));
    expect(edited.scenes).toHaveLength(1);
    expect(edited.problems).toEqual(['a film has to keep one shot']);
  });
});

describe('what an edit keeps', () => {
  it('keeps every picture and line the notes do not touch', () => {
    const record = film();
    const edited = applyEdits(record, [{ op: 'drop', scene: 2 }, { op: 'swap_picture', scene: 4 }, { op: 'redo_line', scene: 5, say: 'Start free today.' }]);
    const reuse = reuseOf(record, edited);
    expect(reuse.pictures).toEqual(['keep', 'keep', 'draw', 'keep']);
    expect(reuse.lines).toEqual(['keep', 'keep', 'keep', 'say']);
    expect(reuseLine(reuse)).toBe('kept 3 of 4 pictures, 3 of 4 lines; drew 1 picture, said 1 line');
  });
  it('draws again what a new look changes, and says again what a new voice reads', () => {
    const record = film();
    const looked = applyEdits(record, [{ op: 'look', look: 'documentary' }]);
    expect(reuseOf(record, looked, 'documentary photography').drawPictures).toBe(5);
    expect(reuseOf(record, applyEdits(record, [{ op: 'pace', pace: 'punchy' }])).drawPictures).toBe(0);
    expect(reuseOf(record, applyEdits(record, [{ op: 'voice', voice: 'bf_emma' }])).sayLines).toBe(5);
    expect(reuseLine(reuseOf(record, applyEdits(record, [{ op: 'captions', on: false }])))).toBe('kept 5 of 5 pictures, 5 of 5 lines; nothing new was drawn or said');
  });
});

describe('the record a film keeps', () => {
  it('is a record, cut where the lines meet', () => {
    const record = film();
    expect(isRecord(record)).toBe(true);
    expect(isRecord({ kind: 'film', spec: SPEC, scenes: [] })).toBe(false);
    const [first, second] = record.scenes;
    expect(first.line!.from).toBe(0);
    expect(second.line!.from).toBeCloseTo(first.line!.to, 3);
    expect(first.line!.words).toHaveLength(6);
    // Each line's own words are on its own clock.
    expect(second.line!.words[0].at).toBeGreaterThan(0);
    expect(second.line!.words[0].at).toBeLessThan(0.5);
  });
  it('gives a scene with nothing said no line', () => {
    const words: Word[] = [{ word: 'Hello', at: 0.2, seconds: 0.3 }, { word: 'there', at: 3.4, seconds: 0.3 }];
    const segments = lineSegments(words, [1, 0, 1], 4);
    expect(segments[1]).toBeUndefined();
    expect(segments[0]!.to).toBeCloseTo((0.5 + 3.4) / 2, 3);
    expect(segments[2]!.to).toBe(4);
  });
  it('names versions as the founder would find them', () => {
    expect(versionName('media/abc-launch.mp4')).toEqual({ stem: 'media/abc-launch-v2', version: 2 });
    expect(versionName('media/abc-launch-v2.mp4')).toEqual({ stem: 'media/abc-launch-v3', version: 3 });
    expect(creditsLine('media/abc-launch.mp4', [{ op: 'drop', scene: 2 }, { op: 'pace', pace: 'punchy' }])).toBe('edited from abc-launch.mp4: shot 2 dropped, cut faster');
  });
});

describe('sound, laid end to end', () => {
  const tone = (seconds: number, rate = 24000) => ({ rate, samples: Float32Array.from({ length: Math.round(seconds * rate) }, (_, at) => Math.sin(at / 9) * 0.5) });
  it('reads back what it writes, and joins pieces at one rate', () => {
    const wav = wavOfPcm(joinPcm([tone(0.5), silence(0.25, 24000), tone(0.25, 16000)], 24000));
    const back = readPcm(wav)!;
    expect(back.rate).toBe(24000);
    expect(pcmSeconds(back)).toBeCloseTo(1, 2);
    expect(pcmSeconds(slicePcm(back, 0.25, 0.5))).toBeCloseTo(0.25, 3);
  });
  it('sets the breath around a line again without touching its words', () => {
    const words: Word[] = [{ word: 'One', at: 0.8, seconds: 0.3 }, { word: 'page', at: 1.2, seconds: 0.3 }];
    const shaped = reshape({ pcm: tone(2.5), words }, 0.2, 0.3);
    expect(shaped.words[0].at).toBeCloseTo(0.2, 3);
    expect(pcmSeconds(shaped.pcm)).toBeCloseTo(0.2 + 0.7 + 0.3, 2);
    // Asked for more breath than the recording has, it is padded with silence.
    expect(pcmSeconds(reshape({ pcm: tone(1.6), words }, 1, 1).pcm)).toBeCloseTo(2.7, 2);
  });
  it('holds a trimmed scene for the seconds asked, and never cuts a line short to do it', () => {
    const words: Word[] = [{ word: 'One', at: 0.8, seconds: 0.3 }, { word: 'page', at: 1.2, seconds: 0.3 }];
    expect(fitTo({ pcm: tone(3), words }, 2).held).toBeCloseTo(2, 2);
    const short = fitTo({ pcm: tone(3), words }, 0.6);
    expect(short.short).toBe(true);
    expect(short.held).toBeGreaterThan(0.7);
    expect(fitTo({ pcm: tone(3), words: [] }, 1.5).held).toBe(1.5);
  });
});

describe('notes on a film on a card', () => {
  const card = { id: 'studio-edit', kind: 'videogen' as const, x: 0, y: 0, w: 1, h: 1 };
  it('saves a v2 beside the film, with its own record, parts and credits, and says what it kept', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'edit-film-'));
    const store = createStore(dir);
    const media = createMedia({ dir, store, makers: { videogen: [fakeVideos] } });
    const first = await media.make(card, { prompt: 'Relay launch' });
    expect(first.film).toBe(first.path.replace(/\.mp4$/, '.film.json'));
    const lines: string[] = [];
    const second = await media.make(card, { prompt: 'drop shot 2', edit: first.path }, { report: (line) => lines.push(line) });
    expect(second.path).toBe(first.path.replace(/\.mp4$/, '-v2.mp4'));
    expect(second.mlt).toBe(first.path.replace(/\.mp4$/, '-v2.mlt'));
    expect(second.edited).toEqual({ from: first.path, root: first.path, version: 2, notes: 'shot 2 dropped' });
    const record = JSON.parse((await store.readFileBytes(second.film!))!.toString('utf8')) as FilmRecord;
    expect(record.spec.scenes).toHaveLength(2);
    expect(lines).toContain('the notes, read: shot 2 dropped');
    expect(lines).toContain('kept 2 of 2 pictures, 2 of 2 lines; nothing new was drawn or said');
    expect((await store.readFileBytes(second.credits!))!.toString('utf8')).toContain(`edited from ${first.path.split('/').pop()}: shot 2 dropped`);
    // The same film noted again is the next version, never the same name twice; a version noted is one more.
    expect((await media.make(card, { prompt: 'captions on', edit: first.path })).path).toMatch(/-v3\.mp4$/);
    expect((await media.make(card, { prompt: 'no music', edit: second.path })).path).toMatch(/-v4\.mp4$/);
  });
  it('says what it could not read and makes nothing, and refuses a film with no record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'edit-film-'));
    const media = createMedia({ dir, store: createStore(dir), makers: { videogen: [fakeVideos] } });
    const first = await media.make(card, { prompt: 'Relay launch' });
    await expect(media.make(card, { prompt: 'make it sing', edit: first.path })).rejects.toThrow(/I could not read: make it sing/);
    await expect(media.make(card, { prompt: 'drop shot 2', edit: 'media/nothing.mp4' })).rejects.toThrow(/no record of what it was made of/);
  });
});
