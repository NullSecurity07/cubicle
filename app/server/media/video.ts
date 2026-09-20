import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { Card, MediaAsset, Shape, Stage } from '../../shared/model.ts';
import { CHROMES } from '../browser.ts';
import { projectDir } from '../coder.ts';
import { musicBed, MOODS, SFX_DIR, sfxFile, type Mood } from './audio.ts';
import { fakeMusic, type Credit, type Music, type Mood as MusicMood } from './music.ts';
import { noClips, type Clips } from './clips.ts';
import { headlineOf, repair, trimTo, type Want } from './critic.ts';
import { liftFor, meanLight, scrimFor } from './contrast.ts';
import {
  bibleFor, direct, faceIn, layoutsFor, narratorWanted, onCamera, photograph, readBrief, tellOf, understandingOf,
  type Asked, type Material, type Understanding,
} from './director.ts';
import { checkCut, cuttingFor, editFilm, type Edit, type Shot as Cut, type Take } from './editor.ts';
import { ff, ffReady, FFMPEG } from './ff.ts';
import { fitStill, normalise } from './footage.ts';
import { cachedImages, DRAWN_BEFORE, mayDrawHere, outOfPictures } from './image.ts';
import type { Maker, Piece } from './jobs.ts';
import { availableRam, availableSwap, MINUTES_EACH, needsRam, roomToFilm as room } from './local-clips.ts';
import {
  AI_LAYOUTS, content, isPurpose, MAX_AI, MAX_LOCAL_AI, PURPOSE, PURPOSES,
  crowdsCaptions, fallbackOf, saysWhatItShows, withinCaps, type Spec,
} from './spec.ts';
import { broll, type Stock } from './stock.ts';
import {
  afforded, drawnAs, lineUnder, shareOut, shotKey, slotsFor, type Slot, type Visual,
} from './visuals.ts';
import { isDraft, makingWords, secondsEach } from '../../shared/film-time.ts';
import { filmMemory, storyboardKey, subjectKey, type KeptSubject } from './remembered.ts';
import { sourcesOf } from './grounding.ts';
import { readProject, VIEWPORTS } from './sources.ts';
import {
  composition, FORMATS, isPack, PACE, PACK, PACKS, PACES, paintOf, projectFile, sceneSeconds, snapToBeats,
  type Pace, type Pack, type Shot,
} from './templates/index.ts';
import { timeWords, type Part, type Word } from './timings.ts';
import { castLine, castVoice, isVoice, VOICES, wavSeconds } from './voice.ts';

// The spec vocabulary lives in `spec.ts` now, so the director and the critic can share it without importing the
// whole renderer. Everything that used to be here is still here, by the same names.
export {
  LAYOUTS, AI_LAYOUTS, MAX_SCENES, MAX_IMAGES, MAX_AI, MAX_LOCAL_AI, MAX_BACKGROUNDS, LENGTHS, PURPOSES, PURPOSE,
  isPurpose, parseSpec, scenesFor, wordsFor, withinCaps, withinLength, fallbackOf, WORDS_A_SECOND, budgetOf,
  type Layout, type Scene, type Spec, type Purpose,
} from './spec.ts';
export { FRAMES } from './templates/index.ts';
export type { Material, Understanding } from './director.ts';

export const SETUP_HINT = 'No video renderer is set up. The founder installs Chrome and ffmpeg — both are free — and restarts the app.';

// The bed under a film is written by `media/music.ts`, which is asked for a mood and a length and hands back a
// finished loop at −23 LUFS with its own beats and its own credit. Nothing about it is decided here.
export type { Credit, Music } from './music.ts';

// Where Chrome is on this machine. The renderer takes it by name in the environment, not as a flag.
export const chromePath = (): string | null => CHROMES.find((path) => existsSync(path)) ?? null;

type Ran = { code: number; out: string };
function run(command: string, args: string[], at: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: at, env: { ...process.env, HYPERFRAMES_BROWSER_PATH: chromePath() ?? '', NO_COLOR: '1' } });
    let out = '';
    let rest = '';
    const read = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      out += text;
      rest += text;
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) onLine(line.replace(/\[[0-9;]*m/g, '').trim());
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    const stop = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', fail);
    child.on('close', (code) => { signal?.removeEventListener('abort', stop); done({ code: code ?? 1, out: out.replace(/\[[0-9;]*m/g, '') }); });
  });
}

// A handful of slow things at a time rather than all of them: a dozen pictures asked for at once is a dozen refusals.
export async function pool<T>(jobs: (() => Promise<T>)[], most = 3): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const hands = Array.from({ length: Math.min(most, jobs.length) }, async () => {
    for (let mine = next++; mine < jobs.length; mine = next++) out[mine] = await jobs[mine]();
  });
  await Promise.all(hands);
  return out;
}

// What a video studio was asked for: the brief in `prompt`, everything the founder set on the card — where 'auto' and
// nothing at all both mean "you decide" — and for a person who wrote one, the storyboard itself.
export type VideoAsk = {
  prompt: string; format?: string; look?: string; narrate?: boolean; spec?: Spec; cardId?: string;
  purpose?: string; length?: number | string; pace?: string; music?: string; sfx?: boolean; captions?: boolean;
  ai?: boolean | string; address?: string; voice?: string; person?: boolean;
  // How long the founder is willing to wait: 'draft' is the film to look at before the film, 'full' and nothing are the film.
  speed?: string;
  // Who asked for the film. A person's own wires are the founder pointing at things just as much as the studio's
  // are, so what is joined to them is joined to the film.
  roomId?: string;
  // Pictures the caller named outright — paths a person got back from drawing one, or the word "latest".
  images?: string[];
};

// The other half of the studio: what it can read, what it can photograph, what it can film with.
export type VideoDeps = {
  dir: string; images?: Maker; voices?: Maker; think: (prompt: string) => Promise<string>;
  // Where drawn pictures are kept between runs, beside the voice model and the music. Without one they are kept in
  // the workspace, which still saves a second render of the same film.
  cacheDir?: string;
  // `clips` is every moving-picture backend as one; `local` is the one that runs here, which is what decides how many
  // such scenes a film may have and whether a person's call needs the founder's yes. `lipsync` is the narrower
  // thing: the backend that can move a real mouth to a real recording. Without one this studio shows no talking
  // person at all, so it is asked for by name rather than inferred from `clips`.
  clips?: Clips; local?: Clips; lipsync?: Clips; music?: Music; forbidden?: string[];
  // Real photographs somebody took, when a free key is set. Nothing breaks without one; the film draws instead.
  stock?: Stock;
  stage?: () => Promise<Stage>;
  assets?: (cardId: string) => Promise<MediaAsset[]>;
  // The pictures another studio card has already made, newest first: a wired image studio's work is the film's.
  // The words each was drawn from come with it, because they are the only description of the picture anybody has.
  pictures?: (cardId: string) => Promise<{ path: string; prompt: string }[]>;
  fileOf?: (path: string) => string;
  readDoc?: (id: string) => Promise<string>;
  readFile?: (path: string) => Promise<Buffer | null>;
  browser?: {
    shots(raw: string, want: { width: number; height: number; at: number[]; own?: boolean; file: (index: number) => string }, signal?: AbortSignal): Promise<string[]>;
    where(session: string): Promise<string | null>;
  };
};

// Which cards the founder joined to this one, in either direction: a wire has a head and a tail, but material flows
// both ways down it.
export const wiredTo = (stage: Stage, cardId: string): Card[] => {
  const ends = new Set((stage.wires ?? []).flatMap((wire) => (wire.from === cardId ? [wire.to] : wire.to === cardId ? [wire.from] : [])));
  return (stage.cards ?? []).filter((card) => ends.has(card.id));
};

// What kinds of card a person carries into a film they are asked to make. A founder who wires an image studio to
// Sam and then asks Sam for a film has already said which pictures to use; making them wire it a second time, to
// the video card as well, is a rule they have to learn rather than a thing that works.
const THEIRS = new Set<Card['kind']>(['imagegen', 'image', 'note', 'link', 'project']);

// Everything a film may draw on, found the way a founder would point at it rather than the way a graph is stored.
// Three reaches, in the order they matter: what is wired to the studio; what is wired to *that* — a picture card on
// a stage is usually fed by the studio that drew the picture, and the founder who joined them up meant the film to
// have it; and everything of that kind wired to whoever is making the film.
//
// This is the whole of what went wrong in a real run: an image studio fed a picture card, the picture card fed the
// video studio, and the film gathered nothing, because only the first reach existed.
export function sourcesFor(stage: Stage, cardId?: string, roomId?: string): Card[] {
  const found = new Map<string, Card>();
  const keep = (card: Card) => { if (card.id !== cardId && !found.has(card.id)) found.set(card.id, card); };
  const direct = cardId ? wiredTo(stage, cardId) : [];
  for (const card of direct) keep(card);
  // One hop behind a picture card: the studio that feeds it.
  for (const card of direct) {
    if (card.kind !== 'image') continue;
    for (const behind of wiredTo(stage, card.id)) if (behind.kind === 'imagegen') keep(behind);
  }
  if (roomId) for (const card of wiredTo(stage, roomId)) if (THEIRS.has(card.kind)) keep(card);
  return [...found.values()];
}

// The documents a film may read: the ones wired to the studio, and the ones wired to whoever is making it.
export const docsFor = (stage: Stage, cardId?: string, roomId?: string): string[] => {
  const ends = new Set((stage.wires ?? []).flatMap((wire) => {
    if (wire.from === cardId || wire.from === roomId) return [wire.to];
    if (wire.to === cardId || wire.to === roomId) return [wire.from];
    return [];
  }));
  return (stage.docs ?? []).filter((doc) => ends.has(doc.id)).map((doc) => doc.id);
};

// Where each of a page's shots is taken from: the top, then what is under it, on a desktop and on a phone.
const SCROLLS = { desktop: [0, 780, 1700], mobile: [0, 900] };

// A picker the founder left on Auto is nothing at all; anything else is their decision and is obeyed.
const chose = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  (typeof value === 'string' && value !== 'auto' && (allowed as readonly string[]).includes(value) ? value as T : undefined);

// Where the words a picture model is handed are written is `media/visuals.ts` now, one picture a shot, out of the
// phrase being spoken under it. What used to be here — a subject cut out of a scene's headline, the nouns that
// summon lettering struck out of it, and a texture wherever a frame was already full of type — is all in there,
// with a critic over it that no single function could have.

// About how long this is going to take, said before it starts rather than found out. Nothing here is precise; it is
// honest, which is what a founder watching a spinner actually needs.
export function estimate(ask: { scenes: number; seconds: number; pictures: number; clips: number; narrate: boolean; here?: boolean; draft?: boolean }): string {
  // The sum itself is in `shared/film-time.ts`, so the card says the same minutes before Make is pressed.
  return makingWords(ask);
}

// A few slow things at a time, for work that turns up as it is found rather than as one list. The pictures of a
// film start being drawn while its narration is still being listened back to, and a few more may be asked for
// once the cut is measured; both lots go through the same pair of hands.
export function hands(most: number): <T>(job: () => Promise<T>) => Promise<T> {
  let busy = 0;
  const waiting: (() => void)[] = [];
  return async (job) => {
    // A place is handed straight to whoever is waiting rather than given up and taken again, so nobody who
    // arrives in between can slip into it.
    if (busy >= most) await new Promise<void>((go) => waiting.push(go));
    else busy += 1;
    try { return await job(); } finally {
      const next = waiting.shift();
      if (next) next(); else busy -= 1;
    }
  };
}

// The renderer: our own scenes written as one HTML page, which headless Chrome steps through frame by frame and ffmpeg
// turns into an MP4. Nothing leaves this machine except what the founder wired to the card, and the same storyboard
// always renders the same film.
// What a named asset really is, and where. `where` says whether the file already sits in this job's own assets
// folder (a screenshot we just took, a picture copied off a wired card) or out in the shared files.
export type Held = { file: string; kind: 'screen' | 'video' | 'image' | 'audio'; where: 'job' | 'files'; seconds?: number };

// Everything wired to the card, read once: the product's own words and colours, its screens as pictures, the
// founder's own files, the pictures a wired image studio has already drawn, and whatever a note or a doc beside it
// says. A wire is the founder saying "use this", so none of it has to be asked for.
export async function gather(deps: VideoDeps, asked: VideoAsk, at: string, report: (line: string) => void, signal?: AbortSignal) {
    const material: Material = { lines: [], assets: [], using: [] };
    // What the storyboard may name in `asset`. `where` says whether the file already sits in this job's own assets
    // folder (a screenshot we just took) or in the shared files (something the founder dropped).
    const files = new Map<string, Held>();
    const stage = await deps.stage?.().catch(() => undefined);
    const cards = stage ? sourcesFor(stage, asked.cardId, asked.roomId) : [];
    const addresses: { url: string; own: boolean; label: string }[] = [];
    if (asked.address?.trim()) addresses.push({ url: asked.address.trim(), own: true, label: asked.address.trim() });

    for (const card of cards) {
      try {
        if (card.kind === 'project' && card.path) {
          const product = await readProject(projectDir(card.path, deps.forbidden ?? []));
          if (product.words) material.lines.push(product.words);
          if (product.pitch) material.pitch = product.pitch;
          if (product.brand.colours.length || product.brand.font) material.brand = product.brand;
          material.using.push(`${product.name ?? 'the'} project`);
          if (product.font) await writeFile(join(at, 'vendor', product.font.name), product.font.bytes);
          if (product.logo && /\.(png|jpe?g|webp)$/i.test(product.logo.name)) {
            await writeFile(join(at, 'assets', `logo-${product.logo.name}`), product.logo.bytes);
            files.set('logo', { file: `logo-${product.logo.name}`, kind: 'image', where: 'job' });
          }
          // A project with nobody's browser wired to it still has pictures of itself in it — the ones its README
          // shows off with. They are screens, so a device scene may hold one, and a film about a product gets to
          // show the product rather than an abstract picture of one.
          for (const screen of product.screens) {
            const name = `screen-repo-${material.assets.filter((one) => one.kind === 'screen').length + 1}`;
            const file = `${name}${extname(screen.name).toLowerCase() || '.png'}`;
            await writeFile(join(at, 'assets', file), screen.bytes);
            files.set(name, { file, kind: 'screen', where: 'job' });
            material.assets.push({ name, kind: 'screen', what: screen.what });
          }
          if (product.screens.length) material.using.push(`${product.screens.length} screenshot${product.screens.length === 1 ? '' : 's'} out of the project`);
        } else if (card.kind === 'link' && card.url) addresses.push({ url: card.url, own: false, label: card.url });
        else if (card.kind === 'browser') {
          const where = await deps.browser?.where(`card-${card.id}`).catch(() => null);
          if (where && !/^about:/.test(where)) addresses.push({ url: where, own: false, label: where });
        } else if (card.kind === 'note' && card.text?.trim()) { material.lines.push(`A note on the stage:\n${card.text.slice(0, 1600)}`); material.using.push('a note'); }
        else if (card.kind === 'image' && card.path) {
          const bytes = await deps.readFile?.(card.path).catch(() => null);
          if (bytes) { const name = `picture-${files.size + 1}`; await writeFile(join(at, 'assets', `${name}.png`), bytes); files.set(name, { file: `${name}.png`, kind: 'image', where: 'job' }); material.assets.push({ name, kind: 'image', what: 'a picture the founder put on the stage — use it as a scene' }); }
        } else if (card.kind === 'imagegen') {
          // A picture studio wired to a video studio is a picture studio whose pictures belong in the film. The
          // founder does not have to say so: they drew a wire, and a wire is the saying.
          const drawn = await latestPictures(card.id);
          for (const [index, one] of drawn.entries()) {
            const name = `drawn-${files.size + 1}`;
            await writeFile(join(at, 'assets', `${name}.png`), one.bytes);
            files.set(name, { file: `${name}.png`, kind: 'image', where: 'job' });
            // The words it was drawn from are the only description of it anybody has, and they are what says
            // whether there is a person in it.
            material.assets.push({ name, kind: 'image', prompt: one.prompt, what: `a picture drawn in the image studio${index ? ' (an earlier one)' : ' (the latest)'}: ${one.prompt || 'no words were kept'}` });
          }
          if (drawn.length) material.using.push(`${drawn.length} picture${drawn.length === 1 ? '' : 's'} from the image studio`);
        }
      } catch (error) { report(`could not read ${card.kind === 'project' ? card.path : card.kind}: ${(error as Error).message}`); }
    }
    // Documents wired to the card are words, the same as a note is — and so are the ones wired to whoever asked.
    const readable = stage ? new Set(docsFor(stage, asked.cardId, asked.roomId)) : new Set<string>();
    for (const doc of stage?.docs ?? []) {
      if (!readable.has(doc.id)) continue;
      const text = await deps.readDoc?.(doc.id).catch(() => '');
      if (text?.trim()) { material.lines.push(`${doc.title}:\n${text.slice(0, 2400)}`); material.using.push(doc.title); }
    }

    // The product's own screens. Two addresses at most, and a handful of shots each: this is the slow part.
    for (const [index, address] of addresses.slice(0, 2).entries()) {
      if (!deps.browser) break;
      report(`photographing ${address.label}…`);
      for (const [size, box] of Object.entries(VIEWPORTS)) {
        const scrolls = SCROLLS[size as keyof typeof SCROLLS];
        const taken = await deps.browser.shots(address.url, {
          ...box, own: address.own, at: scrolls,
          file: (one) => join(at, 'assets', `screen-${index}-${size}-${one}.png`),
        }, signal).catch((error: Error) => { report(`${address.label} could not be photographed: ${error.message}`); return [] as string[]; });
        taken.forEach((file, one) => {
          const name = `screen-${index}-${size}-${one}`;
          files.set(name, { file: `${name}.png`, kind: 'screen', where: 'job' });
          material.assets.push({ name, kind: 'screen', what: `${size === 'mobile' ? 'the phone view' : 'the desktop view'} of ${address.label}${scrolls[one] ? `, ${scrolls[one]}px down the page` : ', at the top'}` });
        });
      }
      if (material.assets.some((one) => one.kind === 'screen')) material.using.push(address.label);
    }

    // Pictures the caller named outright: a person who has just drawn one hands back the path it got, and a film
    // asked for that picture gets that picture. "latest" is the newest thing the wired image studio has drawn,
    // which is what somebody means when they say "use the one you just made".
    for (const named of asked.images ?? []) {
      const want = named.trim();
      if (!want || want.toLowerCase() === 'latest') continue;
      if (material.assets.some((one) => one.what.includes(want))) continue;
      const bytes = await deps.readFile?.(want).catch(() => null);
      if (!bytes) { report(`there is no picture at ${want}, so the film was made without it`); continue; }
      const name = `given-${files.size + 1}`;
      await writeFile(join(at, 'assets', `${name}.png`), bytes);
      files.set(name, { file: `${name}.png`, kind: 'image', where: 'job' });
      material.assets.push({ name, kind: 'image', what: `a picture you were given to use: ${want}` });
      material.using.push('a picture you were handed');
    }

    // The founder's own footage, already on the card, normalised into the film's own frame when it is used.
    const dropped = asked.cardId ? await deps.assets?.(asked.cardId).catch(() => []) ?? [] : [];
    for (const asset of dropped) {
      files.set(asset.name, { file: asset.path, kind: asset.kind, where: 'files', seconds: asset.seconds });
      if (asset.kind === 'audio') continue;
      material.assets.push({ name: asset.name, kind: asset.kind, what: asset.kind === 'video' ? `${Math.round(asset.seconds ?? 0)} seconds of the founder's own footage` : "a picture the founder dropped on the card" });
    }
    const clipCount = dropped.filter((one) => one.kind === 'video').length;
    if (clipCount) material.using.push(`${clipCount} of your clip${clipCount === 1 ? '' : 's'}`);
    const bed = dropped.find((one) => one.kind === 'audio');
    return { material, files, bed };

    // The pictures a wired image studio has made, newest first. Its results live in the same sidecar every studio
    // card keeps, which is `assets` on the card for dropped files and `results` for made ones.
    async function latestPictures(cardId: string): Promise<{ bytes: Buffer; prompt: string }[]> {
      const made = (await deps.pictures?.(cardId).catch(() => [])) ?? [];
      const found: { bytes: Buffer; prompt: string }[] = [];
      for (const one of made.slice(0, 3)) {
        const bytes = await deps.readFile?.(one.path).catch(() => null);
        if (bytes) found.push({ bytes, prompt: one.prompt ?? '' });
      }
      return found;
    }
}

export function hyperframesVideos(deps: VideoDeps): Maker {
  const bin = resolve(import.meta.dirname, '../../node_modules/.bin/hyperframes');
  const vendor = resolve(import.meta.dirname, 'templates/vendor');
  const clips = deps.clips ?? noClips;

  return {
    name: 'Hyperframes',
    ready: () => (chromePath() ? null : SETUP_HINT),
    async make(ask, { report, signal }): Promise<Piece> {
      const asked = ask as VideoAsk;
      const at = join(deps.dir, '.video', Date.now().toString(36));
      try {
        await mkdir(join(at, 'assets'), { recursive: true });
        await mkdir(join(at, 'vendor'), { recursive: true });

        // Everything the founder decided, and nothing they did not. What is still open the director reads out of the
        // brief itself, one pass at a time, saying each decision on the card as it makes it.
        const told: Asked = {
          brief: asked.prompt,
          purpose: chose(asked.purpose, PURPOSES),
          seconds: typeof asked.length === 'number' && Number.isFinite(asked.length) ? asked.length : undefined,
          shape: chose(asked.format, ['wide', 'tall', 'square'] as const),
          pace: chose(asked.pace, PACES),
          pack: chose(asked.look, PACKS),
          music: chose(asked.music, MOODS),
          captions: asked.captions,
          person: asked.person,
        };
        // The founder's AI-clips switch: on, off, or theirs to work out.
        const wantsAi = asked.ai === true || asked.ai === 'on';
        const autoAi = asked.ai === 'auto' || asked.ai === undefined;
        const here = !!deps.local && !deps.local.ready();
        // A draft is the film to look at before the film: a few small pictures shared across the shots, nothing
        // moving drawn for it, and a quick encode. What it says and how it is cut are exactly the full film's.
        const draft = isDraft(asked.speed);
        const memory = filmMemory(deps.cacheDir ? join(deps.cacheDir, 'films') : undefined);

        const { material, files, bed } = await gather(deps, asked, at, report, signal);
        if (material.using.length) report(`using: ${material.using.join(', ')}`);

        // A person who wrote the whole storyboard is not overruled about what is in it, only about how it is set —
        // but it is read by the same editor as the director's own work. A storyboard written by somebody in a chat
        // used to go straight to the renderer, which is exactly how the founder's own film came back as three
        // talking-head scenes with no variety, no length check and nothing grounding them. The rules do not care
        // who wrote the scenes.
        let understanding: Understanding;
        let spec: Spec;
        let bible: string;
        // The one idea the film turns on, which every picture in it is drawn against. A storyboard handed over
        // whole has no plan behind it, so the brief itself stands in for one.
        let angle = asked.prompt.slice(0, 160);
        const mayUseAi = !draft && (wantsAi || (autoAi && here));
        if (draft && wantsAi) report('this is a draft, so nothing moving is drawn for it — the full film has the moving shots');
        // Whether anything can really move a mouth to a recording right now. It is the only thing that lets a
        // person speak on camera in one of these films, and a film never fakes it.
        const lipsync = !!deps.lipsync && !deps.lipsync.ready() && mayUseAi;
        if (asked.spec) {
          understanding = understandingOf({}, told, readBrief(asked.prompt));
          bible = bibleFor(understanding);
          spec = asked.spec;
          if (spec.pace) understanding.pace = spec.pace;
          if (spec.pack) understanding.pack = spec.pack;
          if (spec.music) understanding.mood = spec.music;
          if (spec.captions !== undefined) understanding.captions = spec.captions;
          report(tellOf(understanding));
          const want: Want = {
            seconds: understanding.seconds, pace: understanding.pace, purpose: understanding.purpose,
            captions: understanding.captions, bible, layouts: layoutsFor({ ai: mayUseAi, lipsync, material }),
            reel: understanding.purpose === 'reel' || understanding.purpose === 'ad',
            product: material.lines.length > 0 || material.assets.length > 0 || !!material.brand,
            sources: sourcesOf(material, asked.prompt),
            screens: material.assets.filter((one) => one.kind === 'screen').map((one) => one.name),
            person: understanding.person,
          };
          const mended = repair(spec, want);
          spec = mended.spec;
          for (const line of mended.notes.slice(0, 5)) report(line);
        } else {
          // A full film asked for straight after its draft is that film, not a second opinion: it is made from
          // the storyboard the founder has just watched. Anything else — the same speed again, a changed brief, a
          // new wire — is directed afresh, because pressing Make again has always meant "show me another".
          const key = storyboardKey({ brief: asked.prompt, told, lines: material.lines, assets: material.assets.map((one) => one.name) });
          const watched = await memory.storyboard<Awaited<ReturnType<typeof direct>>>(asked.cardId, key, draft ? 'draft' : 'full');
          if (watched) report('this is the draft you watched, now made in full: the same storyboard, every shot its own picture');
          const directed = watched ?? await direct(told, material, deps.think, { report, ai: mayUseAi, lipsync });
          if (watched) report(tellOf(directed.understanding));
          else await memory.keepStoryboard(asked.cardId, { key, speed: draft ? 'draft' : 'full', directed });
          understanding = directed.understanding;
          spec = directed.spec;
          bible = directed.bible;
          angle = directed.plan.angle || angle;
        }
        const shape: Shape = understanding.shape;
        const pack: Pack = isPack(understanding.pack) ? understanding.pack : 'clean';
        const pace: Pace = understanding.pace;
        const seconds = understanding.seconds;
        const mood: Mood = understanding.mood;
        const captions = understanding.captions;
        const sfx = asked.sfx !== false;

        // The fonts this pack sets its words in, and rough.js when the pack draws by hand.
        for (const file of [...new Set(PACK[pack].fonts.map((one) => one.file))]) await copyFile(join(vendor, file), join(at, 'vendor', file));
        await copyFile(join(vendor, 'gsap.min.js'), join(at, 'vendor', 'gsap.min.js'));
        if (pack === 'sketch') await copyFile(join(vendor, 'rough.js'), join(at, 'vendor', 'rough.js'));

        const brand = pack === 'brand' ? material.brand : undefined;
        if (pack === 'brand' && !brand) report('no product colours were found, so the film is set in the clean look');

        const able = mayUseAi && !clips.ready();
        if (wantsAi && !able) report(`AI clips are switched on but not ready: ${clips.ready()}`);
        const { spec: capped, notes } = withinCaps(spec, { ai: able, assets: [...files.keys()], most: here ? MAX_LOCAL_AI : MAX_AI });
        spec = capped;
        for (const note of notes) report(note);
        // Only now is it settled whether there is really a person in this film: a clip scene that was written and
        // then could not be made is not somebody on camera, and the brief asked for somebody on camera. Whether
        // this machine can film one is asked here and now, because what a computer can spare changes minute to
        // minute and a clip that leans on swap takes an hour instead of three minutes.
        const spare = here && able ? await availableRam() : null;
        // Memory and swap together, because a machine leaning on swap makes the clip slowly rather than not at all —
        // and a founder refused at 21 GB when 22 was wanted has been told no for a gigabyte.
        const filming = here && able ? room({ ram: spare, swap: await availableSwap(), needs: needsRam() }) : { answer: 'no' as const, line: '' };
        const roomToFilm = here && able && filming.answer !== 'no';
        if (understanding.person && here && able && filming.line) report(filming.line);
        // A real picture of a real person, already on the card, is who the film puts on camera. Nothing is drawn and
        // nothing is filmed for a face the founder has already made.
        const face = faceIn(material);

        // Casting, which is one decision and is made once. The voices the model really ships are read off the
        // weights themselves — gender, accent and the grade the model's own authors gave them — and the film takes
        // the best one that fits what the brief asked for. The founder's pick on the card overrules all of it.
        const table = await deps.voices?.cast?.().catch(() => undefined) ?? VOICES;
        const wanted = narratorWanted(asked.prompt, understanding);
        const narrator = isVoice(asked.voice) ? (table.find((one) => one.id === asked.voice) ?? castVoice(wanted, table)) : castVoice(wanted, table);
        if (asked.narrate !== false) report(castLine(narrator));
        // Whoever is on screen has to sound like themselves. The only description of a drawn or dropped picture
        // anybody has is the words it was drawn from, so that is what is read — and where it says a man and the
        // narrator is a woman, nobody goes on camera at all rather than the two being put together.
        const shownAs = narratorWanted([face && material.assets.find((one) => one.name === face)?.prompt,
          spec.scenes.map((one) => one.portrait_prompt).filter(Boolean).join(' ')].filter(Boolean).join(' ')).gender;
        spec = { ...spec, scenes: onCamera(spec.scenes, understanding, bible, report,
          { ready: lipsync, narratorGender: narrator.gender, personGender: shownAs }, face) };

        // Every drawn picture is filed under what was asked for, so the same film rendered twice draws nothing the
        // second time and a founder's daily quota lasts the week.
        const drawing = deps.images && !deps.images.ready()
          ? cachedImages(deps.images, deps.cacheDir ? join(deps.cacheDir, 'pictures') : join(deps.dir, '.cache', 'pictures'))
          : null;
        const saying = deps.voices && !deps.voices.ready() && asked.narrate !== false ? deps.voices : null;
        if (!drawing) report('no picture maker is set up, so the scenes are set on drawn backgrounds instead of photographs');
        const { width, height } = FORMATS[shape];
        // `null` here means ffmpeg answered; anything else is the line the founder is told instead.
        const noFf = await ffReady();
        if (noFf && (spec.scenes.some((scene) => scene.layout === 'footage') || mood !== 'none')) report(noFf);

        const wantsClips = spec.scenes.filter((scene) => AI_LAYOUTS.has(scene.layout)).length;
        // Where the next picture would really be drawn, asked of the makers themselves: a free service that still
        // has some of today left answers in four seconds, and this machine is only the answer once it has none.
        // It used to be "could this machine draw?", which said eleven minutes about a film that took two.
        const drawsHere = () => (deps.images?.next ? deps.images.next() === 'this computer' : mayDrawHere());
        const drawnHere = drawsHere();
        // How long this is going to take, said before it starts rather than found out. The number of pictures is a
        // guess until the film has been read aloud and cut — a scene is one shot or it is three — so it is said
        // again, exactly, the moment the shot list exists and before anything slow has happened.
        const guessed = drawing ? afforded(Math.round(spec.scenes.length * 1.6), drawnHere, 8, draft) : 0;
        report(`${draft ? 'a draft, ' : ''}${spec.scenes.length} scenes, ${estimate({ scenes: spec.scenes.length, seconds, pictures: guessed, clips: here ? wantsClips : 0, narrate: !!saying, here: drawnHere, draft })}`);
        report('cutting what you gave it and recording the narration…');
        const shots: Shot[] = spec.scenes.map((scene) => ({ scene, seconds: 0 }));
        const said = (index: number, line: string) => report(`scene ${index + 1}: ${line}`);

        // Everything a scene was handed is made ready first: the founder's own footage, the screenshots, the moving
        // shots. None of these depends on how the film is cut, and all of them decide how it is cut.
        const scenework = Promise.all(spec.scenes.map(async (scene, index) => {
          const shot = shots[index];
          // Where a named asset really is: in this job's assets already, or still out in the shared files. A phone film
          // wants the phone view of a page, whichever one the storyboard happened to name.
          const wanted = scene.layout === 'device' && shape === 'tall' && scene.asset?.includes('-desktop-')
            ? (files.has(scene.asset.replace('-desktop-', '-mobile-')) ? scene.asset.replace('-desktop-', '-mobile-') : scene.asset)
            : scene.asset;
          const named = wanted ? files.get(wanted) : undefined;
          const source = named ? (named.where === 'job' ? join(at, 'assets', named.file) : deps.fileOf?.(named.file) ?? named.file) : '';
          // A screenshot, a dropped picture or the product's own mark: already on disk, only the right shape away.
          if (named && named.kind !== 'video' && named.kind !== 'audio' && (scene.layout === 'device' || scene.layout === 'picture' || scene.layout === 'logo' || scene.layout === 'presenter')) {
            // A screenshot goes in whole: a device scene reads down the page it was taken of, so cropping it is wrong.
            if (named.kind === 'screen' && named.where === 'job') shot.image = named.file;
            else {
              shot.image = `fit-${index}.png`;
              await fitStill(source, join(at, 'assets', shot.image), width, height, signal)
                .catch(async () => { shot.image = `as-is-${index}.png`; await copyFile(source, join(at, 'assets', shot.image)).catch(() => { shot.image = undefined; }); });
            }
          }
          if (scene.layout === 'footage' && named) {
            const cut = `cut-${index}.mp4`;
            said(index, 'cutting your footage to the frame…');
            await (noFf ? Promise.reject(new Error(noFf)) : normalise({ from: source, to: join(at, 'assets', cut), width, height, start: scene.start, seconds: scene.seconds, mute: scene.mute, signal }))
              .then(() => { shot.video = cut; }, (error: Error) => { said(index, `that clip could not be used (${error.message}), so the scene is its words instead`); shot.scene = fallbackOf(scene); });
          }
          if (scene.layout === 'clip' && able) {
            try {
              said(index, 'making a few seconds of moving picture…');
              // A still first, so the clip looks like the rest of the film rather than like a different film.
              const still = drawing ? await drawing.make({ prompt: `${bible}. ${scene.clip_prompt!}`, shape }, { report: () => {}, signal }).then((one) => one.bytes, () => undefined) : undefined;
              const made = await clips.broll({ prompt: scene.clip_prompt!, image: still, seconds: scene.seconds ?? 4, shape }, { report: (line) => said(index, line), signal });
              shot.video = `clip-${index}.mp4`;
              await writeFile(join(at, 'assets', shot.video), made.bytes);
            } catch (error) {
              said(index, `the clip could not be made (${(error as Error).message}), so the scene is a picture instead`);
              shot.scene = fallbackOf(scene);
            }
          }
        }));

        // Somebody speaking on camera waits for the reading, because a mouth is matched to a recording and there
        // was no recording until now.
        const lipsyncWork = async () => {
          if (!lipsync) return;
          for (const [index, scene] of spec.scenes.entries()) {
            const shot = shots[index];
            // Somebody speaking on camera, and the only way this studio will make one: a real lip-sync backend,
            // handed the actual recording, moving the actual mouth to it. There is no second route and there is no
            // stand-in. A drawn person whose mouth moves to a separate recording is the single fastest way to make a
            // film read as generated, and the studio would rather show nobody at all — `onCamera` has already turned
            // these scenes into the faceless edit wherever no backend was standing by, so reaching here means one is.
            if (scene.layout === 'presenter' && lipsync) {
              try {
                said(index, 'making the person on screen say it…');
                const face = shot.image ? await readFile(join(at, 'assets', shot.image))
                  : drawing && scene.portrait_prompt ? (await drawing.make({ prompt: `${scene.portrait_prompt}, head and shoulders portrait, plain background, even light`, shape }, { report: () => {}, signal })).bytes
                    : null;
                if (!face) throw new Error('there is no face to use');
                // No recording, no lip sync, no person: a mouth cannot be matched to a line that was never said.
                const speech = shot.voice ? await readFile(join(at, 'assets', shot.voice.file)) : null;
                if (!speech?.length) throw new Error('there is no recording for the mouth to match');
                const about = material.assets.find((one) => one.name === scene.asset)?.prompt || scene.portrait_prompt;
                const made = await clips.presenter({ portrait: face, speech, about, shape }, { report: (line) => said(index, line), signal });
                shot.video = `pres-${index}.mp4`;
                await writeFile(join(at, 'assets', shot.video), made.bytes);
              } catch (error) {
                said(index, `nobody could be lip-synced (${(error as Error).message}), so the line is said over the film's own pictures instead`);
                shot.scene = fallbackOf(scene);
              }
            }
          }
        };

        // --- the narration, read once ---------------------------------------------------------------------------
        //
        // One recording for the whole film. It used to be one a scene, glued end to end, and that is audible: a
        // fresh breath at every join and the same flat stress on every sentence, because nothing reading a line
        // ever knew what came before it. Read in one go the voice rises, falls and hurries the way somebody
        // talking does — and there is one clock for the whole piece instead of a dozen that have to be added up.
        //
        // It happens here, before a single picture is drawn, and that order is the whole of phase three. Until now
        // the pictures were drawn first, from the scenes, which meant one picture a scene however many times the
        // editor cut inside it — a reel of five photographs where the shot list called for eleven, which is what
        // "one picture with the text swapped over it" actually was. The reading is what the cut is made against,
        // so the reading comes first, then the cut, and only then does anybody draw anything.
        //
        // The recording and the scene work above do not wait for each other any more. Nothing a scene is handed
        // decides what is said, and a moving shot drawn here is three minutes the voice used to spend doing nothing.
        const target = asked.spec ? 0 : seconds;
        const lines = spec.scenes.map((scene) => (scene.say ?? '').trim());
        const script = lines.filter(Boolean).join(' ');
        const scriptWords = script.split(/\s+/).filter(Boolean);
        let voice: { file: string; seconds: number } | undefined;
        let parts: Part[] = [];
        let words: Word[] = [];
        const recording = (async () => {
          if (!saying || !script) return;
          report('reading the whole film in one go…');
          try {
            const piece = await saying.make({ prompt: script, voice: narrator.id }, { report: () => {}, signal });
            await writeFile(join(at, 'assets', 'say.wav'), piece.bytes);
            let file = 'say.wav';
            let spoke = wavSeconds(piece.bytes);
            parts = piece.parts ?? [{ text: script, seconds: spoke }];
            // The length, held to what was asked for: the whole reading is spoken a little quicker — up to a
            // seventh, which nobody hears as fast — before a single scene is cut, because a film that loses a
            // scene loses an idea. One track means one pass rather than one a scene.
            const room = target ? target - spec.scenes.length * PACE[pace].tail * 0.6 : 0;
            if (room > 0 && spoke > room * 1.04 && !noFf) {
              const faster = Math.min(1.16, spoke / room);
              if (faster > 1.02) {
                report(`the narration came to ${Math.round(spoke)} seconds, so it is read ${Math.round((faster - 1) * 100)}% quicker to fit ${target}`);
                await ff(FFMPEG, ['-y', '-loglevel', 'error', '-i', join(at, 'assets', 'say.wav'), '-filter:a', `atempo=${faster.toFixed(3)}`, join(at, 'assets', 'say-fit.wav')], signal, 180)
                  .then(async () => {
                    file = 'say-fit.wav';
                    spoke = wavSeconds(await readFile(join(at, 'assets', file)));
                    parts = parts.map((part) => ({ ...part, seconds: part.seconds / faster }));
                  }, () => {});
              }
            }
            voice = { file, seconds: spoke };
          } catch (error) { report(`the narration could not be recorded (${(error as Error).message}), so the film is silent`); }
        })();
        await Promise.all([scenework, recording]);
        if (signal?.aborted) throw new Error('stopped');

        // Which words belong to which scene. The script is the scenes' own lines in order, so this is counting.
        const spans: { from: number; to: number }[] = [];
        let counted = 0;
        for (const line of lines) {
          const count = line ? line.split(/\s+/).filter(Boolean).length : 0;
          spans.push({ from: counted, to: counted + count });
          counted += count;
        }

        // --- the edit ---------------------------------------------------------------------------------------
        //
        // Everything above decided what the film says and found what it has to look at. This decides when it cuts,
        // and until now nothing did: every scene simply held for as long as the line over it, which is three long
        // shots under a voice and is exactly the film the founder rejected. `media/editor.ts` does it, by the
        // numbers editors actually work to, and it is deterministic — the same film cuts the same way twice.
        //
        // It is a function of the words it is cut against because it is now run twice: once against where the
        // words *ought* to fall, which is known the moment the recording exists, and once against where they were
        // measured to fall. The first is what lets the pictures start while the second is still being listened for.
        const style = cuttingFor(pack, pace);
        const cutTo = (heard: Word[], tell: boolean): { takes: Take[]; edit: Edit } => {
          const takes: Take[] = spec.scenes.map((scene, index): Take => {
            const span = spans[index];
            const spoken = heard.length && span.to > span.from
              ? { from: heard[span.from].at - PACE[pace].lead * 0.5, to: heard[span.to - 1].at + heard[span.to - 1].seconds + PACE[pace].tail * 0.5 }
              : null;
            const on = [scene.heading, scene.text, ...(scene.bullets ?? [])].filter(Boolean).join(' ');
            return {
              scene, index,
              from: spoken?.from ?? 0, to: spoken?.to ?? 0,
              moving: !!shots[index].video,
              least: spoken ? 0 : sceneSeconds(on, 0, pace),
            };
          });
          // A scene with nothing said over it has no place on the voice's clock, so it takes its seconds from the
          // one before it: everything after moves along. This is the one thing one continuous reading costs, and it
          // is cheap — a wordless picture between two sentences is a cutaway, which is what it should have been.
          let clockShift = 0;
          for (const one of takes) {
            if (one.to > one.from) { one.from += clockShift; one.to += clockShift; continue; }
            one.from = (takes[one.index - 1]?.to ?? 0);
            one.to = one.from + (one.least ?? PACE[pace].floor);
            clockShift += one.to - one.from;
          }
          // Nothing may start before the one before it ended, whatever the measurement said.
          for (let index = 1; index < takes.length; index += 1) {
            takes[index].from = Math.max(takes[index].from, takes[index - 1].to);
            takes[index].to = Math.max(takes[index].to, takes[index].from + style.min);
          }
          takes[0].from = 0;
          // A film that runs short of what was asked for is a film that ends before the viewer expected it to. The
          // narration is already budgeted to the length, so a shortfall is the breaths around the words rather than
          // the words themselves — and it is spread across every scene rather than dumped on the last two.
          //
          // Which is the whole point: a scene given a little more room is a scene the editor can *cut inside*, and
          // what the film was short of was picture changes, not holds. Held on the close instead, a real reel came
          // out at three and a half changes in ten seconds against a floor of four, with the last two shots sitting
          // still for the difference. The payoff still gets a larger share, because one long hold is the rhythm.
          const runs = takes.at(-1)?.to ?? 0;
          if (target && runs > 0 && runs < target * 0.96) {
            const short = target * 0.98 - runs;
            const payoff = Math.max(0, takes.length - 2);
            // The payoff takes a double share; everything else splits the rest by how long it already is.
            const weights = takes.map((one, index) => Math.max(0.2, one.to - one.from) * (index === payoff ? 2 : 1));
            const whole = weights.reduce((sum, one) => sum + one, 0) || 1;
            let shift = 0;
            for (const [index, one] of takes.entries()) {
              const share = (short * weights[index]) / whole;
              one.from += shift;
              one.to += shift + share;
              shift += share;
            }
            if (tell) report(`the reading came to ${Math.round(runs)} seconds against ${target}, so every scene is given a little more room rather than the film ending early`);
          }

          return { takes, edit: editFilm(takes, heard, style, { sfxOn: sfx }) };
        };

        // --- the pictures ---------------------------------------------------------------------------------------
        //
        // One picture a cut. Every shot in the list above gets something of its own on screen, drawn from the
        // phrase actually being spoken while it is up — not from the scene's headline, and not from the film's
        // subject in general. `media/visuals.ts` holds the rules and the critic; this is the part that spends
        // quota on them, in the order a real edit would: what the founder gave us, then a real photograph
        // somebody took, then one drawn here, and a texture only when everything else has run out.
        //
        // They are asked for as soon as there is a cut to ask against, and they are kept under the shot's own
        // name — which scene, which take — rather than its place in a list, so a picture started against the
        // guessed cut is still the right shot's picture when the measured cut arrives.
        type Drawn = { file: string; hold?: number; lift?: number };
        const pictures = new Map<string, Promise<Drawn | undefined>>();
        const stops = new Map<string, AbortController>();
        // Three at a time whoever draws them. This machine takes its own pictures one at a time whatever it is
        // asked, so the only thing three hands change here is that a free service is not made to wait its turn.
        const inHand = hands(3);
        const paint = paintOf(pack, brand);
        let spent = false;
        let kept = 0;
        // The one thing a picture maker says that a founder needs to hear: that a free service has run dry and the
        // rest are being drawn here, which is the difference between seconds and minutes. It was swallowed with
        // the rest of the makers' chatter, so a film quietly took eight minutes after promising two. Said once,
        // with the new wait beside it.
        const switched = new Set<string>();
        let pending = 0;
        const fromMaker = (line: string) => {
          if (!/used up/.test(line) || switched.has(line)) return;
          switched.add(line);
          const waiting = pending;
          report(drawsHere() && waiting ? `${line} — about ${Math.max(1, Math.round((waiting * secondsEach(true, draft)) / 60))} more minute${Math.round((waiting * secondsEach(true, draft)) / 60) > 1 ? 's' : ''} for the pictures` : line);
        };
        const gone = (error: Error, scene: number) => {
          if (outOfPictures(error.message)) {
            if (!spent) report("today's free pictures are used up, so the rest of the film sits on textures — they come back tomorrow");
            spent = true;
            return;
          }
          said(scene, `no picture: ${error.message}`);
        };
        const drawOne = async (visual: Visual, stop: AbortSignal): Promise<Drawn | undefined> => {
          if (spent || !drawing || stop.aborted) return undefined;
          const scene = spec.scenes[visual.scene];
          const name = `${visual.scene}-${visual.take}`;
          let file = '';
          try {
              // A real photograph of a real thing, from somebody who took one. People in stock are b-roll and
              // nothing else: never the film's own speaker, and never beside a claim about a named product.
            if (deps.stock && !deps.stock.ready()) {
              try {
                const looking = content(visual.subject).slice(0, 5).join(' ') || trimTo(visual.line, 4);
                const found = broll(await deps.stock.find({ query: looking, kind: 'photo', shape, many: 6 }, stop),
                  { speaker: !!scene.person || scene.layout === 'presenter', names: [material.brand?.name ?? ''].filter(Boolean) });
                if (found.length) {
                  const piece = await deps.stock.get(found[0], stop);
                  file = `stock-${name}.${piece.ext}`;
                  await writeFile(join(at, 'assets', file), piece.bytes);
                }
              } catch { file = ''; }
            }
            if (!file) {
              const piece = await drawing.make({ prompt: drawnAs(visual, bible), shape, ...(draft ? { size: 'draft' } : {}) }, { report: fromMaker, signal: stop });
              if (piece.by === DRAWN_BEFORE) kept += 1;
              file = `frame-${name}.${piece.ext}`;
              await writeFile(join(at, 'assets', file), piece.bytes);
            }
              // And now the one thing nobody was doing: looking at the picture that came back. How hard it has to
              // be held down for the words on it to be read is measured off the picture itself, where the words
              // really sit — so a white wall gets a wash and a dark doorway gets almost nothing. A graded pack
              // that has come back too dark to see a subject in is lifted rather than ungraded.
            const path = join(at, 'assets', file);
            const big = scene.layout === 'hook' || scene.layout === 'stat' || scene.layout === 'title';
            // The scrim is solved for the *weakest* colour on the frame rather than the strongest. A line of
            // support copy is set in the quiet tone, and a wash that clears the headline leaves that line
            // floating — which is what "grey list text" was.
            const hold = await scrimFor(path, visual.room === 'top' ? 'top' : 'foot', paint.quiet, paint.ground,
              { big, floor: PACK[pack].scrim * 0.35 }).catch(() => null);
            const light = PACK[pack].format?.grade ? await meanLight(path).catch(() => null) : null;
            return { file, hold: hold ?? undefined, lift: light === null ? undefined : liftFor(light) };
          } catch (error) {
            // A picture nobody is waiting for any more was stopped on purpose, and is not a thing that went wrong.
            if (!stop.aborted) gone(error as Error, visual.scene);
            return undefined;
          }
        };

        // Which shots of a cut need a picture, which of them get one of their own, and the drawing of every one of
        // those that is not already under way. Called once against the guessed cut and once against the measured
        // one; the second call finds nearly everything it wants already started.
        const drawFor = async (cut: Cut[], heard: Word[], tell: boolean) => {
          const needing = cut.map((one, order) => ({ one, at: order }))
            .filter(({ one }) => !shots[one.scene].video && !shots[one.scene].image);
          if (!drawing || !needing.length) return { needing, owners: needing.map(() => -1) };
          const have = new Set(needing.flatMap(({ one }, which) => (pictures.has(shotKey(one)) ? [which] : [])));
          // How many of those can really be drawn today, said in minutes before the waiting starts. Away from this
          // machine a picture is four seconds; here it is most of a minute, and eleven minutes of waiting for a
          // fifteen-second reel is not a trade a founder would make without being asked.
          const many = afforded(needing.length, drawsHere(), 8, draft);
          const owners = shareOut(needing.map(({ one }) => one.seconds), many, have);
          const fresh = [...new Set(owners)].filter((which) => !have.has(which));
          if (tell) {
            const drawn = new Set(owners).size;
            report(`${drawn} picture${drawn === 1 ? '' : 's'} for ${cut.length} shots — ${estimate({ scenes: spec.scenes.length, seconds, pictures: drawn, clips: 0, narrate: false, here: drawsHere(), draft })}`);
          }
          if (!fresh.length) return { needing, owners };
          const slots: Slot[] = cut.map((one) => ({
            scene: one.scene, take: one.take, layout: spec.scenes[one.scene].layout,
            line: lineUnder(heard, one.at, one.at + one.seconds, spec.scenes[one.scene].say ?? ''),
          }));
          // Whatever the storyboard already wrote for a scene is the first take's picture, so the director's own
          // work is the starting point rather than something thrown away.
          const seeded = slotsFor(slots, captions, spec.scenes).map((one) => {
            const wrote = spec.scenes[one.scene].image_prompt ?? spec.scenes[one.scene].bg_prompt;
            return one.take === 0 && wrote ? { ...one, subject: wrote } : one;
          });
          const wanted = fresh.map((which) => seeded[needing[which].at]);
          // A line that has had a picture put under it before gets that picture again. It is what makes the cache
          // of drawn pictures worth having: the words a picture is filed under are written by a model, and a
          // model never writes the same sentence twice, so until this nothing drawn was ever found again.
          const keys = new Map(wanted.map((one) => [one.at, subjectKey(one, bible)]));
          const known = await memory.subjects([...keys.values()]);
          const unknown = wanted.filter((one) => !known.has(keys.get(one.at)!));
          const written = unknown.length ? await photograph(unknown, bible, angle, deps.think, { report }) : [];
          await memory.keepSubjects(written.filter((one) => one.subject.trim())
            .map((one): [string, KeptSubject] => [keys.get(one.at)!, { subject: one.subject, metaphor: one.metaphor }]));
          for (const slot of wanted) {
            const before = known.get(keys.get(slot.at)!);
            const visual = before ? { ...slot, ...before } : written.find((one) => one.at === slot.at) ?? slot;
            const key = shotKey(visual);
            const mine = new AbortController();
            stops.set(key, mine);
            const stop = signal ? AbortSignal.any([signal, mine.signal]) : mine.signal;
            pending += 1;
            pictures.set(key, inHand(() => drawOne(visual, stop)).finally(() => { pending -= 1; }));
          }
          return { needing, owners };
        };

        // Where the words ought to fall, worked out from how long each sentence took to say. It is what the film
        // is cut against whenever the recording cannot be listened back to, so it is near enough to choose
        // pictures by — and it exists now, where the measurement is most of a minute away on a long film.
        const rough = voice ? (await timeWords(null, null, parts, PACE[pace].lead, { script: scriptWords })).words : [];
        const early = voice && drawing
          ? drawFor(cutTo(rough, false).edit.shots, rough, true).then(() => true, () => false)
          : Promise.resolve(false);

        if (voice) {
          // And now the one measurement in this studio that was always a guess. Every cut, punch-in and caption
          // in the film lands on one of these.
          report('listening back for where each word falls, and drawing while it does…');
          const heard = await timeWords(bin, join(at, 'assets', voice.file), parts, PACE[pace].lead, { script: scriptWords, signal })
            .catch(() => ({ words: rough, how: 'guessed' as const }));
          words = heard.words;
          report(heard.how === 'heard'
            ? 'the words were measured, so every cut lands on one'
            : 'the words could not be measured on this machine, so their timing comes from the sentences — the cuts are close rather than exact');
        }
        const startedEarly = await early;
        if (signal?.aborted) throw new Error('stopped');

        // Somebody speaking on camera needs their own line as sound, cut out of the film's one reading.
        if (voice && words.length && !noFf) {
          for (const [index, scene] of spec.scenes.entries()) {
            if (scene.layout !== 'presenter') continue;
            const span = spans[index];
            if (span.to <= span.from) continue;
            const from = Math.max(0, words[span.from].at - PACE[pace].lead);
            const until = Math.max(from + 0.4, words[span.to - 1].at + words[span.to - 1].seconds - PACE[pace].lead);
            const file = `say-${index}.wav`;
            await ff(FFMPEG, ['-y', '-loglevel', 'error', '-ss', from.toFixed(3), '-i', join(at, 'assets', voice.file),
              '-t', (until - from).toFixed(3), join(at, 'assets', file)], signal, 120)
              .then(() => { shots[index].voice = { file, seconds: until - from }; }, () => {});
          }
        }

        const { takes, edit } = cutTo(words, true);
        report(`${edit.shots.length} shots over ${spec.scenes.length} scenes — ${edit.changesPer10s} picture changes every ten seconds`);
        // What the shot list says about itself, before anything is drawn for it. A hold nobody breaks and a hook
        // that has not changed picture by two and a half seconds are both faults of the cut, not of the pictures,
        // and both were in the proof films.
        for (const line of checkCut(edit.shots, takes.map((one) => one.scene), takes.map((one) => !!one.moving)).slice(0, 3)) report(line.says);

        // The bed is written while the pictures are drawn: it needs the film's length and nothing else, and the
        // length is known from here on.
        const bedWork = mood !== 'none' && !noFf && !bed && deps.music
          ? (report('writing the music…'), deps.music.bed({ mood: mood as MusicMood, seconds: Math.ceil(edit.shots.reduce((sum, one) => sum + one.seconds, 0)) + 2 }, { report, signal })
            .then((made) => ({ made, error: undefined }), (error: Error) => ({ made: undefined, error })))
          : null;

        // The measured cut, asked for its pictures. Whatever the guessed cut already started is found under the
        // same shot's name and waited for; the odd shot the guess did not have is drawn now; and a picture the
        // measured cut has no shot for is stopped rather than left drawing for nobody.
        const { needing, owners } = await drawFor(edit.shots, words, !startedEarly);
        const using = new Set([...new Set(owners)].filter((which) => which >= 0).map((which) => shotKey(needing[which].one)));
        for (const [key, stop] of stops) if (!using.has(key)) stop.abort();
        // Which drawable shot each one takes its picture from, and what was made for it.
        const made = new Map<number, Drawn>();
        await Promise.all([...new Set(owners)].filter((which) => which >= 0).map(async (which) => {
          const piece = await pictures.get(shotKey(needing[which].one));
          if (piece) made.set(which, piece);
        }));
        if (kept) report(`${kept} of the pictures ${kept === 1 ? 'was' : 'were'} drawn before, so ${kept === 1 ? 'it' : 'they'} cost nothing this time`);

        await lipsyncWork();
        if (signal?.aborted) throw new Error('stopped');

        // A scene whose picture never arrived becomes the words it carries, so a founder with no picture key still
        // gets a film, and every scene is as long as the line said over it.
        const drewFor = new Map<number, { file: string; hold?: number; lift?: number; shared: boolean }>();
        needing.forEach(({ at: order }, which) => {
          const owner = owners[which];
          const piece = made.get(owner);
          if (piece) drewFor.set(order, { ...piece, shared: owner !== which });
        });
        // Which scenes ended up with something in front of the words at all: a picture scene with nothing to show
        // is a picture scene that has to become its words.
        const sceneGot = new Set(edit.shots.map((one, order) => (drewFor.has(order) ? one.scene : -1)).filter((one) => one >= 0));
        for (const [index, shot] of shots.entries()) {
          const layout = shot.scene.layout;
          // A device scene is a screenshot inside a mockup, so nothing but a real screenshot will do: a drawn
          // picture behind the words is not the product, and an empty phone frame is worse than a sentence.
          if (layout === 'device' && !shot.image) shot.scene = fallbackOf(shot.scene);
          if (layout === 'picture' && !shot.image && !sceneGot.has(index)) shot.scene = fallbackOf(shot.scene);
          if ((layout === 'footage' || layout === 'clip' || layout === 'presenter') && !shot.video && !shot.image) shot.scene = fallbackOf(shot.scene);
          // A scene that lost its words to the captions and then lost its picture to a refused call would be three
          // seconds of nothing at all. Whenever there is nothing written on a scene, the words come back — the
          // line it is already saying, cut to a headline.
          const silentOnScreen = ![shot.scene.heading, shot.scene.text, ...(shot.scene.bullets ?? [])].some((one) => one?.trim());
          // A moving shot, or a real picture or screen filling the frame, carries a scene on its own — one wordless
          // picture in three is the point. Anything else with nothing written on it is a gradient.
          //
          // …and in a captioned film a photograph behind the words carries it too, because the words being said
          // are already on the frame. This line is where a real reel lost its caption track: the critic had taken
          // the narration off three scenes precisely so the captions could say it, and then this put a headline
          // cut from the same sentence straight back on — which silenced the captions again. A scene needs words
          // of its own only when there is nothing else at all.
          const carries = !!shot.video || (!!shot.image && (shot.scene.layout === 'picture' || shot.scene.layout === 'device'))
            || (captions && sceneGot.has(index) && !!shot.scene.say);
          if (silentOnScreen && shot.scene.say && !carries) {
            shot.scene = { ...shot.scene, layout: shot.scene.layout === 'picture' ? 'statement' : shot.scene.layout, text: headlineOf(shot.scene.say ?? '', 6) || trimTo(shot.scene.say, 6) };
          }
        }

        // The shot list as the renderer wants it: one entry a shot, each with the scene it belongs to, its own
        // picture, the hold measured off that picture and the push the editor asked for. Two shots of one scene
        // never show the same frame — a picture change that changes nothing is worse than a hold.
        // The picture a scene ended up with, whichever of its shots was the one that got it. A second take of a
        // picture scene whose own picture was never drawn used to render an <img> pointed at nothing.
        const sceneHas = new Map<number, { file: string; hold?: number; lift?: number; shared: boolean }>();
        edit.shots.forEach((one, order) => {
          const drew = drewFor.get(order);
          if (drew && !sceneHas.has(one.scene)) sceneHas.set(one.scene, drew);
        });
        const cut: Shot[] = edit.shots.map((one, order): Shot => {
          const base = shots[one.scene];
          const fills = base.scene.layout === 'picture' || base.scene.layout === 'logo';
          const drew = drewFor.get(order) ?? (fills ? sceneHas.get(one.scene) : undefined);
          return {
            ...base,
            seconds: one.seconds,
            take: one.take,
            punch: one.punch ? { ...one.punch, at: Math.max(0, one.punch.at - one.at) } : undefined,
            ...(drew && !base.video && !base.image
              ? (fills
                ? { image: drew.file, scrim: drew.hold, lift: drew.lift }
                : { bg: drew.file, bgShared: drew.shared, scrim: drew.hold, lift: drew.lift })
              : {}),
          };
        });
        let total = edit.total;

        // The bed. The founder's own track first; failing that whatever the music maker can write for the mood.
        let music: { file: string; seconds: number } | undefined;
        let credit: Credit | undefined;
        let beats: number[] | undefined;
        let bedFile = '';
        if (mood !== 'none' && !noFf) {
          if (bed) bedFile = deps.fileOf?.(bed.path) ?? bed.path;
          else if (bedWork) {
            const wrote = await bedWork;
            if (wrote.made) {
              bedFile = join(at, 'assets', `bed-source.${wrote.made.ext}`);
              await writeFile(bedFile, wrote.made.bytes);
              credit = wrote.made.credit;
              beats = wrote.made.beats;
            } else report(`no music this time: ${wrote.error?.message}`);
          } else report('no music is set up — drop a music file on the card and the next film will have a bed under it');
        }
        // A cut lands better on a beat than a hair away from one — but only in a film with nobody talking over it.
        // Where narration leads, the phrase is the beat, and pulling a cut off the word onto the drum is the very
        // thing that makes an edit feel mechanical.
        if (beats?.length && !words.length) {
          const snapped = snapToBeats(cut.map((one) => one.seconds), beats);
          snapped.forEach((value, index) => { cut[index].seconds = value; });
          report('nobody is speaking, so the cuts are pulled onto the beat');
        }

        const starts: number[] = [];
        let clock = 0;
        for (const shot of cut) { starts.push(clock); clock = Math.round((clock + shot.seconds) * 100) / 100; }
        total = clock;

        // The sounds the film is cut with: the editor's, capped at five and each on a cut frame, rather than one
        // on every entrance of every element. An effect on every cut is what a template sounds like.
        const cues = edit.cues;
        for (const sound of new Set(cues.map((one) => one.sound))) {
          await copyFile(join(SFX_DIR, sfxFile(sound)), join(at, 'assets', sfxFile(sound))).catch(() => {});
        }
        if (bedFile && mood !== 'none') {
          report('mixing the music under the narration…');
          // Where the bed has to get out of the way, and by how much: the editor works it out from the narration
          // it has just measured, rather than from where a scene happens to start.
          const windows = edit.ducks.map((one) => ({ at: one.at, seconds: one.seconds }));
          await musicBed({ from: bedFile, to: join(at, 'assets', 'bed.wav'), seconds: total, mood: mood as MusicMood, windows, signal })
            .then(() => { music = { file: 'bed.wav', seconds: total }; }, (error: Error) => report(`the music could not be mixed: ${error.message}`));
        }
        if (credit && music) report(`Music: ${credit.title} by ${credit.by} · ${credit.licence}`);

        // The words a film turns on, which are what the caption track lights up.
        const keywords = [...new Set(edit.shots.map((one) => one.keyword).filter(Boolean) as string[])];
        // And where it must stay quiet: the stretches of narration whose scene already writes the line out.
        // Where the caption track must stay quiet: a scene that already writes out what is being said, and a scene
        // whose own type grows down into the band the captions live in. Two systems of type in one part of the
        // frame is not a caption track, it is a collision — a real reel put the word "AWAY." on top of a checklist.
        const quiet = cut.map((shot, index) => (saysWhatItShows(shot.scene) || crowdsCaptions(shot.scene)
          ? { at: starts[index], seconds: shot.seconds } : null))
          .filter(Boolean) as { at: number; seconds: number }[];
        // A film whose scenes nearly all write their own words has almost no caption track left, and a founder who
        // switched captions on deserves to hear that from the card rather than to notice it in the film.
        const hushed = quiet.reduce((sum, one) => sum + one.seconds, 0);
        if (captions && total > 0 && hushed > total * 0.6) {
          report('most of this film writes its own words on screen, so the captions stay out of the way — two sets of words in one place is read as neither');
        }

        await writeFile(join(at, 'index.html'), composition({
          title: spec.title, shape, look: pack === 'brand' && !brand ? 'clean' : pack, shots: cut, pace, captions, brand,
          bed: music, cues, beats, voice, words, keywords, quiet,
        }));
        await writeFile(join(at, 'hyperframes.json'), projectFile);

        // A finding here is worth saying out loud, but it is not worth withholding the film over: render either way.
        report('checking the composition…');
        const checked = await run(bin, ['check', '.'], at, () => {}, signal);
        // Say what it disliked, not how many things it disliked: the lint's own line names the element and the reason.
        if (checked.code !== 0) {
          const found = checked.out.split('\n').map((line) => line.trim()).find((line) => line.startsWith('✗'))
            ?? checked.out.match(/^.*(error|warning|finding).*$/im)?.[0]?.trim() ?? 'see the render';
          report(`the check was not happy: ${found.replace(/^✗\s*/, '').slice(0, 200)}`);
        }

        report(`rendering ${Math.round(total)} seconds…`);
        let last = 0;
        const rendered = await run(bin, ['render', '.', '--no-browser-gpu', '--quiet', ...(draft ? ['--quality', 'draft'] : []), '-o', 'out.mp4'], at, (line) => {
          // The renderer talks a lot; a line a second is enough for the founder to see it moving.
          if (!line || Date.now() - last < 1000) return;
          last = Date.now();
          report(`rendering · ${line.slice(0, 120)}`);
        }, signal);
        if (signal?.aborted) throw new Error('stopped');
        if (rendered.code !== 0) throw new Error(`the render stopped: ${(rendered.out.trim().split('\n').filter(Boolean).at(-1) ?? 'no reason given').slice(0, 200)}`);
        const bytes = await readFile(join(at, 'out.mp4'));

        // One frame out of the opening scene stands in for the film wherever it cannot be played.
        report('taking the poster frame…');
        let poster: Piece['poster'];
        await run(bin, ['snapshot', '.', '--at', (cut[0].seconds * 0.6).toFixed(2), '--no-end', '--describe=false', '-o', 'poster'], at, () => {}, signal);
        const shot = (await readdir(join(at, 'poster')).catch(() => [])).find((name) => name.endsWith('.png'));
        if (shot) poster = { ext: 'png', bytes: await readFile(join(at, 'poster', shot)) };
        return { ext: 'mp4', bytes, poster, credit };
      } finally {
        // The project a film was rendered from is thrown away, because it is a copy of everything the founder
        // wired plus a few megabytes of pictures. When something is wrong with a finished film the only way to
        // see why is that project — which scene silenced its own captions, what the picture prompt really said —
        // so there is one switch that keeps it, and it is off unless somebody debugging turns it on.
        if (process.env.STAGE_KEEP_PROJECT === '1') report(`the project this was rendered from is at ${at}`);
        else await rm(at, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

// A second of one flat colour, so the checks and the fake-model mode never need Chrome.
const CLIP = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAOwbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAtt0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAIAAABAAAAAAJTbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAKABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAAB/m1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAb5zdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAFA8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABoYAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAKAAAEAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAYGN0dHMAAAAAAAAACgAAAAEAAAgAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAAAgAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAKAAAAAQAAADxzdHN6AAAAAAAAAAAAAAAKAAACyQAAAAwAAAAMAAAADAAAAAwAAAASAAAADgAAAAwAAAAMAAAAEgAAABRzdGNvAAAAAAAAAAEAAAPgAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMQAAAAhmcmVlAAADS21kYXQAAAKuBgX//6rcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MTAgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAATZYiEABH//ufj/AptY+nCoYzc8QAAAAhBmiRsQQ/+4AAAAAhBnkJ4h3+3gQAAAAgBnmF0Q3+6gAAAAAgBnmNqQ3+6gQAAAA5BmmhJqEFomUwId//+4QAAAApBnoZFESw7/7eBAAAACAGepXRDf7qBAAAACAGep2pDf7qAAAAADkGaqUmoQWyZTAhv//7g';
const POSTER = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const fakeVideos: Maker = {
  name: 'fake',
  ready: () => null,
  async make(ask, { report }) {
    const asked = ask as VideoAsk;
    const spec = asked.spec ?? { title: asked.prompt.slice(0, 60), scenes: [{ layout: 'title' as const, heading: asked.prompt.slice(0, 60) }] };
    report(`reading the brief: ${asked.prompt.slice(0, 60)}`);
    // What it was handed, said the way the real one says it, so a run without models still shows the founder that
    // the picture they drew reached the film.
    if (asked.images?.length) report(`using: ${asked.images.length} picture${asked.images.length === 1 ? '' : 's'} you were handed — ${asked.images.join(', ')}`);
    report(`${spec.scenes.length} scenes: ${spec.title}`);
    report('rendering 6 seconds…');
    return { ext: 'mp4', bytes: Buffer.from(CLIP, 'base64'), poster: { ext: 'png', bytes: Buffer.from(POSTER, 'base64') } };
  },
};

// The bed the tests and the fake-model runs get: the real synthesiser, four seconds of it.
export const fakeMusicBed: Music = fakeMusic;

// The rules the critic holds a film to, exported for whatever wants to check one without rendering it.
export type { Want } from './critic.ts';
export { criticise, repair } from './critic.ts';
