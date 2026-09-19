import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Card, MediaAsset, Shape, Stage } from '../../shared/model.ts';
import { CHROMES } from '../browser.ts';
import { projectDir } from '../coder.ts';
import { musicBed, MOODS, SFX_DIR, sfxFile, type Mood } from './audio.ts';
import { noClips, type Clips } from './clips.ts';
import { ffReady } from './ff.ts';
import { fitStill, normalise } from './footage.ts';
import type { Maker, Piece } from './jobs.ts';
import { readProject, VIEWPORTS } from './sources.ts';
import { composition, cuesOf, FORMATS, FRAMES, LOOKS, PACES, projectFile, sceneSeconds, type Brand, type Look, type Pace, type Shot } from './templates/index.ts';

export { FRAMES } from './templates/index.ts';
import { wavSeconds } from './voice.ts';

// Seventeen shapes a scene can take, in the order a film tends to use them.
export const LAYOUTS = ['title', 'hook', 'statement', 'bullets', 'checklist', 'steps', 'compare', 'picture', 'device',
  'stat', 'quote', 'logo', 'cta', 'footage', 'clip', 'presenter', 'outro'] as const;
export type Layout = (typeof LAYOUTS)[number];
// One scene of a video, as a model or a person fills it in. `say` is the line spoken over it; `image_prompt` is the
// still drawn for it; `asset` names something already on the card. Which fields a layout needs is what `parseSpec`
// checks, and everything here is a plain string, number or list of strings — no provider argues with those.
export type Scene = {
  layout: Layout; heading?: string; text?: string; bullets?: string[]; labels?: string[];
  image_prompt?: string; asset?: string; frame?: string; clip_prompt?: string; portrait_prompt?: string;
  seconds?: number; start?: number; mute?: boolean; say?: string;
};
// The whole film as one flat object. `music` is the mood the bed wants, `sfx` and `captions` are on or off, `pace` is
// how fast it cuts. Everything the founder chose on the card is folded in before this is filled.
export type Spec = { title: string; scenes: Scene[]; music?: Mood; sfx?: boolean; captions?: boolean; pace?: Pace };

export const MAX_SCENES = 24;
// Every drawn still costs a call to a free picture service with a day's quota, and every AI clip costs far more.
export const MAX_IMAGES = 6;
export const MAX_AI = 2;
export const LENGTHS = [15, 30, 60, 90] as const;
const CAPS = { title: 80, heading: 90, text: 260, bullet: 100, bullets: 6, labels: 2, say: 420, image_prompt: 300, clip_prompt: 240, asset: 80 };
export const SETUP_HINT = 'No video renderer is set up. The founder installs Chrome and ffmpeg — both are free — and restarts the app.';

const words = (value: unknown, what: string, limit: number): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} must be a line of text`);
  if (value.length > limit) throw new Error(`${what} is too long (${value.length} characters, limit ${limit})`);
  return value.trim();
};
const lines = (value: unknown, what: string, most: number, limit: number): string[] => {
  if (!Array.isArray(value) || !value.length) throw new Error(`${what} must be a list of short lines`);
  if (value.length > most) throw new Error(`${what}: at most ${most} fit on screen, not ${value.length}`);
  return value.map((one, at) => words(one, `${what.replace(/"$/, '')} ${at + 1}"`.replace(/""/g, '"'), limit));
};
const number = (value: unknown, what: string, low: number, high: number): number => {
  const read = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(read)) throw new Error(`${what} must be a number of seconds`);
  return Math.min(high, Math.max(low, Math.round(read * 100) / 100));
};

// Which layouts need what, said once so the parser and the prompt cannot drift apart.
const NEEDS_HEADING = new Set<Layout>(['title', 'stat', 'logo']);
const NEEDS_TEXT = new Set<Layout>(['statement', 'quote', 'outro', 'hook', 'cta']);
const NEEDS_BULLETS = new Set<Layout>(['bullets', 'checklist', 'steps']);
// A scene that is a moving picture the studio has to make or cut before there is anything to show.
export const AI_LAYOUTS = new Set<Layout>(['clip', 'presenter']);

// The storyboard, checked by hand so that whatever went wrong comes back in a line a model or a person can act on.
export function parseSpec(raw: unknown): Spec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the storyboard must be a JSON object with "title" and "scenes"');
  const asked = raw as Record<string, unknown>;
  const title = words(asked.title, '"title"', CAPS.title);
  if (!Array.isArray(asked.scenes) || !asked.scenes.length) throw new Error('"scenes" must be a list with at least one scene');
  if (asked.scenes.length > MAX_SCENES) throw new Error(`a video can have at most ${MAX_SCENES} scenes, not ${asked.scenes.length}`);
  const scenes = asked.scenes.map((one, index): Scene => {
    const where = `scene ${index + 1}`;
    if (!one || typeof one !== 'object' || Array.isArray(one)) throw new Error(`${where} must be an object`);
    const scene = one as Record<string, unknown>;
    if (!(LAYOUTS as readonly unknown[]).includes(scene.layout)) throw new Error(`${where}: "layout" must be one of ${LAYOUTS.join(', ')}`);
    const layout = scene.layout as Layout;
    const made: Scene = { layout };
    const some = (key: keyof Scene, what: string, limit: number) => {
      if (scene[key] !== undefined && scene[key] !== null) (made as Record<string, unknown>)[key] = words(scene[key], `${where}: "${what}"`, limit);
    };
    some('heading', 'heading', CAPS.heading);
    some('text', 'text', CAPS.text);
    some('say', 'say', CAPS.say);
    some('image_prompt', 'image_prompt', CAPS.image_prompt);
    some('clip_prompt', 'clip_prompt', CAPS.clip_prompt);
    some('portrait_prompt', 'portrait_prompt', CAPS.image_prompt);
    some('asset', 'asset', CAPS.asset);
    if (scene.frame !== undefined && scene.frame !== null) {
      if (!(FRAMES as readonly unknown[]).includes(scene.frame)) throw new Error(`${where}: "frame" must be one of ${FRAMES.join(', ')}`);
      made.frame = scene.frame as string;
    }
    if (scene.bullets !== undefined && scene.bullets !== null) made.bullets = lines(scene.bullets, `${where}: "bullets"`, CAPS.bullets, CAPS.bullet);
    if (scene.labels !== undefined && scene.labels !== null) made.labels = lines(scene.labels, `${where}: "labels"`, CAPS.labels, 28);
    if (scene.seconds !== undefined && scene.seconds !== null) made.seconds = number(scene.seconds, `${where}: "seconds"`, 1, 30);
    if (scene.start !== undefined && scene.start !== null) made.start = number(scene.start, `${where}: "start"`, 0, 3600);
    if (scene.mute !== undefined && scene.mute !== null) made.mute = scene.mute !== false;

    if (NEEDS_HEADING.has(layout) && !made.heading) throw new Error(`${where}: a ${layout} scene needs "heading"`);
    if (NEEDS_TEXT.has(layout) && !made.text) throw new Error(`${where}: a ${layout} scene needs "text"`);
    if (NEEDS_BULLETS.has(layout) && !made.bullets) throw new Error(`${where}: a ${layout} scene needs "bullets"`);
    // A comparison is two things next to each other; one of them is a statement and three of them is a list.
    if (layout === 'compare' && made.bullets?.length !== 2) throw new Error(`${where}: a compare scene needs exactly two "bullets" — the before and the after`);
    // A picture scene must read as something even when no picture can be drawn, so it always carries words of its own.
    if (layout === 'picture' && (!made.image_prompt || !(made.text || made.heading))) throw new Error(`${where}: a picture scene needs "image_prompt" and a caption in "text"`);
    if (layout === 'device' && !made.asset && !made.image_prompt) throw new Error(`${where}: a device scene needs "asset" — the name of a screenshot on the card`);
    if (layout === 'footage' && !made.asset) throw new Error(`${where}: a footage scene needs "asset" — the name of a file dropped on the card`);
    if (layout === 'clip' && !made.clip_prompt) throw new Error(`${where}: a clip scene needs "clip_prompt"`);
    if (layout === 'clip') made.seconds = made.seconds ? Math.min(5, Math.max(3, made.seconds)) : 4;
    if (layout === 'presenter' && !made.say) throw new Error(`${where}: a presenter scene needs "say" — the words the person on screen says`);
    if (layout === 'presenter' && !made.portrait_prompt && !made.asset) throw new Error(`${where}: a presenter scene needs "portrait_prompt" or "asset" — who is on screen`);
    return made;
  });
  const spec: Spec = { title, scenes };
  if (typeof asked.music === 'string' && (MOODS as readonly string[]).includes(asked.music)) spec.music = asked.music as Mood;
  if (typeof asked.pace === 'string' && (PACES as readonly string[]).includes(asked.pace)) spec.pace = asked.pace as Pace;
  if (asked.sfx !== undefined && asked.sfx !== null) spec.sfx = asked.sfx !== false;
  if (asked.captions !== undefined && asked.captions !== null) spec.captions = asked.captions !== false;
  return spec;
}

// What the film is for. A purpose is not a style: it is the shape of the thing — how it opens, how long it holds, what
// it has to end with. The founder picks one on the card and the storyboard is written to it.
export const PURPOSES = ['explainer', 'launch', 'feature', 'ad', 'reel', 'pitch', 'testimonial'] as const;
export type Purpose = (typeof PURPOSES)[number];
export const PURPOSE: Record<Purpose, { name: string; pace: Pace; format: Shape; length: number; music: Mood; captions: boolean; shape: string }> = {
  explainer: {
    name: 'product explainer', pace: 'calm', format: 'wide', length: 60, music: 'calm', captions: false,
    shape: 'Open on a title. Name the problem in one statement, show the product doing the thing (device scenes), then how it works in steps, then one proof — a stat or a quote — and close on a logo.',
  },
  launch: {
    name: 'launch announcement', pace: 'punchy', format: 'wide', length: 30, music: 'bright', captions: true,
    shape: 'Open on a hook: the thing is here. Say what it is in one statement, show it on screen, list what is new as a checklist, and end on a cta with where to get it.',
  },
  feature: {
    name: 'single feature', pace: 'calm', format: 'wide', length: 30, music: 'warm', captions: true,
    shape: 'Open on the moment the feature saves: a compare scene, before and after. Then the feature on screen, then the two or three things it does, then a cta.',
  },
  ad: {
    name: 'marketing ad', pace: 'punchy', format: 'square', length: 30, music: 'drive', captions: true,
    shape: 'Open on a hook that is a problem the viewer has. One statement of the turn. One device or footage scene of the product. One stat as proof. A cta. Nothing else — every scene must earn its seconds.',
  },
  reel: {
    name: 'influencer-style reel', pace: 'punchy', format: 'tall', length: 30, music: 'drive', captions: true,
    shape: 'Open on a hook in the first second — a claim, a number or a question, no title card. Then short scenes that cut fast: what it is, what it replaces, what it costs you not to have it. Talk like a person, not a brochure. End on a cta.',
  },
  pitch: {
    name: 'investor pitch', pace: 'calm', format: 'wide', length: 90, music: 'calm', captions: false,
    shape: 'Open on a title. The problem, sized with a stat. What you built, on screen. Who it is for. Traction as stats. What is next as steps. Close on a logo.',
  },
  testimonial: {
    name: 'customer testimonial', pace: 'calm', format: 'tall', length: 30, music: 'warm', captions: true,
    shape: 'Open on the customer in their own words — a quote or a presenter scene. Then what changed for them as a compare, then one stat, then a short cta. Never put words in a customer\'s mouth that the material does not contain.',
  },
};
export const isPurpose = (value: unknown): value is Purpose => typeof value === 'string' && (PURPOSES as readonly string[]).includes(value);

// How many scenes a film of that length wants, at about the rate a narrated scene really runs.
export const scenesFor = (seconds: number, pace: Pace): [number, number] => {
  const each = pace === 'punchy' ? 2.6 : 5.2;
  const middle = Math.max(3, Math.round(seconds / each));
  return [Math.max(3, Math.round(middle * 0.8)), Math.min(MAX_SCENES, Math.round(middle * 1.25))];
};

// What the film has to work with, gathered before a word of the storyboard is written.
export type Material = { lines: string[]; assets: { name: string; kind: string; what: string }[]; brand?: Brand; using: string[] };

// The brief the model fills in. Everything that can change — the purpose, the length, the material, what is on the
// card, whether AI clips may be spent — is written into it, so the storyboard is about this film and not about films.
export function storyboardPrompt(ask: { brief: string; purpose: Purpose; seconds: number; pace: Pace; shape: Shape; captions: boolean; music: Mood; sfx: boolean; ai: boolean; material: Material }): string {
  const [least, most] = scenesFor(ask.seconds, ask.pace);
  const layouts = LAYOUTS.filter((one) => ask.ai || !AI_LAYOUTS.has(one))
    .filter((one) => one !== 'footage' || ask.material.assets.some((asset) => asset.kind === 'video'))
    .filter((one) => one !== 'device' || ask.material.assets.some((asset) => asset.kind === 'screen'));
  const said = [
    `You are storyboarding a ${ask.seconds}-second ${PURPOSE[ask.purpose].name}, ${ask.shape === 'tall' ? 'shot tall for a phone' : ask.shape === 'square' ? 'square for a feed' : 'wide for a screen'}. Answer with one JSON object and nothing else.`,
    '',
    '{"title": "the film\'s title, a few words", "scenes": [ ... ]}',
    '',
    `Each scene is {"layout": one of ${layouts.join(', ')}, and the fields that layout needs}.`,
    '- title: "heading" is the title, "text" one short line under it.',
    '- hook: "text" is one short line that stops somebody scrolling. "heading" is an optional two-word label over it.',
    '- statement: "text" is one sentence, the point of the scene. "heading" is optional and must be two or three words.',
    '- bullets: "heading" plus two to five short "bullets", a few words each.',
    '- checklist: the same, for things that are done or included.',
    '- steps: the same, for things that happen in order.',
    '- compare: "heading", and exactly two "bullets" — the before and the after. "labels" optionally renames them (["Before","After"], ["Them","Us"]).',
    '- picture: "image_prompt" describes a whole scene to draw (subject, setting, style, light) and "text" is the caption.',
    ...(layouts.includes('device') ? ['- device: "asset" is the name of one of the screenshots listed below, "heading" one short line over it, "frame" one of phone, laptop, browser.'] : []),
    '- stat: "heading" is one number or figure, "text" says what it measures.',
    '- quote: "text" is the quotation, "heading" is who said it.',
    '- logo: "heading" is the product\'s name set as a wordmark, "text" one line under it.',
    '- cta: "text" is what to do, "heading" is where to do it (an address, a handle).',
    ...(layouts.includes('footage') ? ['- footage: "asset" is the name of one of the founder\'s own files listed below, "start" and "seconds" cut into it, "text" is a caption over it, "mute" false keeps its own sound.'] : []),
    ...(ask.ai ? [
      '- clip: "clip_prompt" describes three to five seconds of moving b-roll, "seconds" is how long. Use at most one.',
      '- presenter: "say" is what the person on screen says and "portrait_prompt" describes them. Use at most one.',
    ] : []),
    '- outro: "text" is the closing line.',
    '',
    `Write ${least} to ${most} scenes. ${PURPOSE[ask.purpose].shape}`,
    ask.captions
      ? 'Every scene needs a "say": one or two spoken sentences, written the way someone would read them aloud. They are captioned word by word on screen, so keep them short and spoken, not written.'
      : 'Give every scene a "say": one or two spoken sentences, written the way someone would read them aloud.',
    `Keep "heading" under ${CAPS.heading} characters, "text" under ${CAPS.text}, each bullet under ${CAPS.bullet}. Plain words, no exclamation marks, no hashtags, no emoji.`,
    ask.pace === 'punchy' ? 'This one cuts fast: one idea a scene, short lines, no scene that takes more than a breath to read.' : 'This one has room: let a scene land before the next one starts.',
  ];
  if (ask.material.assets.length) {
    said.push('', 'These are on the card already, and the film should be built around them. Name one in "asset" exactly as it is written here:');
    for (const asset of ask.material.assets) said.push(`- ${asset.name} — ${asset.what}`);
  }
  if (ask.material.lines.length) {
    said.push('', 'This is the product, in its own words. Use its real words and its real claims; never invent a feature, a number or a customer it does not have:', '', ...ask.material.lines);
  }
  said.push('', 'The brief:', ask.brief);
  return said.join('\n');
}

// The model writes the storyboard, and gets exactly one more go with the reason its first answer could not be used.
export async function storyboardOf(brief: string, think: (prompt: string) => Promise<string>): Promise<Spec> {
  let problem = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const said = await think(`${brief}${problem ? `\n\nYour last answer could not be used: ${problem}\nAnswer again, JSON only.` : ''}`);
    try {
      const body = said.slice(said.indexOf('{'), said.lastIndexOf('}') + 1);
      if (!body) throw new Error('the answer held no JSON object');
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { throw new Error('the answer was not valid JSON'); }
      return parseSpec(parsed);
    } catch (error) { problem = (error as Error).message; }
  }
  throw new Error(`the storyboard could not be written: ${problem}`);
}

// A storyboard costs nothing to write and everything to render, so what came back is brought inside the caps rather
// than thrown away: too many drawn stills become statements, a third AI scene becomes what it would have fallen back
// to, and a scene naming an asset that is not there loses the name.
export function withinCaps(spec: Spec, allow: { ai: boolean; assets: string[] }): { spec: Spec; notes: string[] } {
  const notes: string[] = [];
  let drawn = 0;
  let spent = 0;
  const scenes = spec.scenes.map((scene): Scene => {
    if (scene.layout === 'picture') {
      drawn += 1;
      if (drawn > MAX_IMAGES) { notes.push(`scene ${spec.scenes.indexOf(scene) + 1} is written out in words: a film draws at most ${MAX_IMAGES} pictures`); return { ...scene, layout: 'statement', text: scene.text || scene.heading || '', image_prompt: undefined }; }
    }
    if (AI_LAYOUTS.has(scene.layout)) {
      spent += 1;
      if (!allow.ai || spent > MAX_AI) return fallbackOf(scene, allow.ai ? `a film makes at most ${MAX_AI} AI scenes` : 'AI clips are switched off');
    }
    if ((scene.layout === 'footage' || scene.layout === 'device') && scene.asset && !allow.assets.includes(scene.asset)) {
      return fallbackOf({ ...scene, asset: undefined }, `there is nothing on the card called "${scene.asset}"`);
    }
    return scene;
  });
  return { spec: { ...spec, scenes }, notes };
}

// What a scene becomes when the thing it needed could not be made or found. A clip keeps its words as a picture if it
// had any, and a presenter keeps saying what it was going to say — the film is never a scene shorter for it.
export function fallbackOf(scene: Scene, why: string): Scene {
  if (scene.layout === 'clip') return { layout: 'picture', image_prompt: scene.clip_prompt ?? scene.text ?? 'an abstract product still, soft light', text: scene.text || scene.heading || ' ', say: scene.say, heading: scene.heading };
  if (scene.layout === 'presenter') return { layout: 'statement', text: scene.text || scene.say || '', say: scene.say, heading: scene.heading };
  if (scene.layout === 'device') return { layout: 'statement', text: scene.text || scene.heading || '', say: scene.say };
  if (scene.layout === 'footage') return { layout: 'statement', text: scene.text || scene.heading || '', say: scene.say };
  return { ...scene, layout: 'statement', text: scene.text || scene.heading || why };
}

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

// What a video studio was asked for: the brief in `prompt`, everything the founder set on the card, and for a person
// the storyboard itself.
export type VideoAsk = {
  prompt: string; format?: string; look?: string; narrate?: boolean; spec?: Spec; cardId?: string;
  purpose?: string; length?: number; pace?: string; music?: string; sfx?: boolean; captions?: boolean;
  ai?: boolean; address?: string; voice?: string;
};

// The other half of the studio: what it can read, what it can photograph, what it can film with.
export type VideoDeps = {
  dir: string; images?: Maker; voices?: Maker; think: (prompt: string) => Promise<string>;
  clips?: Clips; forbidden?: string[];
  stage?: () => Promise<Stage>;
  assets?: (cardId: string) => Promise<MediaAsset[]>;
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

// Where each of a page's shots is taken from: the top, then what is under it, on a desktop and on a phone.
const SCROLLS = { desktop: [0, 780, 1700], mobile: [0, 900] };

// The renderer: our own scenes written as one HTML page, which headless Chrome steps through frame by frame and ffmpeg
// turns into an MP4. Nothing leaves this machine except what the founder wired to the card, and the same storyboard
// always renders the same film.
export function hyperframesVideos(deps: VideoDeps): Maker {
  const bin = resolve(import.meta.dirname, '../../node_modules/.bin/hyperframes');
  const vendor = resolve(import.meta.dirname, 'templates/vendor');
  const clips = deps.clips ?? noClips;

  // Everything wired to the card, read once: the product's own words and colours, its screens as pictures, the
  // founder's own files, and whatever a note, a doc or a picture card beside it says.
  async function gather(asked: VideoAsk, at: string, shape: Shape, report: (line: string) => void, signal?: AbortSignal) {
    const material: Material = { lines: [], assets: [], using: [] };
    // What the storyboard may name in `asset`. `where` says whether the file already sits in this job's own assets
    // folder (a screenshot we just took) or in the shared files (something the founder dropped).
    const files = new Map<string, { file: string; kind: 'screen' | 'video' | 'image' | 'audio'; where: 'job' | 'files'; seconds?: number }>();
    const stage = await deps.stage?.().catch(() => undefined);
    const cards = stage && asked.cardId ? wiredTo(stage, asked.cardId) : [];
    const addresses: { url: string; own: boolean; label: string }[] = [];
    if (asked.address?.trim()) addresses.push({ url: asked.address.trim(), own: true, label: asked.address.trim() });

    for (const card of cards) {
      try {
        if (card.kind === 'project' && card.path) {
          const product = await readProject(projectDir(card.path, deps.forbidden ?? []));
          if (product.words) material.lines.push(product.words);
          if (product.brand.colours.length || product.brand.font) material.brand = product.brand;
          material.using.push(`${product.name ?? 'the'} project`);
          if (product.font) await writeFile(join(at, 'vendor', product.font.name), product.font.bytes);
          if (product.logo && /\.(png|jpe?g|webp)$/i.test(product.logo.name)) {
            await writeFile(join(at, 'assets', `logo-${product.logo.name}`), product.logo.bytes);
            files.set('logo', { file: `logo-${product.logo.name}`, kind: 'image', where: 'job' });
          }
        } else if (card.kind === 'link' && card.url) addresses.push({ url: card.url, own: false, label: card.url });
        else if (card.kind === 'browser') {
          const where = await deps.browser?.where(`card-${card.id}`).catch(() => null);
          if (where && !/^about:/.test(where)) addresses.push({ url: where, own: false, label: where });
        } else if (card.kind === 'note' && card.text?.trim()) { material.lines.push(`A note on the stage:\n${card.text.slice(0, 1600)}`); material.using.push('a note'); }
        else if (card.kind === 'image' && card.path) {
          const bytes = await deps.readFile?.(card.path).catch(() => null);
          if (bytes) { const name = `card-${files.size}.png`; await writeFile(join(at, 'assets', name), bytes); files.set(name, { file: name, kind: 'image', where: 'job' }); material.assets.push({ name, kind: 'image', what: 'a picture the founder put on the stage' }); }
        }
      } catch (error) { report(`could not read ${card.kind === 'project' ? card.path : card.kind}: ${(error as Error).message}`); }
    }
    // Documents wired to the card are words, the same as a note is.
    for (const doc of stage?.docs ?? []) {
      if (!(stage!.wires ?? []).some((wire) => (wire.from === asked.cardId && wire.to === doc.id) || (wire.to === asked.cardId && wire.from === doc.id))) continue;
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
    return { material, files, bed, shape };
  }

  return {
    name: 'Hyperframes',
    ready: () => (chromePath() ? null : SETUP_HINT),
    async make(ask, { report, signal }): Promise<Piece> {
      const asked = ask as VideoAsk;
      const purpose: Purpose = isPurpose(asked.purpose) ? asked.purpose : 'explainer';
      const preset = PURPOSE[purpose];
      const shape: Shape = (FORMATS[asked.format as Shape] ? asked.format : preset.format) as Shape;
      const look: Look = (LOOKS as readonly string[]).includes(asked.look ?? '') ? asked.look as Look : 'clean';
      const pace: Pace = (PACES as readonly string[]).includes(asked.pace ?? '') ? asked.pace as Pace : preset.pace;
      const seconds = (LENGTHS as readonly number[]).includes(Number(asked.length)) ? Number(asked.length) : preset.length;
      const mood: Mood = (MOODS as readonly string[]).includes(asked.music ?? '') ? asked.music as Mood : preset.music;
      const captions = asked.captions ?? preset.captions;
      const sfx = asked.sfx !== false;

      const at = join(deps.dir, '.video', Date.now().toString(36));
      try {
        await mkdir(join(at, 'assets'), { recursive: true });
        await mkdir(join(at, 'vendor'), { recursive: true });
        for (const file of ['gsap.min.js', 'inter.woff2', ...(look === 'sketch' ? ['rough.js'] : [])]) await copyFile(join(vendor, file), join(at, 'vendor', file));

        const { material, files, bed } = await gather(asked, at, shape, report, signal);
        if (material.using.length) report(`using: ${material.using.join(', ')}`);
        const brand = look === 'brand' ? material.brand : undefined;
        if (look === 'brand' && !brand) report('no product colours were found, so the film is set in the clean look');

        const wanted = asked.spec ?? await (async () => {
          report('writing the storyboard…');
          return storyboardOf(storyboardPrompt({ brief: asked.prompt, purpose, seconds, pace, shape, captions, music: mood, sfx, ai: asked.ai === true, material }), deps.think);
        })();
        const able = asked.ai === true && !clips.ready();
        if (asked.ai === true && !able) report(`AI clips are switched on but not ready: ${clips.ready()}`);
        const { spec, notes } = withinCaps(wanted, { ai: able, assets: [...files.keys()] });
        for (const note of notes) report(note);
        report(`${spec.scenes.length} scenes: ${spec.title}`);

        const drawing = deps.images && !deps.images.ready() ? deps.images : null;
        const saying = deps.voices && !deps.voices.ready() && asked.narrate !== false ? deps.voices : null;
        if (!drawing && spec.scenes.some((scene) => scene.layout === 'picture')) report('no picture maker is set up, so those scenes are written out in words');
        const { width, height } = FORMATS[shape];
        // `null` here means ffmpeg answered; anything else is the line the founder is told instead.
        const noFf = await ffReady();
        if (noFf && (spec.scenes.some((scene) => scene.layout === 'footage') || (mood !== 'none' && bed))) report(noFf);

        report('drawing the pictures and recording the narration…');
        const shots: Shot[] = spec.scenes.map((scene) => ({ scene, seconds: 0 }));
        const said = (index: number, line: string) => report(`scene ${index + 1}: ${line}`);

        // Everything a scene needs is made beside everything else: the stills, the lines, the clips and the founder's
        // own footage are the slow part, and none of them waits on another.
        await Promise.all(spec.scenes.map(async (scene, index) => {
          const shot = shots[index];
          // Where a named asset really is: in this job's assets already, or still out in the shared files.
          const named = scene.asset ? files.get(scene.asset) : undefined;
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
              .then(() => { shot.video = cut; }, (error: Error) => { said(index, `that clip could not be used (${error.message}), so the scene is its words instead`); shot.scene = fallbackOf(scene, error.message); });
          }
          if (drawing && (scene.layout === 'picture' || scene.layout === 'logo') && scene.image_prompt && !shot.image) {
            try {
              const piece = await drawing.make({ prompt: scene.image_prompt, shape }, { report: () => {}, signal });
              shot.image = `shot-${index}.${piece.ext}`;
              await writeFile(join(at, 'assets', shot.image), piece.bytes);
            } catch (error) { said(index, `no picture: ${(error as Error).message}`); }
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
              const still = drawing ? await drawing.make({ prompt: scene.clip_prompt!, shape }, { report: () => {}, signal }).then((one) => one.bytes, () => undefined) : undefined;
              const made = await clips.broll({ prompt: scene.clip_prompt!, image: still, seconds: scene.seconds ?? 4 }, { report: (line) => said(index, line), signal });
              shot.video = `clip-${index}.mp4`;
              await writeFile(join(at, 'assets', shot.video), made.bytes);
            } catch (error) {
              said(index, `the clip could not be made (${(error as Error).message}), so the scene is a picture instead`);
              shot.scene = fallbackOf(scene, (error as Error).message);
              if (drawing && shot.scene.image_prompt) {
                await drawing.make({ prompt: shot.scene.image_prompt, shape }, { report: () => {}, signal })
                  .then(async (piece) => { shot.image = `shot-${index}.${piece.ext}`; await writeFile(join(at, 'assets', shot.image), piece.bytes); }, () => { shot.scene = { ...shot.scene, layout: 'statement' }; });
              } else shot.scene = { ...shot.scene, layout: 'statement' };
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
              shot.scene = fallbackOf(scene, (error as Error).message);
            }
          }
        }));
        if (signal?.aborted) throw new Error('stopped');

        // A scene whose picture never arrived becomes the words it carries, so a founder with no picture key still
        // gets a film, and every scene is as long as the line said over it.
        for (const shot of shots) {
          const layout = shot.scene.layout;
          if ((layout === 'picture' || layout === 'device' || layout === 'logo') && !shot.image && layout !== 'logo') shot.scene = fallbackOf(shot.scene, 'nothing to show');
          if ((layout === 'footage' || layout === 'clip' || layout === 'presenter') && !shot.video && !shot.image) shot.scene = fallbackOf(shot.scene, 'nothing to show');
          const on = [shot.scene.heading, shot.scene.text, ...(shot.scene.bullets ?? [])].filter(Boolean).join(' ');
          shot.seconds = sceneSeconds(on, shot.voice?.seconds ?? 0, pace);
          // A piece of footage is only as long as the piece of footage.
          if (shot.video && shot.scene.layout === 'footage' && shot.scene.seconds) shot.seconds = Math.max(shot.seconds, shot.scene.seconds);
        }
        const starts: number[] = [];
        let clock = 0;
        for (const shot of shots) { starts.push(clock); clock = Math.round((clock + shot.seconds) * 100) / 100; }
        const total = clock;

        // The sounds the film is cut with, and the bed under it, ducked where somebody is speaking.
        const cues = sfx ? cuesOf(shots, starts, pace) : [];
        for (const sound of new Set(cues.map((one) => one.sound))) {
          await copyFile(join(SFX_DIR, sfxFile(sound)), join(at, 'assets', sfxFile(sound))).catch(() => {});
        }
        let music: { file: string; seconds: number } | undefined;
        if (mood !== 'none' && !noFf) {
          if (!bed) report('no music is bundled with the studio — drop a music file on the card and the next film will have a bed under it');
          else {
            report('mixing the music under the narration…');
            const from = deps.fileOf?.(bed.path) ?? bed.path;
            const windows = shots.map((shot, index) => ({ at: starts[index] + 0.35, seconds: shot.voice?.seconds ?? 0 })).filter((one) => one.seconds > 0);
            await musicBed({ from, to: join(at, 'assets', 'bed.wav'), seconds: total, mood, windows, signal })
              .then(() => { music = { file: 'bed.wav', seconds: total }; }, (error: Error) => report(`the music could not be mixed: ${error.message}`));
          }
        }

        await writeFile(join(at, 'index.html'), composition({ title: spec.title, shape, look: look === 'brand' && !brand ? 'clean' : look, shots, pace, captions, brand, bed: music, cues }));
        await writeFile(join(at, 'hyperframes.json'), projectFile);

        // A finding here is worth saying out loud, but it is not worth withholding the film over: render either way.
        report('checking the composition…');
        const checked = await run(bin, ['check', '.'], at, () => {}, signal);
        if (checked.code !== 0) report(`the check was not happy: ${(checked.out.match(/^.*(error|warning|finding).*$/im)?.[0] ?? 'see the render').trim().slice(0, 160)}`);

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
        await run(bin, ['snapshot', '.', '--at', (shots[0].seconds * 0.6).toFixed(2), '--no-end', '--describe=false', '-o', 'poster'], at, () => {}, signal);
        const shot = (await readdir(join(at, 'poster')).catch(() => [])).find((name) => name.endsWith('.png'));
        if (shot) poster = { ext: 'png', bytes: await readFile(join(at, 'poster', shot)) };
        return { ext: 'mp4', bytes, poster };
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
    report(`${spec.scenes.length} scenes: ${spec.title}`);
    report('rendering 6 seconds…');
    return { ext: 'mp4', bytes: Buffer.from(CLIP, 'base64'), poster: { ext: 'png', bytes: Buffer.from(POSTER, 'base64') } };
  },
};
