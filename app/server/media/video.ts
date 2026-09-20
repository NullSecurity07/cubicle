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
import { headlineOf, trimTo } from './critic.ts';
import { bibleFor, direct, faceIn, onCamera, tellOf, understandingOf, readBrief, type Asked, type Material, type Understanding } from './director.ts';
import { ff, ffReady, FFMPEG } from './ff.ts';
import { fitStill, normalise } from './footage.ts';
import { cachedImages, outOfPictures } from './image.ts';
import type { Maker, Piece } from './jobs.ts';
import { availableRam, availableSwap, MINUTES_EACH, needsRam, roomToFilm as room } from './local-clips.ts';
import {
  AI_LAYOUTS, isPurpose, MAX_AI, MAX_BACKGROUNDS, MAX_LOCAL_AI, PURPOSE, PURPOSES, SCENES_A_BACKGROUND,
  fallbackOf, withinCaps, withinLength, type Spec,
} from './spec.ts';
import { readProject, VIEWPORTS } from './sources.ts';
import {
  composition, cuesOf, FORMATS, isPack, PACK, PACKS, PACES, projectFile, sceneSeconds, snapToBeats,
  type Pace, type Pack, type Shot,
} from './templates/index.ts';
import { wavSeconds } from './voice.ts';

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
  // such scenes a film may have and whether a person's call needs the founder's yes.
  clips?: Clips; local?: Clips; music?: Music; forbidden?: string[];
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

// A picture model cannot write, and it has no negative prompt either: "no text, no lettering" is read as part of the
// same sentence and summons the very thing it asked to be spared — which is how a scene of real type came to sit on
// a picture of fake type reading "rogblellem / Solvic". The only thing that works is never asking. So the nouns that
// summon lettering are taken out of the subject before it is drawn, and a scene that is mostly type is given a
// texture to sit on rather than a scene of its own, which is the better picture anyway.
const SUMMONS_TEXT = /\b(charts?|graphs?|dashboards?|decks?|slides?|metrics|checklists?|lists?|texts?|signs?|signage|screens?|displays?|interfaces?|ui|uis|apps?|websites?|web ?pages?|pages?|documents?|reports?|spreadsheets?|logos?|brands?|labels?|posters?|banners?|headlines?|newspapers?|magazines?|books?|whiteboards?|notebooks?|notes?|letters?|words?|writing|typography|captions?|subtitles?|numbers?|figures?|percentages?)\b/gi;
// A scene whose frame is already full of words wants something quiet behind them, not a competing picture.
const TYPE_HEAVY = new Set(['checklist', 'bullets', 'steps', 'compare', 'stat', 'quote', 'hook', 'title', 'cta', 'outro']);
const TEXTURE = 'a softly out-of-focus surface, the light falling across it, nothing in sharp focus, no subject in the middle of the frame';
export function bgPrompt(bible: string, subject: string, layout: string): string {
  const clean = subject.replace(SUMMONS_TEXT, ' ').replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim();
  const said = TYPE_HEAVY.has(layout) || clean.split(/\s+/).filter(Boolean).length < 3 ? TEXTURE : `${clean}, shallow depth of field`;
  return said.toLowerCase().startsWith(bible.slice(0, 18).toLowerCase()) ? said : `${bible}. ${said}`;
}

// About how long this is going to take, said before it starts rather than found out. Nothing here is precise; it is
// honest, which is what a founder watching a spinner actually needs.
export function estimate(ask: { scenes: number; seconds: number; pictures: number; clips: number; narrate: boolean }): string {
  const drawing = Math.ceil(ask.pictures / 3) * 8;
  const saying = ask.narrate ? ask.seconds * 0.6 : 0;
  const rendering = 14 + ask.seconds * 4;
  const local = ask.clips * 180;
  const all = drawing + saying + rendering + local;
  const minutes = Math.max(1, Math.round(all / 60));
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}${ask.clips ? ` — ${ask.clips} of that is the moving shot${ask.clips === 1 ? '' : 's'} this computer draws` : ''}`;
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

        const { material, files, bed } = await gather(deps, asked, at, report, signal);
        if (material.using.length) report(`using: ${material.using.join(', ')}`);

        // A person who wrote the whole storyboard is not overruled about what is in it, only about how it is set.
        let understanding: Understanding;
        let spec: Spec;
        let bible: string;
        const mayUseAi = wantsAi || (autoAi && here);
        if (asked.spec) {
          understanding = understandingOf({}, told, readBrief(asked.prompt));
          bible = bibleFor(understanding);
          spec = asked.spec;
          if (spec.pace) understanding.pace = spec.pace;
          if (spec.pack) understanding.pack = spec.pack;
          if (spec.music) understanding.mood = spec.music;
          if (spec.captions !== undefined) understanding.captions = spec.captions;
          report(tellOf(understanding));
        } else {
          const directed = await direct(told, material, deps.think, { report, ai: mayUseAi });
          understanding = directed.understanding;
          spec = directed.spec;
          bible = directed.bible;
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
        spec = { ...spec, scenes: onCamera(spec.scenes, understanding, bible, report, roomToFilm ? { minutes: MINUTES_EACH } : undefined, face) };

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

        const wantsPictures = spec.scenes.filter((scene) => scene.layout === 'picture' || scene.bg_prompt).length;
        const wantsClips = spec.scenes.filter((scene) => AI_LAYOUTS.has(scene.layout)).length;
        report(`${spec.scenes.length} scenes, ${estimate({ scenes: spec.scenes.length, seconds, pictures: drawing ? wantsPictures : 0, clips: here ? wantsClips : 0, narrate: !!saying })}`);
        report('drawing the pictures and recording the narration…');
        const shots: Shot[] = spec.scenes.map((scene) => ({ scene, seconds: 0 }));
        const said = (index: number, line: string) => report(`scene ${index + 1}: ${line}`);

        // Everything a scene needs is made beside everything else: the stills, the lines, the clips and the founder's
        // own footage are the slow part, and none of them waits on another.
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
          // The line is recorded before a talking head is made of it, because the head is made out of the line.
          if (saying && scene.say) {
            try {
              const piece = await saying.make({ prompt: scene.say, voice: asked.voice || 'af_heart' }, { report: () => {}, signal });
              const file = `say-${index}.wav`;
              await writeFile(join(at, 'assets', file), piece.bytes);
              shot.voice = { file, seconds: wavSeconds(piece.bytes), parts: piece.parts ?? [{ text: scene.say, seconds: wavSeconds(piece.bytes) }] };
            } catch (error) { said(index, `silent: ${(error as Error).message}`); }
          }
          if (scene.layout === 'clip' && able) {
            try {
              said(index, 'making a few seconds of moving picture…');
              // A still first, so the clip looks like the rest of the film rather than like a different film.
              const still = drawing ? await drawing.make({ prompt: `${bible}. ${scene.clip_prompt!}`, shape }, { report: () => {}, signal }).then((one) => one.bytes, () => undefined) : undefined;
              const made = await clips.broll({ prompt: scene.clip_prompt!, image: still, seconds: scene.seconds ?? 4 }, { report: (line) => said(index, line), signal });
              shot.video = `clip-${index}.mp4`;
              await writeFile(join(at, 'assets', shot.video), made.bytes);
            } catch (error) {
              said(index, `the clip could not be made (${(error as Error).message}), so the scene is a picture instead`);
              shot.scene = fallbackOf(scene);
            }
          }
          if (scene.layout === 'presenter' && able) {
            try {
              said(index, 'making the person on screen…');
              const face = shot.image ? await readFile(join(at, 'assets', shot.image))
                : drawing && scene.portrait_prompt ? (await drawing.make({ prompt: `${scene.portrait_prompt}, head and shoulders portrait, plain background, even light`, shape }, { report: () => {}, signal })).bytes
                  : null;
              const speech = shot.voice ? await readFile(join(at, 'assets', shot.voice.file)) : null;
              if (!face || !speech) throw new Error(!face ? 'there is no face to use' : 'there is nothing recorded for them to say');
              const made = await clips.presenter({ portrait: face, speech }, { report: (line) => said(index, line), signal });
              shot.video = `pres-${index}.mp4`;
              await writeFile(join(at, 'assets', shot.video), made.bytes);
            } catch (error) {
              said(index, `the talking head could not be made (${(error as Error).message}), so the line is said over the words instead`);
              shot.scene = fallbackOf(scene);
            }
          }
        }));

        // The pictures. A scene that is a picture gets one; every other scene gets one drawn behind it, because a
        // film of flat dark rectangles is the single thing the founder said was wrong with the last one. Three at a
        // time: a free picture service asked for a dozen at once refuses most of them.
        const picturework = (async () => {
          if (!drawing) return;
          // Nothing is asked for twice once the answer is "not today". A free service says it plainly, and going
          // on asking costs the founder a minute a scene to be told the same thing.
          let spent = false;
          const spendable = async (job: () => Promise<void>) => { if (!spent) await job(); };
          const gone = (error: Error, index: number, front: boolean) => {
            if (outOfPictures(error.message)) {
              if (!spent) report("today's free pictures are used up, so the scenes sit on textures instead — they come back tomorrow");
              spent = true;
              return;
            }
            if (front) said(index, `no picture: ${error.message}`);
          };

          // The pictures in front of the words: a picture scene is a picture of its own, and no two are the same.
          const front = spec.scenes.map((scene, index) => async () => spendable(async () => {
            if (shots[index].image || (scene.layout !== 'picture' && scene.layout !== 'logo') || !scene.image_prompt) return;
            try {
              const piece = await drawing.make({ prompt: bgPrompt(bible, scene.image_prompt, 'picture'), shape }, { report: () => {}, signal });
              const file = `shot-${index}.${piece.ext}`;
              await writeFile(join(at, 'assets', file), piece.bytes);
              shots[index].image = file;
            } catch (error) { gone(error as Error, index, true); }
          }));

          // What goes behind the words. A handful for the whole film, shared out in runs, each scene taking its own
          // crop and tint of the one it was given: six frames of one film rather than six photographs of six.
          const wants = spec.scenes.map((scene, index) => ({ scene, index }))
            .filter(({ scene, index }) => !shots[index].image && scene.layout !== 'picture' && scene.layout !== 'logo' && scene.bg_prompt?.trim());
          const takes = Math.min(MAX_BACKGROUNDS, Math.max(2, Math.ceil(wants.length / SCENES_A_BACKGROUND)));
          const runs = Array.from({ length: Math.min(takes, wants.length) }, (_, take) =>
            wants.filter((_one, at) => Math.floor((at * takes) / wants.length) === take));
          const behind = runs.filter((run) => run.length).map((run, take) => async () => spendable(async () => {
            try {
              const piece = await drawing.make({ prompt: bgPrompt(bible, run[0].scene.bg_prompt!, run[0].scene.layout), shape }, { report: () => {}, signal });
              const file = `bg-${take}.${piece.ext}`;
              await writeFile(join(at, 'assets', file), piece.bytes);
              for (const { index } of run) { shots[index].bg = file; shots[index].bgShared = run.length > 1; }
            } catch (error) { gone(error as Error, run[0].index, false); }
          }));
          await pool([...front, ...behind], 3);
        })();
        await Promise.all([scenework, picturework]);
        if (signal?.aborted) throw new Error('stopped');

        // A scene whose picture never arrived becomes the words it carries, so a founder with no picture key still
        // gets a film, and every scene is as long as the line said over it.
        for (const shot of shots) {
          const layout = shot.scene.layout;
          if ((layout === 'picture' || layout === 'device') && !shot.image) shot.scene = fallbackOf(shot.scene);
          if ((layout === 'footage' || layout === 'clip' || layout === 'presenter') && !shot.video && !shot.image) shot.scene = fallbackOf(shot.scene);
          // A scene that lost its words to the captions and then lost its picture to a refused call would be three
          // seconds of nothing at all. Whenever there is nothing written on a scene, the words come back — the
          // line it is already saying, cut to a headline.
          const silentOnScreen = ![shot.scene.heading, shot.scene.text, ...(shot.scene.bullets ?? [])].some((one) => one?.trim());
          // A moving shot, or a real picture or screen filling the frame, carries a scene on its own — one wordless
          // picture in three is the point. Anything else with nothing written on it is a gradient.
          const carries = !!shot.video || (!!shot.image && (shot.scene.layout === 'picture' || shot.scene.layout === 'device'));
          if (silentOnScreen && shot.scene.say && !carries) {
            shot.scene = { ...shot.scene, layout: shot.scene.layout === 'picture' ? 'statement' : shot.scene.layout, text: headlineOf(shot.scene.say ?? '', 6) || trimTo(shot.scene.say, 6) };
          }
        }

        // The length, held to what was asked for. The word budget does most of it, but a voice is a voice: when the
        // recording still runs long, it is spoken a little faster — up to a seventh, which nobody hears as fast —
        // before any scene is cut, because a film that loses a scene loses an idea.
        const measure = () => {
          for (const shot of shots) {
            const on = [shot.scene.heading, shot.scene.text, ...(shot.scene.bullets ?? [])].filter(Boolean).join(' ');
            shot.seconds = sceneSeconds(on, shot.voice?.seconds ?? 0, pace);
            if (shot.video && shot.scene.layout === 'footage' && shot.scene.seconds) shot.seconds = Math.max(shot.seconds, shot.scene.seconds);
          }
          return shots.reduce((sum, one) => sum + one.seconds, 0);
        };
        let total = measure();
        const target = asked.spec ? 0 : seconds;
        if (target && total > target * 1.06 && !noFf) {
          const faster = Math.min(1.16, total / (target * 1.0));
          if (faster > 1.02) {
            report(`the narration came to ${Math.round(total)} seconds, so it is read ${Math.round((faster - 1) * 100)}% quicker to fit ${target}`);
            await pool(shots.map((shot) => async () => {
              if (!shot.voice) return;
              const to = shot.voice.file.replace('.wav', '-fit.wav');
              await ff(FFMPEG, ['-y', '-loglevel', 'error', '-i', join(at, 'assets', shot.voice.file), '-filter:a', `atempo=${faster.toFixed(3)}`, join(at, 'assets', to)], signal, 120)
                .then(async () => {
                  const bytes = await readFile(join(at, 'assets', to));
                  shot.voice = { file: to, seconds: wavSeconds(bytes), parts: (shot.voice!.parts ?? []).map((part) => ({ ...part, seconds: part.seconds / faster })) };
                }, () => {});
            }), 4);
            total = measure();
          }
        }
        const held = withinLength(shots, target);
        if (held.dropped) report(`${held.dropped} scene${held.dropped === 1 ? '' : 's'} cut to keep the film near ${seconds} seconds`);
        const cut = held.shots;

        // The bed. The founder's own track first; failing that whatever the music maker can write for the mood.
        let music: { file: string; seconds: number } | undefined;
        let credit: Credit | undefined;
        let beats: number[] | undefined;
        let bedFile = '';
        if (mood !== 'none' && !noFf) {
          if (bed) bedFile = deps.fileOf?.(bed.path) ?? bed.path;
          else if (deps.music) {
            try {
              report('writing the music…');
              const made = await deps.music.bed({ mood: mood as MusicMood, seconds: Math.ceil(cut.reduce((sum, one) => sum + one.seconds, 0)) + 2 }, { report, signal });
              bedFile = join(at, 'assets', `bed-source.${made.ext}`);
              await writeFile(bedFile, made.bytes);
              credit = made.credit;
              beats = made.beats;
            } catch (error) { report(`no music this time: ${(error as Error).message}`); }
          } else report('no music is set up — drop a music file on the card and the next film will have a bed under it');
        }
        // A cut lands better on a beat than a hair away from one.
        if (beats?.length) {
          const snapped = snapToBeats(cut.map((one) => one.seconds), beats);
          snapped.forEach((value, index) => { cut[index].seconds = value; });
          report('the cuts are pulled onto the beat');
        }

        const starts: number[] = [];
        let clock = 0;
        for (const shot of cut) { starts.push(clock); clock = Math.round((clock + shot.seconds) * 100) / 100; }
        total = clock;

        // The sounds the film is cut with, and the bed under it, ducked where somebody is speaking.
        const cues = sfx ? cuesOf(cut, starts, pace) : [];
        for (const sound of new Set(cues.map((one) => one.sound))) {
          await copyFile(join(SFX_DIR, sfxFile(sound)), join(at, 'assets', sfxFile(sound))).catch(() => {});
        }
        if (bedFile && mood !== 'none') {
          report('mixing the music under the narration…');
          const windows = cut.map((shot, index) => ({ at: starts[index] + 0.35, seconds: shot.voice?.seconds ?? 0 })).filter((one) => one.seconds > 0);
          await musicBed({ from: bedFile, to: join(at, 'assets', 'bed.wav'), seconds: total, mood: mood as MusicMood, windows, signal })
            .then(() => { music = { file: 'bed.wav', seconds: total }; }, (error: Error) => report(`the music could not be mixed: ${error.message}`));
        }
        if (credit && music) report(`Music: ${credit.title} by ${credit.by} · ${credit.licence}`);

        await writeFile(join(at, 'index.html'), composition({
          title: spec.title, shape, look: pack === 'brand' && !brand ? 'clean' : pack, shots: cut, pace, captions, brand, bed: music, cues, beats,
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
        const rendered = await run(bin, ['render', '.', '--no-browser-gpu', '--quiet', '-o', 'out.mp4'], at, (line) => {
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
        await rm(at, { recursive: true, force: true }).catch(() => {});
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
