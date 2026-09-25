import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ff, FFMPEG } from './ff.ts';
import { beatsOf, monoOf, pcmOf, RATE, TARGET_LUFS, toLevel, wavOf } from './sound.ts';
import { article, diceOf, hashOf, madeCredit, makeBed, MAX_SECONDS, MIN_SECONDS, SHAPES, sfx } from './synth.ts';

// The bed under a film, found or made, and never one the founder could be sued over.
//
// The rule this whole file is built around: **a founder may sell the film.** So nothing here touches a track whose
// terms are non-commercial, no-derivatives, share-alike or simply not stated. Three layers, best first:
//
//  1. **Openverse** (`api.openverse.org`) searched for `cc0` and `pdm` music — no key, no account, no card. Every
//     candidate's licence field is read and checked against a short allow-list before a byte is downloaded; anything
//     unrecognised is dropped rather than guessed at. A track is fetched once into the cache and never again, so the
//     second film on a plane still has music. Freesound is the same idea behind a free key, and is only asked when
//     the founder has put one in `.env`.
//  2. **Nothing local, yet.** Of the models that could write a tune on this machine, MusicGen's weights are
//     CC-BY-NC — a founder could not sell the film — and Stable Audio Open is behind a gate and a community licence
//     of its own. ACE-Step is the one whose terms are fine (MIT), and `acestep.cpp` does have a processor backend,
//     but nobody has published what twenty seconds costs on a processor, and this box has four gigabytes of video
//     memory, which is to say none for this. Shipping several gigabytes of weights on an unmeasured guess is how a
//     card ends up spinning for twenty minutes, so there is no layer two — only a measurement waiting to be made.
//  3. **A bed made here, in this file, out of arithmetic.** No model, no network, no file: chords, a bass and a
//     little percussion written a sample at a time. It is the last resort and it is always there, so `bed()` never
//     fails for want of a network. Nobody owns arithmetic, so its credit says CC0 and means it.
//
// What comes back is a finished bed: exactly the seconds asked for, its seam folded so it loops, and normalised to
// about −23 LUFS so the ducking in `audio.ts` has room to work. It carries no musical fade in or out, because
// `musicBed()` puts those on the film's own clock and a bed faded twice arrives late.

export const MOODS = ['upbeat', 'calm', 'cinematic', 'tech', 'warm', 'playful', 'dramatic'] as const;
export type Mood = (typeof MOODS)[number];
// Who made the music, on what terms, and where it came from — recorded for every bed, including the made ones.
export type Credit = { title: string; by: string; licence: string; source: string };
export type Music = {
  bed(
    ask: { mood: Mood; seconds: number; bpm?: number },
    help: { report: (line: string) => void; signal?: AbortSignal },
  ): Promise<{ ext: 'wav' | 'mp3' | 'ogg'; bytes: Buffer; credit: Credit; bpm?: number; beats?: number[] }>;
};

export const isMood = (word: unknown): word is Mood => MOODS.includes(word as Mood);

// The sound itself lives in `sound.ts` and the bed made here in `synth.ts`. Both are said again here, by the names
// the studio and its checks have always imported them under.
export { beatsOf, loudness, monoOf, onsetsOf, pcmOf, toLevel, wavOf } from './sound.ts';
export { hashOf, madeCredit, makeBed, SHAPES, sfx, type SfxKind } from './synth.ts';

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Licences: the short list of terms a founder may sell a film under, and nothing else.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Keyed by the lower-cased licence code the search gives back. `credit` means the film has to name the author, which
// is a cost, so those sort last — but they are still allowed, because the credit really is recorded and said out loud.
export const LICENCES: Record<string, { label: string; note: string; credit: boolean }> = {
  cc0: { label: 'CC0', note: 'public domain, no attribution asked', credit: false },
  'creative commons 0': { label: 'CC0', note: 'public domain, no attribution asked', credit: false },
  pdm: { label: 'Public Domain Mark', note: 'no known copyright', credit: false },
  'public domain': { label: 'Public domain', note: 'no known copyright', credit: false },
  by: { label: 'CC BY', note: 'commercial use allowed, the author must be credited', credit: true },
  attribution: { label: 'CC BY', note: 'commercial use allowed, the author must be credited', credit: true },
};

// Read strictly: a licence this does not recognise is a licence nobody has checked, and an unchecked licence is a
// lawsuit rather than a saving. `nc` forbids selling, `nd` forbids cutting it into a film, and `sa` would put the
// founder's own film under the same terms — all three are refused by name as well as by not being on the list.
export function licenceOf(code: unknown, version?: unknown): { name: string; credit: boolean } | null {
  if (typeof code !== 'string') return null;
  const clean = code.trim().toLowerCase();
  if (!clean) return null;
  if (/(^|[-\s])(nc|nd|sa|sampling|nc-sa|nc-nd)([-\s]|$)/.test(clean)) return null;
  const found = LICENCES[clean];
  if (!found) return null;
  const said = typeof version === 'string' && version.trim() ? ` ${version.trim()}` : '';
  return { name: `${found.label}${said} (${found.note})`, credit: found.credit };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The search. Openverse first, because it needs no key at all; Freesound only when the founder has put a free key in.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const OPENVERSE = 'https://api.openverse.org/v1/audio/';
const FREESOUND = 'https://freesound.org/apiv2/search/text/';
const AGENT = 'stage-video-studio/1.0 (+https://github.com/; a founder tool looking for CC0 music)';
const SEARCH_TIMEOUT = 15_000;
const FETCH_TIMEOUT = 90_000;
const MAX_BYTES = 40 * 1024 * 1024;
// How many of the best-fitting candidates the dice gets to choose between.
const PICK_FROM = 6;

// One candidate, already reduced to the handful of things that decide whether it can be used.
export type Found = { id: string; title: string; by: string; licence: string; credit: boolean; source: string; url: string; seconds: number; ext: string; where: string };

// Anything that is plainly not music, told from its words alone. A bed under a founder's launch film must not turn
// out to be somebody reading a poem, and the cheap test catches nearly all of it.
// The second half of it is the field recordings. They are the commonest thing in a public-domain audio library and
// they are all beautifully licensed, and a marketing film with birdsong under it is a film nobody finishes.
const NOT_MUSIC = /\b(speech|spoken|voice|vocal|interview|podcast|lecture|talk|talking|audiobook|reading|sermon|narration|narrator|sample ?pack|sound ?effect|sfx|foley|noise|whitenoise|test tone|sine ?wave|asmr|announcement|tutorial|anthem|recitation|midi|bird|birds|birdsong|rain|thunder|storm|wind|water|waves|stream|ocean|river|forest|nature|wildlife|insect|animal|room ?tone|ambience|footstep|door|engine|traffic|machine|crack|creak)\b/i;
// And a word that says it is. Asking a search for "upbeat" comes back with a musical saw as happily as with a tune,
// so a candidate has to claim to be music somewhere in its own title or tags before it is even considered.
const IS_MUSIC = /\b(music|musical|song|track|tune|loop|beat|instrumental|background|bgm|soundtrack|ambient|theme|melody|groove|jingle|piano|guitar|synth|orchestra|orchestral|drum|bass|chord)\b/i;

// Every gate a track has to pass, in one place, so a reviewer can read the rules rather than find them. Strict on
// purpose: there is always the made bed underneath, so throwing a doubtful track away costs nothing.
export function keep(found: Found, seconds: number): boolean {
  if (!found.url || !/^https:\/\//.test(found.url)) return false;
  const said = `${found.title} ${found.where}`;
  if (NOT_MUSIC.test(said)) return false;
  if (!IS_MUSIC.test(said)) return false;
  // Long enough to be a piece of music, and short enough that fetching it is not an afternoon. A film may be longer
  // than its bed — the bed simply goes round again — but a nine-second clip looped six times is a ringtone.
  if (found.seconds < Math.max(20, Math.min(seconds, 45))) return false;
  if (found.seconds > 20 * 60) return false;
  return true;
}

// How much a track sounds like the mood it was asked for, counted in the only evidence there is: its own words. Every
// word of every search term this mood would use, found in the title or the tags, is a point.
export function fits(found: Found, mood: Mood): number {
  const said = `${found.title} ${found.where}`.toLowerCase();
  let score = 0;
  // Words of five letters or more only. "loop" and "pop" are in half the terms and in half the library, so counting
  // them counts nothing: what separates a guitar loop from a drum loop is the word "guitar".
  for (const term of SHAPES[mood].terms) for (const word of term.split(' ')) if (word.length > 4 && said.includes(word)) score += 1;
  return score;
}

type Raw = Record<string, unknown>;
// A field that is a word, whatever the search decided to send it as: these APIs write an id as a string in one place
// and a number in the next.
const text = (value: unknown, fallback = '') => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
};

// Openverse's own fields, read defensively: a field that is missing is a field this cannot judge, and anything it
// cannot judge about a licence is thrown away rather than assumed.
export function openverseResults(body: unknown, seconds: number): Found[] {
  const results = (body as { results?: Raw[] })?.results;
  if (!Array.isArray(results)) return [];
  const found: Found[] = [];
  for (const one of results) {
    const licence = licenceOf(one.license, one.license_version);
    if (!licence) continue;
    const tags = Array.isArray(one.tags) ? (one.tags as Raw[]).map((tag) => text(tag?.name)).join(' ') : '';
    // Openverse counts a track's length in milliseconds.
    const milliseconds = Number(one.duration);
    const bitRate = Number(one.bit_rate);
    const sampleRate = Number(one.sample_rate);
    const ext = text(one.filetype, 'mp3').toLowerCase();
    // A lossy file under ninety-six kilobits is a file somebody has already thrown away half of.
    if (Number.isFinite(bitRate) && bitRate > 0 && bitRate < 96_000 && /mp3|ogg|opus|m4a/.test(ext)) continue;
    if (Number.isFinite(sampleRate) && sampleRate > 0 && sampleRate < 32_000) continue;
    const candidate: Found = {
      id: `openverse-${text(one.id, String(found.length))}`,
      title: text(one.title, 'Untitled'),
      by: text(one.creator, 'unknown'),
      licence: licence.name,
      credit: licence.credit,
      source: text(one.foreign_landing_url, text(one.url)),
      url: text(one.url),
      seconds: Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds / 1000 : 0,
      ext: /^(mp3|ogg|wav|flac|oga|opus|m4a)$/.test(ext) ? ext : 'mp3',
      where: `${tags} ${text(one.category)}`,
    };
    if (keep(candidate, seconds)) found.push(candidate);
  }
  return found;
}

// Freesound is the optional tier: it wants a free key, which is a thing the founder has to go and get, so nothing
// depends on it. Its filter already asks for CC0 only, and the licence field is checked again anyway.
export function freesoundResults(body: unknown, seconds: number): Found[] {
  const results = (body as { results?: Raw[] })?.results;
  if (!Array.isArray(results)) return [];
  const found: Found[] = [];
  for (const one of results) {
    const said = text(one.license).toLowerCase();
    // Freesound writes its licences as URLs: `.../publicdomain/zero/1.0/`.
    const code = /publicdomain\/zero/.test(said) ? 'cc0' : /licenses\/by\/[\d.]+\/?$/.test(said) ? 'by' : said;
    const licence = licenceOf(code);
    if (!licence) continue;
    const candidate: Found = {
      id: `freesound-${text(one.id, String(found.length))}`,
      title: text(one.name, 'Untitled'),
      by: text(one.username, 'unknown'),
      licence: licence.name,
      credit: licence.credit,
      source: `https://freesound.org/s/${text(one.id)}/`,
      url: text((one.previews as Raw | undefined)?.['preview-hq-mp3']),
      seconds: Number(one.duration) || 0,
      ext: 'mp3',
      where: `${Array.isArray(one.tags) ? (one.tags as string[]).join(' ') : ''} music`,
    };
    if (keep(candidate, seconds)) found.push(candidate);
  }
  return found;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The cache: a folder of tracks and one JSON file saying, for each of them, exactly what it is and on what terms.
// That file is the record of credit. It is written before the film is, and it outlives the film.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Kept = Found & { file: string; mood: Mood; fetched: string };
type Index = { tracks: Kept[] };

const safeName = (id: string) => id.replace(/[^a-z0-9-]+/gi, '-').slice(0, 80);

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function createMusic(deps: { cacheDir: string; env?: NodeJS.ProcessEnv; http?: typeof fetch }): Music {
  const env = deps.env ?? process.env;
  const http = deps.http ?? fetch;
  const dir = join(deps.cacheDir, 'music');
  const indexAt = join(dir, 'index.json');
  const creditsAt = join(dir, 'CREDITS.md');
  let picks = 0;

  const readIndex = async (): Promise<Index> => {
    try {
      const read = JSON.parse(await readFile(indexAt, 'utf8')) as Index;
      return { tracks: Array.isArray(read.tracks) ? read.tracks : [] };
    } catch { return { tracks: [] }; }
  };
  // Written through a temporary name, as the boards and the sidecars are, so a crash never leaves half an index.
  const writeIndex = async (index: Index) => {
    await mkdir(dir, { recursive: true });
    await writeFile(`${indexAt}.tmp`, JSON.stringify(index, null, 2));
    await rename(`${indexAt}.tmp`, indexAt);
    const lines = index.tracks.map((one) => `| ${one.title} | ${one.by} | ${one.licence} | ${one.source} | ${one.fetched.slice(0, 10)} |`);
    await writeFile(creditsAt, [
      '# Music this app has fetched, and on what terms',
      '',
      'Every track below was fetched from its own host onto this machine because its stated licence allows a founder',
      'to sell the film it is under. Nothing here is redistributed by this repository. A row whose licence says the',
      'author must be credited has to be named in the film or its description; the Video studio says so on the card',
      'when it uses one.',
      '',
      '| track | by | licence | where it came from | fetched |',
      '| --- | --- | --- | --- | --- |',
      ...lines,
      '',
    ].join('\n'));
  };

  async function search(mood: Mood, seconds: number, signal?: AbortSignal): Promise<Found[]> {
    if (env.STAGE_NO_MUSIC_SEARCH === '1') return [];
    const terms = SHAPES[mood].terms;
    const found: Found[] = [];
    const seen = new Set<string>();
    const add = (list: Found[]) => { for (const one of list) if (!seen.has(one.id)) { seen.add(one.id); found.push(one); } };
    const timeout = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT)]) : AbortSignal.timeout(SEARCH_TIMEOUT));
    for (const term of terms.slice(0, 3)) {
      // Asked for exactly what may be used, and asked the way the API really behaves rather than the way it reads.
      // Three things were measured against the live service before this line was written:
      //  · `category=music` and `license=cc0` together return **nothing**. Everything Openverse files under `music`
      //    is Jamendo, and Jamendo is by / by-sa / by-nc-nd — none of which a founder may sell a film under. The
      //    public-domain music is filed with no category at all, so the category is left off and the sorting out
      //    is done here, in `keep`.
      //  · The CC0 audio all comes from Freesound or Wikimedia, and Wikimedia's is anthems, recitations and MIDI.
      //    So Freesound is named: it is where the beds actually are.
      //  · `length` takes `shortest|short|medium|long`, and `long` reaches fifty-five minutes. A bed is a short or a
      //    medium. Anonymously, twenty results a page is the ceiling, twenty searches a minute and two hundred a day.
      const url = `${OPENVERSE}?${new URLSearchParams({
        q: term, license: 'cc0,pdm', source: 'freesound', length: 'short,medium',
        page_size: '20', mature: 'false', filter_dead: 'true',
      })}`;
      try {
        const answer = await http(url, { headers: { accept: 'application/json', 'user-agent': AGENT }, signal: timeout() });
        if (!answer.ok) continue;
        add(openverseResults(await answer.json(), seconds));
      } catch { /* the made bed is underneath; a search that fails is not an error */ }
      if (found.length >= 12) break;
    }
    const key = env.FREESOUND_API_KEY?.trim();
    if (key && found.length < 4) {
      const url = `${FREESOUND}?${new URLSearchParams({
        query: terms[0], filter: 'license:"Creative Commons 0" duration:[30 TO 600]',
        fields: 'id,name,username,license,duration,tags,previews', page_size: '20',
      })}`;
      try {
        const answer = await http(url, { headers: { accept: 'application/json', authorization: `Token ${key}` }, signal: timeout() });
        if (answer.ok) add(freesoundResults(await answer.json(), seconds));
      } catch { /* optional by design */ }
    }
    // A search matches on any word of the term, so asking for a warm acoustic loop comes back with drum loops as
    // happily as with guitars. Anything that claims none of the mood's own words is dropped outright when enough
    // that do are left — and what remains is sorted by needing no credit first (a film with nothing to say at the
    // end is a better film), then by how much of the mood it claims.
    const strong = found.filter((one) => fits(one, mood) > 0);
    const list = strong.length >= 3 ? strong : found;
    return list.sort((a, b) => Number(a.credit) - Number(b.credit) || fits(b, mood) - fits(a, mood));
  }

  async function download(found: Found, signal?: AbortSignal): Promise<Buffer> {
    const answer = await http(found.url, {
      headers: { 'user-agent': AGENT },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)]) : AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!answer.ok) throw new Error(`the track answered ${answer.status}`);
    const bytes = Buffer.from(await answer.arrayBuffer());
    if (!bytes.length) throw new Error('the track came back empty');
    // Forty megabytes is a generous ten minutes of music; anything larger is a mistake, not a bed.
    if (bytes.length > MAX_BYTES) throw new Error('the track is far larger than a bed should be');
    return bytes;
  }

  // A fetched track cut to the film: looped if it is short, cut where the film ends, brought to the same level the
  // made bed is brought to, and handed over as a WAV so the beat finder and ffmpeg both read it without argument.
  async function fit(from: string, seconds: number, signal?: AbortSignal): Promise<Buffer> {
    const to = join(dir, `fit-${Date.now().toString(36)}.wav`);
    await ff(FFMPEG, [
      '-y', '-loglevel', 'error', '-stream_loop', '-1', '-i', from, '-t', seconds.toFixed(2),
      '-af', `afade=t=in:st=0:d=0.02,afade=t=out:st=${Math.max(0, seconds - 0.02).toFixed(2)}:d=0.02,loudnorm=I=${TARGET_LUFS}:TP=-2:LRA=11`,
      '-ac', '2', '-ar', String(RATE), '-c:a', 'pcm_s16le', to,
    ], signal, 180);
    const bytes = await readFile(to);
    await rm(to, { force: true }).catch(() => {});
    // ffmpeg's own `loudnorm` in one pass is an estimate — on a quiet pad it landed four decibels under, which under
    // a narrator is the difference between a bed and nothing at all. So it is measured again here, exactly, and
    // corrected with a single gain. The made bed goes through the same meter, so both arrive at the same level.
    const { left, right, rate } = pcmOf(bytes);
    if (!left.length) throw new Error('the track came back as something ffmpeg could not make a bed of');
    toLevel(left, right, TARGET_LUFS, rate);
    return wavOf(left, right, rate);
  }

  return {
    async bed(ask, help) {
      const mood: Mood = isMood(ask.mood) ? ask.mood : 'calm';
      const seconds = Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, Number(ask.seconds) || 20));
      // Films made one after the other must not all be scored with the same track. The founder can pin the dice with
      // STAGE_MUSIC_SEED when they want the same bed twice — a re-render of the same film, usually.
      picks += 1;
      const seed = hashOf(`${env.STAGE_MUSIC_SEED ?? `${Date.now()}-${picks}`}:${mood}:${Math.round(seconds)}`);
      const dice = diceOf(seed);
      const index = await readIndex();
      const already = index.tracks.filter((one) => one.mood === mood);

      if (env.STAGE_NO_MUSIC_SEARCH !== '1') {
        try {
          help.report(`looking for ${mood} music nobody minds you selling…`);
          const found = await search(mood, seconds, help.signal);
          // Anything already on this machine is free and instant; anything found is a fetch. Both go in the hat, with
          // what is here weighted a little, so the second film on a plane still has a bed and the tenth is not the
          // same as the first.
          const hat: (Found | Kept)[] = [...already, ...found.filter((one) => !index.tracks.some((kept) => kept.id === one.id))]
            .sort((a, b) => Number(a.credit) - Number(b.credit) || fits(b, mood) - fits(a, mood));
          if (hat.length) {
            // Out of the best handful rather than the best one: a bed that fits and a bed that is the same every time
            // are different things, and the founder wants the first without the second.
            const short = hat.slice(0, PICK_FROM);
            const pick = short[Math.floor(dice() * short.length) % short.length];
            const kept = 'file' in pick ? pick : null;
            let file = kept?.file ?? '';
            if (!kept) {
              help.report(`fetching "${pick.title}" by ${pick.by} — ${pick.licence}`);
              const bytes = await download(pick, help.signal);
              await mkdir(dir, { recursive: true });
              file = join(dir, `${safeName(pick.id)}.${pick.ext}`);
              await writeFile(file, bytes);
              await writeIndex({ tracks: [...index.tracks, { ...pick, file, mood, fetched: new Date().toISOString() }].slice(-120) });
            }
            const bytes = await fit(file, seconds, help.signal);
            const timing = beatsOf(monoOf(bytes).samples, RATE, seconds);
            const credit: Credit = { title: pick.title, by: pick.by, licence: pick.licence, source: pick.source };
            help.report(pick.credit
              ? `music: "${credit.title}" by ${credit.by} — ${credit.licence}. Name them in the film or its description.`
              : `music: "${credit.title}" by ${credit.by} — ${credit.licence}.`);
            return { ext: 'wav', bytes, credit, bpm: timing?.bpm, beats: timing?.beats };
          }
          help.report('nothing found that a founder could sell a film under; writing a bed here instead');
        } catch (error) {
          // Never a failure: the bed below needs no network, no key and no ffmpeg.
          help.report(`could not use a found track (${(error as Error).message}); writing a bed here instead`);
        }
      }

      const made = makeBed(mood, seconds, seed, ask.bpm);
      const credit = madeCredit(mood, made.bpm);
      help.report(`music: ${article(mood)} ${mood} bed written here at ${made.bpm} beats a minute — ${credit.licence}`);
      return { ext: 'wav', bytes: made.bytes, credit, bpm: made.bpm, beats: made.beats };
    },
  };
}

// Never the network, never ffmpeg, never a second of waiting: the bed the tests and the fake-model runs get. It is
// the real synthesiser at four seconds, so what a test hears is what a film gets, only shorter.
export const fakeMusic: Music = {
  async bed(ask, help) {
    const mood: Mood = isMood(ask.mood) ? ask.mood : 'calm';
    const seconds = Math.max(MIN_SECONDS, Math.min(60, Number(ask.seconds) || 8));
    help.report(`music: ${article(mood)} ${mood} bed written here`);
    const made = makeBed(mood, seconds, hashOf(`fake:${mood}:${seconds}`), ask.bpm);
    return { ext: 'wav', bytes: made.bytes, credit: madeCredit(mood, made.bpm), bpm: made.bpm, beats: made.beats };
  },
};
