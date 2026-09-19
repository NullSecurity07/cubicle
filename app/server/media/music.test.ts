import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ffReady } from './ff.ts';
import {
  beatsOf, createMusic, fakeMusic, fits, hashOf, keep, licenceOf, loudness, makeBed, monoOf, MOODS,
  openverseResults, freesoundResults, pcmOf, sfx, SHAPES, wavOf, type Found,
} from './music.ts';
import { wavSeconds } from './voice.ts';

const dir = await mkdtemp(join(tmpdir(), 'music-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

const nothing = { report: () => {} };
const lines = () => { const said: string[] = []; return { said, report: (line: string) => said.push(line) }; };
// What a bed really measures, read back out of the file the way a player would read it.
const measured = (bytes: Buffer) => {
  const { samples } = monoOf(bytes);
  const both = Float32Array.from(samples);
  let peak = 0;
  let jumped = 0;
  for (let at = 1; at < samples.length; at += 1) {
    peak = Math.max(peak, Math.abs(samples[at]));
    jumped = Math.max(jumped, Math.abs(samples[at] - samples[at - 1]));
  }
  return { seconds: wavSeconds(bytes), peak, jumped, lufs: loudness(both, Float32Array.from(samples)) };
};

describe('which licences a founder may sell a film under', () => {
  it('takes the public domain and plain attribution, and nothing it has not read', () => {
    expect(licenceOf('cc0')?.credit).toBe(false);
    expect(licenceOf('pdm')?.credit).toBe(false);
    expect(licenceOf('by')?.credit).toBe(true);
    expect(licenceOf('CC0', '1.0')?.name).toContain('1.0');
    // Everything that would cost the founder the sale, the cut or their own film's terms.
    for (const bad of ['by-nc', 'by-nc-sa', 'by-nc-nd', 'nc-sampling+', 'by-nd', 'by-sa', 'sa']) expect(licenceOf(bad), bad).toBeNull();
    // And everything nobody has actually read: a missing field is not a permission.
    for (const unknown of ['', '   ', 'all rights reserved', 'royalty free', 'unknown', undefined, null, 7]) expect(licenceOf(unknown), String(unknown)).toBeNull();
  });
});

describe('what a search is allowed to come back with', () => {
  const payload = {
    results: [
      { id: 'a', title: 'Slow Morning', creator: 'Ana', license: 'cc0', license_version: '1.0', url: 'https://example.org/a.mp3', foreign_landing_url: 'https://example.org/a', duration: 121_000, filetype: 'mp3', bit_rate: 192_000, sample_rate: 44_100, category: 'music', tags: [{ name: 'ambient' }] },
      { id: 'b', title: 'Sellable Never', creator: 'Bo', license: 'by-nc', url: 'https://example.org/b.mp3', duration: 180_000, filetype: 'mp3', category: 'music', tags: [] },
      { id: 'c', title: 'A reading of a poem', creator: 'Cy', license: 'cc0', url: 'https://example.org/c.mp3', duration: 180_000, filetype: 'mp3', category: 'music', tags: [{ name: 'spoken' }] },
      { id: 'd', title: 'Nine seconds', creator: 'Di', license: 'pdm', url: 'https://example.org/d.mp3', duration: 9_000, filetype: 'mp3', category: 'music', tags: [] },
      { id: 'e', title: 'Thin', creator: 'Ed', license: 'cc0', url: 'https://example.org/e.mp3', duration: 180_000, filetype: 'mp3', bit_rate: 48_000, category: 'music', tags: [] },
      { id: 'f', title: 'No licence stated', creator: 'Fi', url: 'https://example.org/f.mp3', duration: 180_000, category: 'music', tags: [] },
      { id: 'g', title: 'Credited', creator: 'Gil', license: 'by', license_version: '4.0', url: 'https://example.org/g.mp3', duration: 180_000, filetype: 'ogg', category: 'music', tags: [] },
    ],
  };

  it('keeps only what is music, long enough, worth hearing and free to sell', () => {
    const found = openverseResults(payload, 20);
    expect(found.map((one) => one.title)).toEqual(['Slow Morning', 'Credited']);
    expect(found[0].credit).toBe(false);
    expect(found[1].credit).toBe(true);
    expect(found[0].source).toBe('https://example.org/a');
    expect(found[0].seconds).toBeCloseTo(121, 0);
    expect(openverseResults({}, 20)).toEqual([]);
    expect(openverseResults({ results: 'no' }, 20)).toEqual([]);
  });

  it('reads Freesound\'s licence out of the address it writes it as', () => {
    const found = freesoundResults({
      results: [
        { id: 11, name: 'Bed', username: 'sam', license: 'http://creativecommons.org/publicdomain/zero/1.0/', duration: 95, tags: ['loop'], previews: { 'preview-hq-mp3': 'https://freesound.org/data/11.mp3' } },
        { id: 12, name: 'Not for sale', username: 'sam', license: 'http://creativecommons.org/licenses/by-nc/4.0/', duration: 95, tags: [], previews: { 'preview-hq-mp3': 'https://freesound.org/data/12.mp3' } },
      ],
    }, 20);
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('https://freesound.org/s/11/');
  });

  it('puts the track that sounds like the mood in front of the one that merely matched a word', () => {
    const one = (title: string, where: string): Found => ({ id: title, title, by: 'a', licence: 'CC0', credit: false, source: 's', url: 'https://e.org/a.mp3', seconds: 90, ext: 'mp3', where });
    // "warm" searches for acoustic and guitar, so a guitar loop beats a drum loop that only matched the word "loop".
    expect(fits(one('Guitar Loop', 'acoustic guitar loop'), 'warm')).toBeGreaterThan(fits(one('120 BPM Drum Loop', 'drums kick snare'), 'warm'));
    expect(fits(one('Minimal Techno Loop', 'techno synth electronic'), 'tech')).toBeGreaterThan(fits(one('Minimal Techno Loop', 'techno synth electronic'), 'warm'));
    expect(fits(one('Untitled', ''), 'calm')).toBe(0);
  });

  it('will not take a track over plain http, however well licensed it is', () => {
    const one: Found = { id: 'x', title: 'Fine', by: 'a', licence: 'CC0', credit: false, source: 'x', url: 'http://example.org/x.mp3', seconds: 90, ext: 'mp3', where: 'music' };
    expect(keep(one, 20)).toBe(false);
    expect(keep({ ...one, url: 'https://example.org/x.mp3' }, 20)).toBe(true);
    // A film may be longer than its bed, which simply goes round again — but not four times round a ringtone: a long
    // film wants at least three quarters of a minute of music, and a short one at least twenty seconds.
    expect(keep({ ...one, url: 'https://e.org/x.mp3', seconds: 50 }, 90)).toBe(true);
    expect(keep({ ...one, url: 'https://e.org/x.mp3', seconds: 25 }, 90)).toBe(false);
    expect(keep({ ...one, url: 'https://e.org/x.mp3', seconds: 25 }, 20)).toBe(true);
    expect(keep({ ...one, url: 'https://e.org/x.mp3', seconds: 12 }, 20)).toBe(false);
    expect(keep({ ...one, url: 'https://e.org/x.mp3', seconds: 3600 }, 20)).toBe(false);
  });
});

describe('the bed this app writes itself', () => {
  it('gives every mood its own piece of music, at the level a narrated film wants', () => {
    for (const mood of MOODS) {
      const made = makeBed(mood, 12, hashOf(`test:${mood}`));
      const read = measured(made.bytes);
      expect(read.seconds, mood).toBeCloseTo(12, 1);
      // Broadcast bed level, measured the way a broadcaster measures it. One and a half either way is a rounding.
      expect(read.lufs, mood).toBeGreaterThan(-25.5);
      expect(read.lufs, mood).toBeLessThan(-21);
      // Quiet with the peaks intact: nothing here is squashed against the ceiling.
      expect(read.peak, mood).toBeLessThan(0.55);
      expect(read.peak, mood).toBeGreaterThan(0.05);
      // A click is a jump between two neighbouring samples that nothing musical could make.
      expect(read.jumped, mood).toBeLessThan(0.09);
      expect(made.bpm, mood).toBeGreaterThan(40);
      expect(made.beats[1] - made.beats[0], mood).toBeCloseTo(60 / made.bpm, 2);
      expect(made.beats.at(-1)!, mood).toBeLessThan(12);
    }
  });

  it('never writes the same film twice, and writes the same one again when told to', () => {
    const keys = new Set(MOODS.map((mood) => makeBed(mood, 8, hashOf(mood)).bytes.toString('base64')));
    expect(keys.size).toBe(MOODS.length);
    const varied = new Set([1, 2, 3, 4, 5, 6].map((seed) => makeBed('upbeat', 8, seed).bytes.toString('base64')));
    expect(varied.size).toBe(6);
    // The same seed is the same bed, to the byte, which is what a re-render of one film needs.
    expect(makeBed('tech', 8, 42).bytes.equals(makeBed('tech', 8, 42).bytes)).toBe(true);
  });

  it('takes the pulse it is given, and holds to a sensible length either way', () => {
    expect(makeBed('calm', 8, 1, 96).bpm).toBe(96);
    expect(makeBed('calm', 8, 1, 4).bpm).toBe(50);
    expect(makeBed('calm', 8, 1, 9_000).bpm).toBe(190);
    expect(wavSeconds(makeBed('calm', 0.2, 1).bytes)).toBeCloseTo(4, 1);
    expect(wavSeconds(makeBed('calm', 45, 1).bytes)).toBeCloseTo(45, 1);
  });

  it('gives every mood something to search for as well as something to play', () => {
    for (const mood of MOODS) {
      expect(SHAPES[mood].terms.length, mood).toBeGreaterThan(2);
      expect(SHAPES[mood].runs.length, mood).toBeGreaterThan(1);
      for (const run of SHAPES[mood].runs) expect(run.length, mood).toBeGreaterThan(2);
    }
  });
});

describe('finding the beats in something nobody told us the tempo of', () => {
  it('counts a plain pulse exactly, and puts its beats on it', () => {
    // A hundred beats a minute of nothing but clicks: if this cannot be counted, nothing can.
    const samples = new Float32Array(44_100 * 20);
    const period = 0.6;
    for (let beat = 0; beat * period < 20; beat += 1) {
      const start = Math.round((beat * period + 0.1) * 44_100);
      for (let at = 0; at < 900 && start + at < samples.length; at += 1) samples[start + at] = Math.sin(at / 3) * (1 - at / 900);
    }
    const found = beatsOf(samples, 44_100, 20)!;
    expect(found.bpm).toBeGreaterThan(98);
    expect(found.bpm).toBeLessThan(102);
    expect(found.beats.length).toBeGreaterThan(30);
    // On the clicks, not between them, and always forwards.
    expect(found.beats[0]).toBeCloseTo(0.1, 1);
    expect(found.beats.at(-1)!).toBeLessThan(20);
    expect(found.beats.every((at, index) => index === 0 || at > found.beats[index - 1])).toBe(true);
  });

  it('reads a real bed\'s pulse back off its samples', () => {
    // The moods whose drums fall on every beat. The ones that only imply a beat are counted at half or double it as
    // often as a person would, which is why a made bed hands back the tempo it was written at rather than this.
    for (const mood of ['upbeat', 'tech', 'dramatic'] as const) {
      const made = makeBed(mood, 24, hashOf(`beat:${mood}`));
      const found = beatsOf(monoOf(made.bytes).samples, 44_100, 24);
      expect(found, mood).not.toBeNull();
      expect(found!.bpm, mood).toBeGreaterThan(made.bpm * 0.94);
      expect(found!.bpm, mood).toBeLessThan(made.bpm * 1.06);
      expect(found!.beats.length, mood).toBeGreaterThan(20);
    }
  });

  it('says nothing rather than something made up when there is nothing to hear', () => {
    expect(beatsOf(new Float32Array(1000))).toBeNull();
    expect(beatsOf(new Float32Array(44_100 * 5))).toBeNull();
  });
});

describe('measuring loudness the way a broadcaster does', () => {
  it('agrees with the standard on a tone, and floors on silence', () => {
    const tone = (level: number) => {
      const samples = new Float32Array(44_100 * 3);
      for (let at = 0; at < samples.length; at += 1) samples[at] = level * Math.sin((2 * Math.PI * 1000 * at) / 44_100);
      return samples;
    };
    // The standard's own calibration: a thousand-hertz tone at −20 dBFS in both channels reads −20 LUFS.
    expect(loudness(tone(0.1), tone(0.1))).toBeCloseTo(-20, 1);
    // Which means loudness moves with gain, one decibel for one, and one pass can reach a target.
    expect(loudness(tone(1), tone(1))).toBeCloseTo(0, 1);
    expect(loudness(tone(0.01), tone(0.01))).toBeCloseTo(-40, 1);
    expect(loudness(new Float32Array(44_100 * 2), new Float32Array(44_100 * 2))).toBe(-70);
    expect(loudness(new Float32Array(10), new Float32Array(10))).toBe(-70);
  });
});

describe('the sounds a reel needs that the bundled set has not got', () => {
  it('makes a whoosh, a riser and an impact out of arithmetic, owing nobody anything', () => {
    for (const kind of ['whoosh', 'riser', 'impact'] as const) {
      const one = sfx(kind);
      expect(one.ext).toBe('wav');
      expect(wavSeconds(one.bytes), kind).toBeGreaterThan(0.4);
      expect(wavSeconds(one.bytes), kind).toBeLessThan(2.5);
      expect(one.credit.licence, kind).toContain('CC0');
      const read = measured(one.bytes);
      expect(read.peak, kind).toBeLessThan(0.95);
      expect(read.peak, kind).toBeGreaterThan(0.05);
    }
    // A riser rises: its second half is louder than its first, which is the whole of what the word means.
    const { samples } = monoOf(sfx('riser').bytes);
    const half = samples.length >> 1;
    const power = (from: number, to: number) => { let sum = 0; for (let at = from; at < to; at += 1) sum += samples[at] ** 2; return sum / (to - from); };
    expect(power(half, samples.length)).toBeGreaterThan(power(0, half) * 4);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The whole thing, with the network replaced by a function. No test here touches the internet.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A track the fake search offers, made by the synthesiser itself so the test carries no audio fixture around.
const TRACK = makeBed('upbeat', 40, 7).bytes;
const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const offer = (id: string, licence: string, version = '1.0') => ({
  id, title: `Track ${id}`, creator: 'Someone', license: licence, license_version: version,
  url: `https://example.org/${id}.wav`, foreign_landing_url: `https://example.org/${id}`,
  duration: 40_000, filetype: 'wav', sample_rate: 44_100, category: 'music', tags: [{ name: 'music' }],
});
// Every request the module can make, answered from memory: a search comes back as JSON, a track as the bytes above.
const httpFor = (results: unknown[], onSearch?: (url: string) => void): typeof fetch => (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith('https://api.openverse.org/')) { onSearch?.(url); return answer({ results }); }
  if (url.startsWith('https://example.org/')) return new Response(new Uint8Array(TRACK), { status: 200 });
  throw new Error(`the test did not expect a call to ${url}`);
}) as typeof fetch;

describe.skipIf(await ffReady())('a bed for a real film', () => {
  it('fetches a public-domain track once, keeps it, and says whose it is', async () => {
    const at = join(dir, 'fetched');
    const asked: string[] = [];
    const music = createMusic({ cacheDir: at, env: { STAGE_MUSIC_SEED: 'one' }, http: httpFor([offer('t1', 'cc0')], (url) => asked.push(url)) });
    const said = lines();
    const made = await music.bed({ mood: 'upbeat', seconds: 14 }, said);

    expect(made.ext).toBe('wav');
    expect(wavSeconds(made.bytes)).toBeCloseTo(14, 1);
    expect(made.credit).toEqual({ title: 'Track t1', by: 'Someone', licence: 'CC0 1.0 (public domain, no attribution asked)', source: 'https://example.org/t1' });
    // The founder sees whose music it is on the card, without going looking for it.
    expect(said.said.join(' ')).toContain('"Track t1" by Someone');
    // It asked for the public domain, from the one place that has any, at a length a bed could be.
    expect(asked[0]).toContain('license=cc0%2Cpdm');
    expect(asked[0]).toContain('source=freesound');
    expect(asked[0]).toContain('length=short%2Cmedium');
    // Never `category=music`: everything Openverse files under that is Jamendo, and none of it may be sold under.
    expect(asked[0]).not.toContain('category=');

    // The record of what was used, written where a person can read it a year later.
    const index = JSON.parse(await readFile(join(at, 'music', 'index.json'), 'utf8')) as { tracks: { id: string; licence: string; mood: string; fetched: string }[] };
    expect(index.tracks).toHaveLength(1);
    expect(index.tracks[0].mood).toBe('upbeat');
    expect(index.tracks[0].licence).toContain('CC0');
    expect(Date.parse(index.tracks[0].fetched)).toBeGreaterThan(0);
    expect(await readFile(join(at, 'music', 'CREDITS.md'), 'utf8')).toContain('Track t1');

    // And once it is here, it is here: the same card works with the network unplugged.
    const offline = createMusic({
      cacheDir: at, env: { STAGE_MUSIC_SEED: 'one' },
      http: (async () => { throw new Error('no network'); }) as typeof fetch,
    });
    const again = await offline.bed({ mood: 'upbeat', seconds: 9 }, nothing);
    expect(again.credit.title).toBe('Track t1');
    expect(wavSeconds(again.bytes)).toBeCloseTo(9, 1);
  }, 120_000);

  it('brings a found track to the same level as one written here, and finds its beats', async () => {
    const music = createMusic({ cacheDir: join(dir, 'beats'), env: { STAGE_MUSIC_SEED: 'beat' }, http: httpFor([offer('t2', 'cc0')]) });
    const made = await music.bed({ mood: 'upbeat', seconds: 16 }, nothing);
    expect(made.bpm).toBeGreaterThan(60);
    expect(made.beats!.length).toBeGreaterThan(10);
    // ffmpeg's own single-pass normaliser lands a few decibels out on a quiet track; this is the pass that corrects it.
    const read = measured(made.bytes);
    expect(read.lufs).toBeGreaterThan(-25.5);
    expect(read.lufs).toBeLessThan(-21);
    expect(read.peak).toBeLessThan(0.95);
  }, 120_000);

  it('says the author has to be named when the licence asks for it', async () => {
    const music = createMusic({ cacheDir: join(dir, 'credited'), env: { STAGE_MUSIC_SEED: 'c' }, http: httpFor([offer('t3', 'by', '4.0')]) });
    const said = lines();
    const made = await music.bed({ mood: 'calm', seconds: 8 }, said);
    expect(made.credit.licence).toContain('CC BY 4.0');
    expect(said.said.join(' ')).toContain('Name them in the film');
  }, 120_000);
});

describe('a bed that never fails', () => {
  it('writes one here when the network is down, and says so rather than throwing', async () => {
    const music = createMusic({
      cacheDir: join(dir, 'down'), env: {},
      http: (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as typeof fetch,
    });
    const said = lines();
    const made = await music.bed({ mood: 'cinematic', seconds: 6 }, said);
    expect(wavSeconds(made.bytes)).toBeCloseTo(6, 1);
    expect(made.credit.by).toContain('Video studio');
    expect(said.said.some((line) => line.includes('writing a bed here instead'))).toBe(true);
  }, 60_000);

  it('writes one here when everything found is something the founder could not sell', async () => {
    const music = createMusic({
      cacheDir: join(dir, 'nc'), env: {},
      http: httpFor([offer('bad1', 'by-nc'), offer('bad2', 'by-nc-sa'), offer('bad3', 'by-nd'), { ...offer('bad4', 'cc0'), license: undefined }]),
    });
    const said = lines();
    const made = await music.bed({ mood: 'tech', seconds: 6 }, said);
    expect(made.credit.source).toBe('app/server/media/music.ts');
    expect(said.said.some((line) => line.includes('nothing found'))).toBe(true);
  }, 60_000);

  it('does not go looking at all when this machine is told not to', async () => {
    const music = createMusic({
      cacheDir: join(dir, 'quiet'), env: { STAGE_NO_MUSIC_SEARCH: '1' },
      http: (async () => { throw new Error('the search should not have been asked'); }) as typeof fetch,
    });
    const made = await music.bed({ mood: 'warm', seconds: 6 }, nothing);
    expect(made.credit.licence).toContain('CC0');
    expect(made.bpm).toBeGreaterThan(40);
  }, 60_000);

  it('takes a mood it has never heard of as calm rather than as an error', async () => {
    const music = createMusic({ cacheDir: join(dir, 'odd'), env: { STAGE_NO_MUSIC_SEARCH: '1' } });
    const made = await music.bed({ mood: 'jazzy' as never, seconds: 5 }, nothing);
    expect(made.credit.title).toContain('Calm');
  }, 60_000);

  it('scores two films differently when nobody has pinned the dice', async () => {
    const music = createMusic({ cacheDir: join(dir, 'vary'), env: { STAGE_NO_MUSIC_SEARCH: '1' } });
    const first = await music.bed({ mood: 'upbeat', seconds: 6 }, nothing);
    const second = await music.bed({ mood: 'upbeat', seconds: 6 }, nothing);
    expect(first.bytes.equals(second.bytes)).toBe(false);
  }, 60_000);
});

describe('the bed the tests and the fake runs get', () => {
  it('needs no network, no ffmpeg and no second of waiting', async () => {
    const said = lines();
    const made = await fakeMusic.bed({ mood: 'playful', seconds: 6 }, said);
    expect(made.ext).toBe('wav');
    expect(wavSeconds(made.bytes)).toBeCloseTo(6, 1);
    expect(made.credit.by).toContain('Video studio');
    expect(made.beats!.length).toBeGreaterThan(5);
    expect(said.said).toHaveLength(1);
    // The same ask twice is the same bed: a fake that wobbles is a test that wobbles.
    const again = await fakeMusic.bed({ mood: 'playful', seconds: 6 }, nothing);
    expect(again.bytes.equals(made.bytes)).toBe(true);
  });

  it('writes a WAV that says what it is, and reads its own samples back', () => {
    const left = Float32Array.from({ length: 4410 }, (_, at) => Math.sin(at / 20));
    const bytes = wavOf(left, left);
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.readUInt16LE(22)).toBe(2);
    expect(wavSeconds(bytes)).toBeCloseTo(0.1, 2);
    const back = monoOf(bytes);
    expect(back.rate).toBe(44_100);
    expect(back.samples.length).toBe(4410);
    expect(back.samples[100]).toBeCloseTo(left[100], 3);
    expect(monoOf(Buffer.from('not a wav at all')).samples).toHaveLength(0);
    // Both channels come back apart, which is what the loudness meter and the level pass work on.
    const right = Float32Array.from(left, (one) => -one);
    const stereo = pcmOf(wavOf(left, right));
    expect(stereo.left[100]).toBeCloseTo(left[100], 3);
    expect(stereo.right[100]).toBeCloseTo(-left[100], 3);
    expect(pcmOf(Buffer.alloc(8)).left).toHaveLength(0);
  });
});
