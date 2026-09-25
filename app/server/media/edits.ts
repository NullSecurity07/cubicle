import { hashOf } from './hash.ts';
import type { Shape } from '../../shared/model.ts';
import { MOODS, type Mood } from './audio.ts';
import { CAPS, type Scene, type Spec } from './spec.ts';
import { isPack, PACKS, PACES, type Pack, type Pace } from './templates/looks.ts';
import type { Word } from './timings.ts';
import type { Brand } from './templates/packs.ts';
import { VOICES } from './voice.ts';
import { OMNI_ENGINE } from './omnivoice.ts';

// Notes on a finished film, and what they change.
//
// A founder who watched a film and wants one shot shorter should not wait for the whole film again. Everything a
// film was made of is written down beside it (`<film>.film.json`), and a note is read into one of a small, fixed
// list of operations on that record. Applying them is deterministic: the same notes on the same film make the same
// storyboard, and the studio then remakes only what they touched.

// --- what a film remembers about itself ---------------------------------------------------------------------------

// One shot of a finished film, as the renderer drew it. Files are names in the film's parts folder.
export type RecordShot = {
  take: number; seconds: number;
  image?: string; bg?: string; video?: string; bgShared?: boolean;
  scrim?: number; lift?: number; plies?: { back: string; mid: string; fore: string };
  // A presenter's own line, cut out of the film's one reading.
  voice?: { file: string; seconds: number };
};
// A picture in the parts folder and what made it. `hash` is the inputs it was made from, so a note that leaves those
// alone leaves the picture alone. `subject` is the prompt without the look's own style line in front of it.
// `credit` is who took a stock photograph and where it lives, carried into every version's credits.
export type RecordPicture = { hash: string; kind: 'drawn' | 'stock' | 'given' | 'video'; subject?: string; credit?: string };
// Where a scene's line sits in the film's one reading, and every word of it on that segment's own clock.
export type RecordLine = { from: number; to: number; words: Word[]; hash: string };
export type RecordScene = { shots: RecordShot[]; line?: RecordLine };
export type FilmRecord = {
  kind: 'film'; version: number;
  // The film this one was edited from, and the first of the line, so every version can be listed under it.
  root?: string; from?: string; notes?: string; credits?: string;
  title: string; spec: Spec; shape: Shape; look: Pack; pace: Pace; captions: boolean; sfx: boolean; music: Mood;
  // The look's own line about how pictures are taken in it, which every drawn picture's prompt opens with.
  bible: string;
  // A product's own colours, for the look that wears them.
  brand?: Brand;
  narrator?: { voice: string; engine?: string; design?: string; file: string; seconds: number };
  scenes: RecordScene[];
  pictures: Record<string, RecordPicture>;
  // The bed as it was written or dropped, before it was ducked under this film's narration.
  bed?: { source: string; mood: Mood; own?: boolean; credit?: { title: string; by: string; licence: string; source: string } };
};

const hash = (...parts: unknown[]): string => hashOf(16, ...parts);
// What decides a drawn picture: the words it was drawn from, the look they were drawn in, and the frame.
export const pictureHash = (subject: string, bible: string, shape: string): string => hash('picture', subject.trim(), bible, shape);
// What decides a spoken line: the words, the voice, and whatever reads it.
export const lineHash = (say: string, voice: string, engine = '', design = ''): string => hash('line', say.trim(), voice, engine, design);

export const isRecord = (raw: unknown): raw is FilmRecord =>
  !!raw && typeof raw === 'object' && (raw as FilmRecord).kind === 'film' && Array.isArray((raw as FilmRecord).spec?.scenes)
  && Array.isArray((raw as FilmRecord).scenes) && (raw as FilmRecord).scenes.length === (raw as FilmRecord).spec.scenes.length;

// --- the operations ---------------------------------------------------------------------------------------------

// A scene is named the way a founder names it: by its number as the card shows it, from one, or by a few words of
// what is said or written on it.
export type SceneRef = number | string;
export type EditOp =
  | { op: 'trim'; scene: SceneRef; seconds?: number }
  | { op: 'drop'; scene: SceneRef }
  | { op: 'move'; scene: SceneRef; before: SceneRef | 'end' }
  | { op: 'swap_picture'; scene: SceneRef; prompt?: string; asset?: string }
  | { op: 'redo_line'; scene: SceneRef; say: string }
  | { op: 'retitle'; scene: SceneRef; heading?: string; text?: string }
  | { op: 'pace'; pace: Pace }
  | { op: 'look'; look: Pack }
  | { op: 'music'; mood: Mood }
  | { op: 'captions'; on: boolean }
  | { op: 'voice'; voice?: string; engine?: string };
export const OPS = ['trim', 'drop', 'move', 'swap_picture', 'redo_line', 'retitle', 'pace', 'look', 'music', 'captions', 'voice'] as const;

const bare = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();

// Which scene a reference means, as an index into the film's scenes, or why it means none.
export function sceneOf(ref: SceneRef, scenes: Scene[]): number | string {
  if (typeof ref === 'number') {
    if (!Number.isInteger(ref) || ref < 1 || ref > scenes.length) return `there is no shot ${ref}: the film has ${scenes.length}`;
    return ref - 1;
  }
  const said = String(ref ?? '').trim();
  if (/^\d+$/.test(said)) return sceneOf(Number(said), scenes);
  if (/^(first|opening)$/i.test(said)) return 0;
  if (/^(last|final|closing)$/i.test(said)) return scenes.length - 1;
  const want = bare(said);
  if (!want) return 'a shot has to be named by its number or by a few of its words';
  const found = scenes.flatMap((scene, at) => (bare([scene.say, scene.heading, scene.text, ...(scene.bullets ?? [])].filter(Boolean).join(' ')).includes(want) ? [at] : []));
  if (!found.length) return `no shot says "${said}"`;
  if (found.length > 1) return `"${said}" is in shots ${found.map((one) => one + 1).join(' and ')}; say which by number`;
  return found[0];
}

const text = (value: unknown, cap: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim().replace(/^["“”']+|["“”']+$/g, '').trim();
  return clean ? clean.slice(0, cap) : undefined;
};
const ref = (value: unknown): SceneRef | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return /^\d+$/.test(value.trim()) ? Number(value.trim()) : value.trim();
  return undefined;
};

// One operation, checked by hand, so whatever is wrong comes back as a sentence somebody can act on.
export function parseOp(raw: unknown): EditOp {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('an edit must be an object with "op"');
  const one = raw as Record<string, unknown>;
  const scene = ref(one.scene);
  const needScene = (): SceneRef => { if (scene === undefined) throw new Error(`"${String(one.op)}" needs "scene"`); return scene; };
  switch (one.op) {
    case 'trim': {
      const seconds = one.seconds === undefined || one.seconds === null ? undefined : Number(one.seconds);
      if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 60)) throw new Error('"trim" wants "seconds" between 0.5 and 60');
      return { op: 'trim', scene: needScene(), ...(seconds !== undefined ? { seconds: Math.round(seconds * 10) / 10 } : {}) };
    }
    case 'drop': return { op: 'drop', scene: needScene() };
    case 'move': {
      const before = one.before === 'end' ? 'end' : ref(one.before);
      if (before === undefined) throw new Error('"move" needs "before": a shot, or "end"');
      return { op: 'move', scene: needScene(), before };
    }
    case 'swap_picture': {
      const prompt = text(one.prompt, CAPS.image_prompt);
      const asset = text(one.asset, 240);
      return { op: 'swap_picture', scene: needScene(), ...(prompt ? { prompt } : {}), ...(asset ? { asset } : {}) };
    }
    case 'redo_line': {
      const say = text(one.say, CAPS.say);
      if (!say) throw new Error('"redo_line" needs "say": the new line, word for word');
      return { op: 'redo_line', scene: needScene(), say };
    }
    case 'retitle': {
      const heading = text(one.heading, CAPS.heading);
      const words = text(one.text, CAPS.text);
      if (!heading && !words) throw new Error('"retitle" needs "heading" or "text"');
      return { op: 'retitle', scene: needScene(), ...(heading ? { heading } : {}), ...(words ? { text: words } : {}) };
    }
    case 'pace':
      if (!(PACES as readonly unknown[]).includes(one.pace)) throw new Error(`"pace" is one of ${PACES.join(', ')}`);
      return { op: 'pace', pace: one.pace as Pace };
    case 'look':
      if (!isPack(one.look)) throw new Error(`"look" is one of ${PACKS.join(', ')}`);
      return { op: 'look', look: one.look };
    case 'music': {
      const mood = one.mood === undefined && (one.none === true || one.music === 'none') ? 'none' : one.mood;
      if (!(MOODS as readonly unknown[]).includes(mood)) throw new Error(`"music" wants "mood": one of ${MOODS.join(', ')}`);
      return { op: 'music', mood: mood as Mood };
    }
    case 'captions': {
      const on = one.on === true || one.on === 'on' ? true : one.on === false || one.on === 'off' ? false : undefined;
      if (on === undefined) throw new Error('"captions" wants "on": true or false');
      return { op: 'captions', on };
    }
    case 'voice': {
      const voice = typeof one.voice === 'string' ? voiceNamed(one.voice) : undefined;
      const engine = one.engine === OMNI_ENGINE || one.engine === 'kokoro' ? one.engine : undefined;
      if (!voice && !engine) throw new Error(`"voice" wants a voice (${VOICES.slice(0, 4).map((v) => v.id).join(', ')}…) or an engine (kokoro, ${OMNI_ENGINE})`);
      return { op: 'voice', ...(voice ? { voice } : {}), ...(engine ? { engine } : {}) };
    }
    default: throw new Error(`"${String(one.op)}" is not an edit; the edits are ${OPS.join(', ')}`);
  }
}

// A voice by its id or by the name a founder would say: "Emma", "af_bella".
export const voiceNamed = (said: string): string | undefined => {
  const want = said.trim().toLowerCase();
  return VOICES.find((one) => one.id === want || one.who.toLowerCase() === want)?.id;
};

// --- an edit, in words ------------------------------------------------------------------------------------------

const shotWords = (ref: SceneRef) => (typeof ref === 'number' ? `shot ${ref}` : `the shot that says "${ref}"`);
export function opWords(op: EditOp): string {
  switch (op.op) {
    case 'trim': return op.seconds ? `${shotWords(op.scene)} to ${op.seconds} seconds` : `${shotWords(op.scene)} trimmed to its line`;
    case 'drop': return `${shotWords(op.scene)} dropped`;
    case 'move': return `${shotWords(op.scene)} moved ${op.before === 'end' ? 'to the end' : `before ${shotWords(op.before)}`}`;
    case 'swap_picture': return `a new picture in ${shotWords(op.scene)}${op.prompt ? ` (${op.prompt})` : op.asset ? ` (${op.asset.split('/').pop()})` : ''}`;
    case 'redo_line': return `${shotWords(op.scene)} now says "${op.say}"`;
    case 'retitle': return `${shotWords(op.scene)} now reads "${op.heading ?? op.text}"`;
    case 'pace': return op.pace === 'punchy' ? 'cut faster' : 'cut slower';
    case 'look': return `the ${op.look} look`;
    case 'music': return op.mood === 'none' ? 'no music' : `${op.mood} music`;
    case 'captions': return op.on ? 'captions on' : 'captions off';
    case 'voice': return `read by ${op.voice ? VOICES.find((one) => one.id === op.voice)?.who ?? op.voice : op.engine}`;
  }
}
export const opsWords = (ops: EditOp[]): string => ops.map(opWords).join(', ');

// --- applying them ---------------------------------------------------------------------------------------------

// What a scene of the new film is, and what about it changed. `was` is its place in the film it came from.
export type EditedScene = {
  was: number; scene: Scene;
  picture?: { prompt?: string; asset?: string };
  line?: boolean;
  // Seconds asked for, or 0 for "as tight as its line".
  trim?: number;
};
export type Edited = {
  spec: Spec; scenes: EditedScene[];
  look: Pack; pace: Pace; captions: boolean; music: Mood;
  voice?: string; engine?: string;
  // What could not be done, in words: a reference to a shot that is not there, a drop that would leave nothing.
  problems: string[];
  // The ops that were really applied, so the credits say what the film is.
  done: EditOp[];
};

// The operations laid onto the film, in the order given. Shots are named by where they were in the film as
// watched, so "drop shot 2, trim shot 3" means the third shot the founder saw, not the third one left.
export function applyEdits(record: FilmRecord, ops: EditOp[]): Edited {
  const problems: string[] = [];
  const done: EditOp[] = [];
  const scenes: (EditedScene & { gone?: boolean })[] = record.spec.scenes.map((scene, was) => ({ was, scene: { ...scene } }));
  const settings = { look: record.look, pace: record.pace, captions: record.captions, music: record.music, voice: undefined as string | undefined, engine: undefined as string | undefined };
  const find = (ref: SceneRef): number | null => {
    const at = sceneOf(ref, record.spec.scenes);
    if (typeof at === 'string') { problems.push(at); return null; }
    if (scenes.find((one) => one.was === at)?.gone) { problems.push(`${shotWords(ref)} is already dropped`); return null; }
    return at;
  };
  const one = (was: number) => scenes.find((scene) => scene.was === was)!;
  for (const op of ops) {
    switch (op.op) {
      case 'drop': {
        const at = find(op.scene);
        if (at === null) continue;
        if (scenes.filter((scene) => !scene.gone).length <= 1) { problems.push('a film has to keep one shot'); continue; }
        one(at).gone = true;
        break;
      }
      case 'trim': {
        const at = find(op.scene);
        if (at === null) continue;
        one(at).trim = op.seconds ?? 0;
        break;
      }
      case 'move': {
        const at = find(op.scene);
        if (at === null) continue;
        const before = op.before === 'end' ? 'end' : find(op.before);
        if (before === null || before === at) continue;
        const moving = one(at);
        scenes.splice(scenes.indexOf(moving), 1);
        if (before === 'end') scenes.push(moving);
        else scenes.splice(scenes.indexOf(one(before)), 0, moving);
        break;
      }
      case 'swap_picture': {
        const at = find(op.scene);
        if (at === null) continue;
        one(at).picture = { ...(op.prompt ? { prompt: op.prompt } : {}), ...(op.asset ? { asset: op.asset } : {}) };
        if (op.prompt && one(at).scene.layout === 'picture') one(at).scene.image_prompt = op.prompt;
        break;
      }
      case 'redo_line': {
        const at = find(op.scene);
        if (at === null) continue;
        one(at).scene.say = op.say;
        one(at).line = true;
        break;
      }
      case 'retitle': {
        const at = find(op.scene);
        if (at === null) continue;
        if (op.heading) one(at).scene.heading = op.heading;
        if (op.text) one(at).scene.text = op.text;
        break;
      }
      case 'pace': settings.pace = op.pace; break;
      case 'look': settings.look = op.look; break;
      case 'music': settings.music = op.mood; break;
      case 'captions': settings.captions = op.on; break;
      case 'voice':
        if (op.voice) settings.voice = op.voice;
        if (op.engine) settings.engine = op.engine;
        break;
    }
    done.push(op);
  }
  const kept = scenes.filter((scene) => !scene.gone).map(({ gone: _gone, ...scene }) => scene);
  const spec: Spec = { ...record.spec, scenes: kept.map((one) => one.scene), pace: settings.pace, pack: settings.look, captions: settings.captions, music: settings.music };
  return { spec, scenes: kept, ...settings, problems, done };
}

// --- what can be kept --------------------------------------------------------------------------------------------

// Which of the new film's parts are the old film's, before anything is made. The same sums say what the card is
// told and what the remake does, so the line "kept 6 of 8 pictures" is never a guess.
export type Reuse = {
  // For each new scene: whether its pictures are the old ones and whether its line is the old recording.
  pictures: ('keep' | 'draw')[];
  lines: ('keep' | 'say' | 'none')[];
  keptPictures: number; drawPictures: number; keptLines: number; sayLines: number;
};
export function reuseOf(record: FilmRecord, edited: Edited, bible = record.bible): Reuse {
  const reread = !!edited.voice || (!!edited.engine && edited.engine !== (record.narrator?.engine ?? 'kokoro'));
  const pictures = edited.scenes.map((one): 'keep' | 'draw' => {
    if (one.picture) return 'draw';
    // A picture drawn in one look is drawn again in another; a photograph or a founder's own file never is.
    const drawn = record.scenes[one.was].shots.flatMap((shot) => [shot.image, shot.bg]).filter(Boolean)
      .some((file) => record.pictures[file!]?.kind === 'drawn');
    return drawn && bible !== record.bible ? 'draw' : 'keep';
  });
  const lines = edited.scenes.map((one): 'keep' | 'say' | 'none' => {
    if (!record.narrator || !one.scene.say?.trim()) return 'none';
    if (reread || one.line || !record.scenes[one.was].line) return 'say';
    return 'keep';
  });
  const count = (scene: EditedScene) => new Set(record.scenes[scene.was].shots.flatMap((shot) => [shot.image, shot.bg]).filter(Boolean)).size || (scene.picture ? 1 : 0);
  let keptPictures = 0;
  let drawPictures = 0;
  edited.scenes.forEach((scene, at) => { if (pictures[at] === 'keep') keptPictures += count(scene); else drawPictures += Math.max(1, count(scene)); });
  return {
    pictures, lines, keptPictures, drawPictures,
    keptLines: lines.filter((one) => one === 'keep').length, sayLines: lines.filter((one) => one === 'say').length,
  };
}

// The line the card shows once it is known what can be kept: "kept 6 of 8 pictures, 7 of 8 lines; drew 2 pictures,
// said 1 line". Nothing drawn and nothing said is said as plainly.
export function reuseLine(reuse: Reuse): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const pictures = reuse.keptPictures + reuse.drawPictures;
  const lines = reuse.keptLines + reuse.sayLines;
  const kept = [pictures ? `${reuse.keptPictures} of ${plural(pictures, 'picture')}` : '', lines ? `${reuse.keptLines} of ${plural(lines, 'line')}` : ''].filter(Boolean);
  const made = [reuse.drawPictures ? `drew ${plural(reuse.drawPictures, 'picture')}` : '', reuse.sayLines ? `said ${plural(reuse.sayLines, 'line')}` : ''].filter(Boolean);
  return `kept ${kept.join(', ') || 'everything'}; ${made.join(', ') || 'nothing new was drawn or said'}`;
}

// --- notes into operations ----------------------------------------------------------------------------------------

// A note is split where a founder would pause: a full stop, a semicolon, a new line, or a comma before the next ask.
// A note that opens on a shot ("shot 3 should say…") is a new note too. Nothing inside quotation marks is ever split:
// a new line is written word for word, commas and full stops included.
const ASKS = 'trim|shorten|cut|drop|remove|delete|lose|move|put|swap|replace|change|redraw|redo|say|make|use|switch|no|turn|captions?|music|retitle|set|give|speed|slow|shot|scene|the\\s+(?:first|last|opening|final)\\s+shot';
export function notesOf(notes: string): string[] {
  const held: string[] = [];
  const masked = notes.replace(/["“][^"“”]*["”]/g, (quote) => `\u0000${held.push(quote) - 1}\u0000`);
  return masked
    .split(new RegExp(`[.;\\n]+(?=\\s|$)|,\\s*(?:and\\s+|then\\s+)?(?=(?:${ASKS})\\b)|\\s+and\\s+(?=(?:${ASKS})\\b)`, 'i'))
    .map((one) => one.replace(/\u0000(\d+)\u0000/g, (_, at: string) => held[Number(at)]))
    .map((one) => one.trim().replace(/^(?:and|then|also|please)\s+/i, '').replace(/[,;!]+$/, '').replace(/(?<!["”])\.+$/, '').trim())
    .filter(Boolean);
}

const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const SHOT = String.raw`(?:shot|scene|clip)`;
// "shot 3", "scene three", "the third shot", "the last shot", "the opening".
const REF = String.raw`(?:${SHOT}\s+(?:number\s+)?(\d+|${Object.keys(NUMBERS).join('|')})|the\s+(${Object.keys(ORDINALS).join('|')}|last|final|opening|closing)\s+${SHOT}|the\s+(opening|ending|end))`;
const refFrom = (match: RegExpMatchArray, at: number, count: number): number | null => {
  const [number, ordinal, end] = [match[at], match[at + 1], match[at + 2]];
  if (number) return /^\d+$/.test(number) ? Number(number) : NUMBERS[number.toLowerCase()] ?? null;
  const word = (ordinal ?? end ?? '').toLowerCase();
  if (!word) return null;
  if (word === 'last' || word === 'final' || word === 'closing' || word === 'ending' || word === 'end') return count;
  if (word === 'opening') return 1;
  return ORDINALS[word] ?? null;
};
const quoted = (note: string): string[] => [...note.matchAll(/["“”]([^"“”]+)["“”]/g)].map((one) => one[1].trim()).filter(Boolean);
const LOOK_WORDS: Record<string, Pack> = { documentary: 'documentary', editorial: 'editorial', clean: 'clean', creator: 'creator', neon: 'neon', sketch: 'sketch', 'hand-drawn': 'sketch', brand: 'brand' };

// The plain cases, read without asking anybody. Each note either comes back as operations or is left for the model.
export function readPlainly(note: string, count: number): EditOp[] | null {
  const said = note.trim();
  const lower = said.toLowerCase();
  const refAt = (pattern: string, flags = 'i') => said.match(new RegExp(pattern, flags));
  let found: RegExpMatchArray | null;

  // Trim: "trim shot 2 to 4 seconds", "shorten the last shot to 3s", "make shot 2 four seconds long", "trim shot 3".
  // "Cut shot 3" on its own is a drop; "cut shot 3 to 2 seconds" is a trim.
  if ((found = refAt(String.raw`^(trim|shorten|cut(?:\s+down)?|tighten)\s+${REF}(?:\s+(?:down\s+)?to\s+(\d+(?:\.\d+)?|${Object.keys(NUMBERS).join('|')})\s*(?:s|secs?|seconds?)\b)?\s*$`))
    && (found[5] || !/^cut$/i.test(found[1]))) {
    const scene = refFrom(found, 2, count);
    const seconds = found[5] ? (/^\d/.test(found[5]) ? Number(found[5]) : NUMBERS[found[5].toLowerCase()]) : undefined;
    return scene ? [{ op: 'trim', scene, ...(seconds ? { seconds } : {}) }] : null;
  }
  if ((found = refAt(String.raw`^make\s+${REF}\s+(\d+(?:\.\d+)?|${Object.keys(NUMBERS).join('|')})\s*(?:s|secs?|seconds?)(?:\s+long)?$`))) {
    const scene = refFrom(found, 1, count);
    const seconds = /^\d/.test(found[4]) ? Number(found[4]) : NUMBERS[found[4].toLowerCase()];
    return scene ? [{ op: 'trim', scene, seconds }] : null;
  }
  // Drop: "drop shot 3", "cut the last shot", "lose scene two".
  if ((found = refAt(String.raw`^(?:drop|cut|remove|delete|lose|take\s+out|get\s+rid\s+of)\s+${REF}$`))) {
    const scene = refFrom(found, 1, count);
    return scene ? [{ op: 'drop', scene }] : null;
  }
  if ((found = refAt(String.raw`^(?:drop|cut|remove|delete|lose)\s+the\s+${SHOT}\s+(?:that\s+says|with|saying)\s+["“]([^"”]+)["”]$`))) return [{ op: 'drop', scene: found[1] }];
  // Move: "move shot 4 before shot 2", "move shot 1 after shot 3", "move shot 2 to the end".
  if ((found = refAt(String.raw`^(?:move|put)\s+${REF}\s+(before|after|to)\s+(?:${REF}|the\s+(start|beginning|end))$`))) {
    const scene = refFrom(found, 1, count);
    const place = found[4].toLowerCase();
    const edge = (found[8] ?? (place === 'to' ? found[7] : undefined))?.toLowerCase();
    if (!scene) return null;
    if (edge) return [{ op: 'move', scene, before: edge === 'end' || edge === 'ending' ? 'end' : 1 }];
    const other = refFrom(found, 5, count);
    if (!other || place === 'to') return null;
    return [{ op: 'move', scene, before: place === 'before' ? other : other + 1 > count ? 'end' : other + 1 }];
  }
  // A new picture: "swap the picture in shot 5", "swap the picture in shot 5 for the office", "new image on the last shot".
  if ((found = refAt(String.raw`^(?:swap|replace|change|redraw|redo|use\s+a\s+new|new)\s+(?:the\s+)?(?:picture|image|photo|photograph|background|still)\s+(?:in|on|of|for|behind)\s+${REF}(?:\s+(?:for|with|to|into)\s+(.+))?$`))) {
    const scene = refFrom(found, 1, count);
    const rest = found[4]?.trim().replace(/^["“]|["”]$/g, '');
    if (!scene) return null;
    if (!rest) return [{ op: 'swap_picture', scene }];
    return [/^media\/|\.(png|jpe?g|webp)$/i.test(rest) ? { op: 'swap_picture', scene, asset: rest } : { op: 'swap_picture', scene, prompt: rest }];
  }
  // A new line: shot 3 should say "…", "change the line in shot 3 to "…"", "redo the line in the last shot: "…"".
  const words = quoted(said);
  if (words.length === 1 && (found = refAt(String.raw`^(?:(?:redo|change|rewrite|replace)\s+the\s+(?:line|narration|voiceover|words\s+said)\s+(?:in|on|of|for)\s+${REF}|${REF}\s+(?:should\s+)?say(?:s)?|(?:make|have)\s+${REF}\s+say)\b`))) {
    const scene = refFrom(found, 1, count) ?? refFrom(found, 4, count) ?? refFrom(found, 7, count);
    return scene ? [{ op: 'redo_line', scene, say: words[0] }] : null;
  }
  // New words on screen: retitle shot 1 "…", "change the heading in shot 1 to "…"", "shot 4 should read "…"".
  if (words.length === 1 && (found = refAt(String.raw`^(?:retitle\s+${REF}|(?:change|set)\s+the\s+(heading|title|headline|text|words\s+on\s+screen)\s+(?:in|on|of|for)\s+${REF}|${REF}\s+should\s+read)\b`))) {
    const scene = refFrom(found, 1, count) ?? refFrom(found, 5, count) ?? refFrom(found, 8, count);
    const which = (found[4] ?? '').toLowerCase();
    return scene ? [/^(text|words)/.test(which) ? { op: 'retitle', scene, text: words[0] } : { op: 'retitle', scene, heading: words[0] }] : null;
  }
  // Nothing below names a shot, and a note that does is one the model reads.
  if (new RegExp(`\\b${SHOT}\\b|\\bline\\b`, 'i').test(lower)) return null;
  // The pace: "make it faster", "cut it slower", "punchier".
  if (/^(?:(?:make|cut|edit)\s+(?:it|the\s+(?:film|video|whole\s+thing|edit))\s+)?(?:a\s+(?:bit|little)\s+|much\s+)?(?:faster|quicker|snappier|punchier|tighter)(?:\s+(?:cuts|pace|pacing))?$|^(?:faster|punchy)\s+(?:cuts|pace|pacing)$|^speed\s+(?:it\s+)?up$/.test(lower)) return [{ op: 'pace', pace: 'punchy' }];
  if (/^(?:(?:make|cut|edit)\s+(?:it|the\s+(?:film|video|whole\s+thing|edit))\s+)?(?:a\s+(?:bit|little)\s+|much\s+)?(?:slower|calmer|gentler)(?:\s+(?:cuts|pace|pacing))?$|^(?:slower|calm)\s+(?:cuts|pace|pacing)$|^slow\s+(?:it\s+)?down$/.test(lower)) return [{ op: 'pace', pace: 'calm' }];
  // The look: "use the documentary look", "make it editorial", "switch to the neon style".
  if ((found = lower.match(/^(?:use|try|switch\s+to|go|make\s+it|put\s+it\s+in|in)\s+(?:the\s+|an?\s+)?(documentary|editorial|clean|creator|neon|sketch|hand-drawn|brand)(?:\s+(?:look|style|pack))?$/))) return [{ op: 'look', look: LOOK_WORDS[found[1]] }];
  // The music: "no music", "drop the music", "calm music", "make the music upbeat".
  if (/^(?:no|without|drop\s+the|remove\s+the|lose\s+the|kill\s+the|cut\s+the|turn\s+off\s+the)\s+music$|^music\s+off$/.test(lower)) return [{ op: 'music', mood: 'none' }];
  if ((found = lower.match(/^(?:(?:use|make\s+it|give\s+it|put)\s+)?(?:a\s+|the\s+)?(?:music\s+)?(upbeat|calm|cinematic|tech|warm|playful|dramatic)\s+(?:music|bed|track)?(?:\s+under\s+it)?$|^make\s+the\s+music\s+(upbeat|calm|cinematic|tech|warm|playful|dramatic)$/))) return [{ op: 'music', mood: (found[1] ?? found[2]) as Mood }];
  // The captions: "captions off", "no captions", "turn the captions on", "add captions".
  if (/^(?:captions?\s+off|no\s+captions?|(?:turn|switch)\s+(?:the\s+)?captions?\s+off|(?:turn|switch)\s+off\s+(?:the\s+)?captions?|(?:drop|remove|lose)\s+the\s+captions?|without\s+captions?)$/.test(lower)) return [{ op: 'captions', on: false }];
  if (/^(?:captions?\s+on|add\s+captions?|(?:turn|switch)\s+(?:the\s+)?captions?\s+on|(?:turn|switch)\s+on\s+(?:the\s+)?captions?|with\s+captions?)$/.test(lower)) return [{ op: 'captions', on: true }];
  // The voice: "use the voice Emma", "read it in bella", "use omnivoice".
  if ((found = lower.match(/^(?:use|switch\s+to|read\s+it\s+(?:in|with|as)|narrate\s+(?:it\s+)?(?:with|as|in))\s+(?:the\s+)?(?:voice\s+)?([a-z_]+)(?:'s)?(?:\s+voice)?$/))) {
    const voice = voiceNamed(found[1]);
    if (voice) return [{ op: 'voice', voice }];
    if (found[1] === OMNI_ENGINE || found[1] === 'kokoro') return [{ op: 'voice', engine: found[1] }];
  }
  return null;
}

// What a film looks like to somebody reading notes about it: its shots, numbered as the card numbers them.
export function filmOutline(record: FilmRecord): string {
  return record.spec.scenes.map((scene, at) => {
    const shown = [scene.heading, scene.text].filter(Boolean).join(' / ');
    const seconds = record.scenes[at]?.shots.reduce((sum, one) => sum + one.seconds, 0) ?? 0;
    return `${at + 1}. ${scene.layout}${seconds ? `, ${seconds.toFixed(1)}s` : ''}${shown ? ` — on screen: "${shown}"` : ''}${scene.say ? ` — says: "${scene.say}"` : ''}`;
  }).join('\n');
}

export function editsPrompt(notes: string[], record: FilmRecord): string {
  return [
    'You turn a founder\'s notes on a finished film into edit operations. Answer with ONLY a JSON array, nothing else.',
    '',
    `The film "${record.title}" (${record.look} look, ${record.pace} pace, captions ${record.captions ? 'on' : 'off'}, music ${record.music}):`,
    filmOutline(record),
    '',
    'The operations, and nothing else:',
    '{"op":"trim","scene":N,"seconds":S} — hold shot N for S seconds (leave out seconds for "as short as its line")',
    '{"op":"drop","scene":N}',
    '{"op":"move","scene":N,"before":M} — or "before":"end"',
    '{"op":"swap_picture","scene":N,"prompt":"what to show"} — a new picture; prompt is what is seen, never words',
    '{"op":"redo_line","scene":N,"say":"the new spoken line, word for word"}',
    '{"op":"retitle","scene":N,"heading":"…"} or "text":"…" — the words on screen',
    '{"op":"pace","pace":"calm"|"punchy"}',
    `{"op":"look","look":one of ${PACKS.join(', ')}}`,
    `{"op":"music","mood":one of ${MOODS.join(', ')}}`,
    '{"op":"captions","on":true|false}',
    `{"op":"voice","voice":one of ${VOICES.slice(0, 6).map((one) => one.id).join(', ')}…}`,
    '',
    'Scenes are numbered as above, from 1. A note you cannot turn into these operations comes back as {"op":"unread","note":"the note"}.',
    'Never guess. Never invent a line the founder did not write: a note that asks for a line to be said differently without giving the words is unread.',
    '',
    'The notes:',
    ...notes.map((one) => `- ${one}`),
  ].join('\n');
}

export type Think = (prompt: string) => Promise<string>;
export type ReadNotes = { ops: EditOp[]; unread: string[]; asked: boolean };

// The notes, read: the plain ones here, the rest in ONE small call, and anything still unread said back as it was
// written. Nothing is guessed — a note the model returns nothing usable for is a note that was not read.
export async function notesToEdits(notes: string, record: FilmRecord, think?: Think): Promise<ReadNotes> {
  const count = record.spec.scenes.length;
  const ops: EditOp[] = [];
  const left: string[] = [];
  for (const note of notesOf(notes)) {
    const plain = readPlainly(note, count);
    if (plain) ops.push(...plain); else left.push(note);
  }
  if (!left.length || !think) return { ops, unread: left, asked: false };
  const unread: string[] = [];
  try {
    const said = await think(editsPrompt(left, record));
    const body = said.slice(said.indexOf('['), said.lastIndexOf(']') + 1);
    const list = body ? JSON.parse(body) as unknown : null;
    if (!Array.isArray(list)) return { ops, unread: left, asked: true };
    let read = 0;
    for (const raw of list) {
      if (raw && typeof raw === 'object' && (raw as { op?: unknown }).op === 'unread') {
        const note = String((raw as { note?: unknown }).note ?? '').trim();
        if (note) unread.push(note);
        continue;
      }
      try { ops.push(parseOp(raw)); read += 1; } catch (error) { unread.push(`${JSON.stringify(raw).slice(0, 80)} (${(error as Error).message})`); }
    }
    // The model answered and turned nothing into an edit: every note it was handed is unread.
    if (!read && !unread.length) unread.push(...left);
  } catch {
    return { ops, unread: left, asked: true };
  }
  return { ops, unread, asked: true };
}

// The next name in a film's line: "launch.mp4" becomes "launch-v2", "launch-v2" becomes "launch-v3".
export function versionName(film: string): { stem: string; version: number } {
  const base = film.replace(/\.[^./]+$/, '');
  const found = /^(.*)-v(\d+)$/.exec(base);
  return found ? { stem: `${found[1]}-v${Number(found[2]) + 1}`, version: Number(found[2]) + 1 } : { stem: `${base}-v2`, version: 2 };
}

// How the credits say what a film is: where it came from and what the notes did to it.
export const creditsLine = (from: string, ops: EditOp[]): string => `edited from ${from.split('/').pop()}: ${opsWords(ops)}`;

// A number of shots and a length, for the card's decisions list.
export const lengthOf = (record: Pick<FilmRecord, 'scenes'>): number =>
  Math.round(record.scenes.reduce((sum, scene) => sum + scene.shots.reduce((all, shot) => all + shot.seconds, 0), 0) * 10) / 10;
