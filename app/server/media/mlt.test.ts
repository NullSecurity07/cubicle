import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStore } from '../store.ts';
import { createMedia } from './jobs.ts';
import { colourOf, framesOf, mltOf, xml, type EditFilm } from './mlt.ts';
import { fakeVideos } from './fake-video.ts';

// A small finished film with one of everything the studio makes: a moved still, a clip started part of the way in, a
// scene that never got its picture, one narration, a bed, two sounds and three caption lines, one of them hostile.
const FILM: EditFilm = {
  title: 'Q3 update: "shipped" & <next>',
  width: 1280, height: 720, fps: 30,
  film: 'mf1a2b-q3-update.mp4', parts: 'mf1a2b-q3-update.parts',
  shots: [
    { seconds: 2.4, image: 'shot-0.png', move: 'push-in', ground: '#1C2530', words: 'We shipped -- twice' },
    { seconds: 3.1, video: 'clip-1.mp4', from: 1.5, ground: '#1C2530' },
    { seconds: 1.83, ground: '#1C2530', words: 'What is next' },
  ],
  narration: [{ file: 'voice.wav', at: 0, seconds: 6.9 }],
  bed: { file: 'bed.wav', at: 0, seconds: 7.33, gain: 1 },
  sounds: [{ file: 'cut-soft.wav', at: 2.4, seconds: 1, gain: 0.34 }, { file: 'drop.wav', at: 5.5, seconds: 1, gain: 0.38 }],
  captions: [
    { text: 'We shipped', at: 0.3, seconds: 0.9 },
    { text: 'twice #fast', at: 1.4, seconds: 0.8 },
    { text: 'R&D <costs> "less"', at: 4, seconds: 1.2 },
  ],
  ink: '#F2F5F8', capSize: 78, capFoot: 118,
};

// Just enough of an XML reader to hold the file to the rules: every tag closed in order, every attribute quoted,
// no bare ampersand or angle bracket in text, and only the five named entities.
type Node = { tag: string; attrs: Record<string, string>; children: Node[]; text: string };
function parse(source: string): Node {
  const root: Node = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const token = /<\?[^?]*\?>|<!--([\s\S]*?)-->|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/gy;
  let consumed = 0;
  for (const match of source.matchAll(token)) {
    consumed += match[0].length;
    const [, comment, close, open, attrs, empty, text] = match;
    if (comment !== undefined) { expect(comment).not.toMatch(/--/); continue; }
    if (text !== undefined) {
      expect(text).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
      expect(text).not.toMatch(/>/);
      stack.at(-1)!.text += text;
      continue;
    }
    if (close) { expect(stack.pop()!.tag).toBe(close); continue; }
    if (open) {
      const node: Node = { tag: open, attrs: {}, children: [], text: '' };
      for (const [, name, value] of attrs.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
        expect(value).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
        node.attrs[name] = value;
      }
      stack.at(-1)!.children.push(node);
      if (!empty) stack.push(node);
    }
  }
  expect(consumed).toBe(source.length);
  expect(stack).toHaveLength(1);
  return root;
}
const unescape = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const props = (node: Node) => Object.fromEntries(node.children.filter((one) => one.tag === 'property').map((one) => [one.attrs.name, unescape(one.text)]));

describe('the hand-editable film', () => {
  const text = mltOf(FILM);
  const doc = parse(text).children[0];
  const kids = (tag: string) => doc.children.filter((one) => one.tag === tag);
  const producers = new Map(kids('producer').map((one) => [one.attrs.id, one]));
  const playlists = new Map(kids('playlist').map((one) => [one.attrs.id, one]));
  const frames = framesOf(FILM.shots.map((one) => one.seconds), FILM.fps);
  const total = frames.reduce((sum, one) => sum + one, 0);

  it('is one well-formed MLT document with the film\'s profile', () => {
    expect(text.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<mlt ')).toBe(true);
    expect(doc.tag).toBe('mlt');
    expect(doc.attrs.producer).toBe('main');
    expect(unescape(doc.attrs.title)).toBe(FILM.title);
    const [profile] = kids('profile');
    expect(profile.attrs).toMatchObject({ width: '1280', height: '720', frame_rate_num: '30', frame_rate_den: '1', display_aspect_num: '16', display_aspect_den: '9', progressive: '1' });
    // Readable: indented, one element a line.
    expect(text).toContain('\n  <producer id="shot1" in="0" out="431999">\n    <property name="resource">');
  });

  it('names every producer before it is used, and uses nothing it did not name', () => {
    const order = doc.children.map((one) => one.tag);
    expect(order.lastIndexOf('producer')).toBeLessThan(order.indexOf('playlist'));
    expect(order.lastIndexOf('playlist')).toBeLessThan(order.indexOf('tractor'));
    for (const list of playlists.values()) {
      for (const entry of list.children.filter((one) => one.tag === 'entry')) {
        const producer = producers.get(entry.attrs.producer);
        expect(producer, entry.attrs.producer).toBeDefined();
        // A still or a colour says how long it can run; a file with a clock of its own says nothing.
        const length = Number(props(producer!).length ?? Infinity);
        expect(Number(entry.attrs.in)).toBeGreaterThanOrEqual(0);
        expect(Number(entry.attrs.out)).toBeLessThan(length);
        expect(Number(entry.attrs.out)).toBeLessThan(total);
      }
    }
    const [tractor] = kids('tractor');
    const tracks = tractor.children.find((one) => one.tag === 'multitrack')!.children;
    for (const track of tracks) expect(playlists.has(track.attrs.producer)).toBe(true);
    const size = tracks.length;
    for (const transition of tractor.children.filter((one) => one.tag === 'transition')) {
      expect(Number(props(transition).b_track)).toBeLessThan(size);
    }
  });

  it('cuts where the film cut, on the frame grid, and every path is relative', () => {
    expect(frames).toEqual([72, 93, 55]);
    const shots = playlists.get('pictures')!.children.filter((one) => one.tag === 'entry');
    expect(shots.map((one) => Number(one.attrs.out) - Number(one.attrs.in) + 1)).toEqual(frames);
    // The still is a plain picture, with the move it lost said in a comment beside it.
    expect(props(producers.get('shot1')!).resource).toBe('mf1a2b-q3-update.parts/shot-0.png');
    expect(text).toMatch(/<!-- We shipped – twice · the film moved this still \(push-in\); the move is not in this file, only the cut -->/);
    // No move is faked with a transform: the only affine in the file lays the captions over the shots.
    expect(text).not.toContain('qtblend');
    expect(text.match(/mlt_service">affine</g)).toHaveLength(1);
    // The clip starts a second and a half in and runs for its shot.
    expect(shots[1].attrs).toMatchObject({ producer: 'shot2', in: '45', out: String(45 + 93 - 1) });
    // The scene with no picture is the look's own ground.
    expect(props(producers.get('shot3')!)).toMatchObject({ mlt_service: 'color', resource: '#ff1c2530' });
    for (const producer of producers.values()) {
      const resource = props(producer).resource;
      expect(resource.startsWith('/'), resource).toBe(false);
      expect(resource).not.toContain('..');
    }
  });

  it('lays the finished film beside the cut, hidden and silent', () => {
    expect(props(producers.get('film')!).resource).toBe('mf1a2b-q3-update.mp4');
    expect(text).toContain('<track producer="rendered" hide="both"/>');
    expect(playlists.get('rendered')!.children.find((one) => one.tag === 'entry')!.attrs).toMatchObject({ in: '0', out: String(total - 1) });
  });

  it('puts the narration at the start, the bed at its own level and each sound where it landed', () => {
    const voice = playlists.get('narration')!.children.filter((one) => one.tag !== 'property');
    expect(voice[0]).toMatchObject({ tag: 'entry', attrs: { producer: 'voice1', in: '0', out: String(Math.round(6.9 * 30) - 1) } });
    expect(props(producers.get('bed1')!).resource).toBe('mf1a2b-q3-update.parts/bed.wav');
    const volume = producers.get('bed1')!.children.find((one) => one.tag === 'filter')!;
    expect(props(volume)).toMatchObject({ mlt_service: 'volume', gain: '1.00' });
    const sounds = playlists.get('sounds')!.children.filter((one) => one.tag !== 'property');
    expect(sounds.map((one) => one.tag)).toEqual(['blank', 'entry', 'blank', 'entry']);
    expect(sounds[0].attrs.length).toBe('72');
    expect(props(producers.get('sound2')!.children.find((one) => one.tag === 'filter')!).gain).toBe('0.38');
    for (const id of ['narration', 'music', 'sounds']) {
      expect(text).toContain(`<track producer="${id}" hide="video"/>`);
      expect(props(playlists.get(id)!)['shotcut:audio']).toBe('1');
    }
    const mixes = kids('tractor')[0].children.filter((one) => one.tag === 'transition').map(props).filter((one) => one.mlt_service === 'mix');
    expect(mixes).toHaveLength(3);
  });

  it('writes the captions as plain text on clear clips, timed from the words', () => {
    const lines = playlists.get('captions')!.children.filter((one) => one.tag !== 'property');
    expect(lines.map((one) => one.tag)).toEqual(['blank', 'entry', 'blank', 'entry', 'blank', 'entry']);
    expect(lines[0].attrs.length).toBe('9');
    const third = producers.get('caption3')!;
    expect(props(third)).toMatchObject({ mlt_service: 'color', resource: '#00000000', length: '432000' });
    expect(lines[5].attrs).toMatchObject({ producer: 'caption3', in: '0', out: '35' });
    const words = props(third.children.find((one) => one.tag === 'filter')!);
    expect(words).toMatchObject({ mlt_service: 'dynamictext', argument: 'R&D <costs> "less"', fgcolour: '#fff2f5f8', size: '78' });
    // A hash would make dynamic text look for a field to fill in.
    expect(props(producers.get('caption2')!.children.find((one) => one.tag === 'filter')!).argument).toBe('twice fast');
    const over = kids('tractor')[0].children.filter((one) => one.tag === 'transition').map(props).find((one) => one.mlt_service === 'affine');
    expect(over).toMatchObject({ a_track: '0', b_track: '2' });
  });

  it('leaves out what a film does not have', () => {
    const bare = mltOf({ ...FILM, narration: [], bed: undefined, sounds: [], captions: [] });
    expect(bare).not.toContain('<playlist id="narration">');
    expect(bare).not.toContain('<playlist id="music">');
    expect(bare).not.toContain('<playlist id="captions">');
    expect(bare).not.toContain('mlt_service">mix<');
    expect(bare).not.toContain('mlt_service">affine<');
    parse(bare);
  });

  it('escapes and colours the way XML and MLT read them', () => {
    expect(xml('a & b < c > "d" \'e\'\u0001')).toBe('a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
    expect(colourOf('#1C2530')).toBe('#ff1c2530');
    expect(colourOf('fff')).toBe('#ffffffff');
    expect(colourOf('rgb(1, 2, 3)')).toBe('#ff000000');
    expect(framesOf([0.01, 0.01], 30)).toEqual([1, 1]);
  });

  // The real XML reader on this machine, where there is one, has the last word on whether the file is well formed.
  it('passes xmllint where it is installed', () => {
    const lint = spawnSync('xmllint', ['--version']);
    if (lint.error) return;
    const at = join(mkdtempSync(join(tmpdir(), 'mlt-')), 'film.mlt');
    writeFileSync(at, text);
    const read = spawnSync('xmllint', ['--noout', at], { encoding: 'utf8' });
    expect(read.status, read.stderr).toBe(0);
  });
});

describe('a finished film, saved', () => {
  const card = { id: 'studio-3', kind: 'videogen' as const, x: 0, y: 0, w: 1, h: 1 };
  const { film: _film, parts: _parts, ...plan } = FILM;

  it('goes out with its project and its parts beside it, named after the film', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mlt-save-'));
    const store = createStore(dir);
    const maker = { ...fakeVideos, make: async () => ({ ext: 'mp4', bytes: Buffer.from('film'), edit: { film: plan, files: [{ name: 'shot-0.png', bytes: Buffer.from('png') }, { name: '../voice.wav', bytes: Buffer.from('wav') }] } }) };
    const made = await createMedia({ dir, store, makers: { videogen: [maker] } }).make(card, { prompt: 'Q3 update' });
    const base = made.path.replace(/\.mp4$/, '');
    expect(made.mlt).toBe(`${base}.mlt`);
    const name = base.split('/').pop();
    const project = (await store.readFileBytes(made.mlt!))!.toString('utf8');
    expect(project).toContain(`<property name="resource">${name}.mp4</property>`);
    expect(project).toContain(`<property name="resource">${name}.parts/shot-0.png</property>`);
    expect((await store.readFileBytes(`${base}.parts/shot-0.png`))!.toString()).toBe('png');
    // A part is only ever a name inside the folder, whatever it was called on the way in.
    expect((await store.readFileBytes(`${base}.parts/voice.wav`))!.toString()).toBe('wav');
  });

  it('is not made for a draft', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mlt-draft-'));
    const media = createMedia({ dir, store: createStore(dir), makers: { videogen: [fakeVideos] } });
    expect((await media.make(card, { prompt: 'A film', speed: 'draft' })).mlt).toBeUndefined();
    expect((await media.make({ ...card, id: 'studio-4' }, { prompt: 'A film' })).mlt).toMatch(/^media\/.+\.mlt$/);
  });
});
