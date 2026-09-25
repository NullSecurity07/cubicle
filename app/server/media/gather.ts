import { writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Card, MediaAsset, Stage } from '../../shared/model.ts';
import { projectDir } from '../folder.ts';
import { createLibrary } from '../library/notes.ts';
import type { Clips } from './clips.ts';
import type { Material } from './director.ts';
import type { FilmRecord } from './edits.ts';
import type { Maker } from './jobs.ts';
import type { Music } from './music.ts';
import type { Sight } from './sight.ts';
import { readProject, VIEWPORTS } from './sources.ts';
import type { Spec } from './spec.ts';
import type { Stock } from './stock.ts';

// What a film may draw on, and how it is found: what a video studio is asked for, what it can reach, and the one
// read of everything the founder wired to it before a word of the film is written.

// What a video studio was asked for: the brief in `prompt`, everything the founder set on the card — where 'auto' and
// nothing at all both mean "you decide" — and for a person who wrote one, the storyboard itself.
export type VideoAsk = {
  prompt: string; format?: string; look?: string; narrate?: boolean; spec?: Spec; cardId?: string;
  purpose?: string; length?: number | string; pace?: string; music?: string; sfx?: boolean; captions?: boolean;
  ai?: boolean | string; address?: string; voice?: string;
  // The voice engine, set by the founder by hand or not at all, and for OmniVoice the few words its voice is designed from.
  engine?: string; design?: string;
  // How long the founder is willing to wait: 'draft' is the film to look at before the film, 'full' and nothing are the film.
  speed?: string;
  // Who asked for the film. A person's own wires are the founder pointing at things just as much as the studio's
  // are, so what is joined to them is joined to the film.
  roomId?: string;
  // Docs that person wrote this turn, which the film may read although no wire covers them yet.
  granted?: { id: string; title: string }[];
  // Pictures the caller named outright — paths a person got back from drawing one, or the word "latest".
  images?: string[];
  // Notes on a finished film: the film's path in the shared files, and the record kept beside it. The notes
  // themselves are `prompt`.
  edit?: string; record?: FilmRecord;
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
  // Something that can look at a picture once it is drawn: whether anybody in it is staring down the lens, whether
  // it came back with writing on it, and how far away each part of it is. Without one a film is made from
  // pictures nobody looked at, which is what every film was until a proof came back with two strangers in it.
  sight?: Sight;
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
// A browser card is one too: the page it has open is what the founder pointed that person at.
const THEIRS = new Set<Card['kind']>(['imagegen', 'image', 'note', 'link', 'project', 'browser']);

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

// The documents a film may read: the ones wired to the studio, the ones wired to whoever is making it, every
// pinned doc (which every person reads each turn, wired or not, as `readableDocIds` in prompt.ts says), and the
// ones that person wrote this very turn, which no wire covers yet and are not on the stage until the page puts them
// there. Pinned and wired docs come in the stage's own order; the ones written this turn follow.
export const docsFor = (stage: Stage, cardId?: string, roomId?: string, granted: string[] = []): string[] => {
  const ends = new Set((stage.wires ?? []).flatMap((wire) => {
    if ((cardId && wire.from === cardId) || (roomId && wire.from === roomId)) return [wire.to];
    if ((cardId && wire.to === cardId) || (roomId && wire.to === roomId)) return [wire.from];
    return [];
  }));
  const onStage = (stage.docs ?? []).filter((doc) => doc.pinned || ends.has(doc.id)).map((doc) => doc.id);
  return [...new Set([...onStage, ...granted])];
};

// Where each of a page's shots is taken from: the top, then what is under it, on a desktop and on a phone.
const SCROLLS = { desktop: [0, 780, 1700], mobile: [0, 900] };

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
        // A website the founder trusts is a page to photograph exactly as a link is.
        else if (card.kind === 'source' && card.url) addresses.push({ url: card.url, own: false, label: card.title || card.url });
        // A note out of the founder's library is words, the same as a note on the stage.
        else if (card.kind === 'library' && card.noteId) {
          const library = createLibrary(deps.dir);
          const text = await library.read(card.noteId);
          if (text?.trim()) {
            const title = (await library.list()).find((one) => one.id === card.noteId)?.title ?? card.noteId;
            material.lines.push(`${title}:\n${text.slice(0, 2400)}`);
            material.using.push(title);
          }
        }
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
    const granted = asked.granted ?? [];
    const readable = stage ? docsFor(stage, asked.cardId, asked.roomId, granted.map((one) => one.id)) : [];
    for (const id of readable) {
      const title = stage?.docs.find((doc) => doc.id === id)?.title ?? granted.find((one) => one.id === id)?.title ?? 'a document';
      const text = await deps.readDoc?.(id).catch(() => '');
      if (text?.trim()) { material.lines.push(`${title}:\n${text.slice(0, 2400)}`); material.using.push(title); }
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
