import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bibleFor, type Understanding } from './director.ts';
import { pictureHash, type EditOp, type FilmRecord } from './edits.ts';
import { recordOf } from './film-record.ts';
import type { Maker } from './jobs.ts';
import { remakeFilm } from './remake.ts';
import type { Seen, Sight } from './sight.ts';
import type { Scene } from './spec.ts';
import type { VideoDeps } from './video.ts';

// The renderer, as far as a remake needs one: a check that passes, a render that writes a file, a poster frame, and
// a transcriber that is never there, so every line is timed from its sentence.
const FAKE_BIN = `#!/bin/sh
case "$1" in
  check) exit 0 ;;
  render) printf 'film' > out.mp4; exit 0 ;;
  snapshot) mkdir -p poster; printf 'png' > poster/frame.png; exit 0 ;;
  *) exit 1 ;;
esac
`;
const vendor = resolve(import.meta.dirname, 'templates/vendor');

// Four spoken scenes on drawn backgrounds, in the clean look, with nobody reading them: the smallest film a look
// change redraws every picture of.
const film = (): FilmRecord => {
  const scenes: Scene[] = [0, 1, 2, 3].map((at) => ({ layout: 'statement', text: `Line ${at}`, say: `The founder ships line ${at}.` }));
  const bible = bibleFor({ pack: 'clean' } as Understanding);
  const shots = scenes.map((_scene, at) => ({ scene: at, take: 0, seconds: 2, bg: `frame-${at}-0.png` }));
  return recordOf({
    title: 'Four lines', spec: { title: 'Four lines', scenes }, shape: 'wide', look: 'clean', pace: 'calm', captions: false, sfx: false, music: 'none', bible, shots,
    pictures: Object.fromEntries(shots.map((one, at) => [one.bg, { kind: 'drawn' as const, hash: pictureHash(`a desk, scene ${at}`, bible, 'wide'), subject: `a founder at a desk, scene ${at}` }])),
  });
};

const setup = async (over: { sight?: Sight; fileOf?: (path: string) => string; record?: FilmRecord } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'remake-'));
  const bin = join(dir, 'hyperframes');
  await writeFile(bin, FAKE_BIN);
  await chmod(bin, 0o755);
  let busy = 0;
  let most = 0;
  const asked: string[] = [];
  const images: Maker = {
    name: 'stub', ready: () => null,
    async make(ask) {
      asked.push(String(ask.prompt));
      busy += 1;
      most = Math.max(most, busy);
      await new Promise((done) => setTimeout(done, 15));
      busy -= 1;
      return { ext: 'png', bytes: Buffer.from(String(ask.prompt)) };
    },
  };
  const deps: VideoDeps = {
    dir, think: async () => '', images, sight: over.sight, fileOf: over.fileOf,
    // The old film's parts are all there to be brought across.
    readFile: async () => Buffer.from('old picture'),
  };
  const lines: string[] = [];
  const remake = (ops: EditOp[]) => remakeFilm({ path: 'media/four.mp4', record: over.record ?? film() }, ops, { report: (line) => lines.push(line) }, deps, { bin, vendor });
  return { remake, lines, asked, most: () => most };
};

describe('a film remade from notes', () => {
  it('draws every picture of a new look three at a time, and puts each back on its own shot', async () => {
    const { remake, asked, most } = await setup();
    const made = await remake([{ op: 'look', look: 'editorial' }]);
    expect(asked).toHaveLength(4);
    expect(most()).toBe(3);
    const shots = made.record!.scenes.map((one) => one.shots[0].bg);
    expect(shots).toEqual(['frame-e0-0.png', 'frame-e1-0.png', 'frame-e2-0.png', 'frame-e3-0.png']);
    // Each picture is drawn from its own scene's subject in the new look.
    for (const [at, prompt] of asked.entries()) expect(prompt).toContain(`scene ${at}`);
  });

  it('looks at every picture it draws again, and records the words of the one it kept', async () => {
    // The redrawn picture of the first scene is the one that stares; its second drawing does not.
    const seen: Record<string, Seen> = { 'frame-e0-0.png': { facing: 0.9, lettered: 0 }, 'frame-e0-0-b.png': { facing: 0.1, lettered: 0 } };
    const sight: Sight = { warm: () => {}, why: () => null, look: async (file) => seen[file.split('/').pop()!] ?? null, plies: async () => null };
    const { remake, lines } = await setup({ sight });
    const made = await remake([{ op: 'look', look: 'editorial' }]);
    expect(lines).toContain('a picture came back with somebody looking straight at the camera, so it was drawn again');
    expect(made.record!.scenes[0].shots[0].bg).toBe('frame-e0-0-b.png');
    const kept = made.record!.pictures['frame-e0-0-b.png'];
    expect(kept.kind).toBe('drawn');
    expect(kept.subject).not.toContain('founder');
  });

  it('keeps the old picture and says so when a note names a picture the shared files refuse', async () => {
    const fileOf = (path: string) => { if (path.includes('..')) throw new Error(`bad path: ${path}`); return path; };
    const { remake, lines } = await setup({ fileOf });
    const made = await remake([{ op: 'swap_picture', scene: 2, asset: '../outside.png' }]);
    expect(lines).toContain('outside.png could not be read, so shot 2 keeps its picture');
    expect(made.record!.scenes[1].shots[0].bg).toBe('frame-1-0.png');
    expect(made.bytes.toString()).toBe('film');
  });

  it('carries the credit of a stock photograph it keeps into the new record and the credits file', async () => {
    const record = film();
    const credit = 'a desk at dawn by Ana Lima on Pexels — https://www.pexels.com/photo/1';
    record.pictures['frame-0-0.png'] = { kind: 'stock', hash: 'stock:1', subject: 'a desk at dawn', credit };
    const { remake } = await setup({ record });
    const made = await remake([{ op: 'drop', scene: 4 }]);
    expect(made.record!.pictures['frame-0-0.png'].credit).toBe(credit);
    expect(made.credits).toContain(`- ${credit}`);
  });
});
