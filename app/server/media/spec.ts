import type { Shape } from '../../shared/model.ts';
import { MOODS, type Mood } from './audio.ts';
import { isPack, PACES, type Pack, type Pace } from './templates/looks.ts';

// Seventeen shapes a scene can take, in the order a film tends to use them.
export const LAYOUTS = ['title', 'hook', 'statement', 'bullets', 'checklist', 'steps', 'compare', 'picture', 'device',
  'stat', 'quote', 'logo', 'cta', 'footage', 'clip', 'presenter', 'outro'] as const;
export type Layout = (typeof LAYOUTS)[number];
// One scene of a video, as the director or a person fills it in. `say` is the line spoken over it; `image_prompt` is
// the still drawn for it and `bg_prompt` the picture drawn *behind* it; `asset` names something already on the card.
// Which fields a layout needs is what `parseSpec` checks, and everything here is a plain string, number or list of
// strings — no provider argues with those.
export type Scene = {
  layout: Layout; heading?: string; text?: string; bullets?: string[]; labels?: string[];
  image_prompt?: string; bg_prompt?: string; asset?: string; frame?: string; clip_prompt?: string; portrait_prompt?: string;
  emphasis?: string; icon?: string;
  // The few words out of the wired material that this scene's claim rests on. The critic checks it is really there.
  source?: string;
  seconds?: number; start?: number; mute?: boolean; say?: string;
};
// The whole film as one flat object. `music` is the mood the bed wants, `sfx` and `captions` are on or off, `pace` is
// how fast it cuts and `pack` is the look it wears. Everything the founder chose on the card is folded in first.
export type Spec = { title: string; scenes: Scene[]; music?: Mood; sfx?: boolean; captions?: boolean; pace?: Pace; pack?: Pack };

export const MAX_SCENES = 24;
// Every drawn still costs a call to a free picture service with a day's quota, and every AI clip costs far more.
// A picture in front of the words and a picture behind them cost the same, so the two caps are near enough the same.
export const MAX_IMAGES = 10;
// How many pictures are drawn to stand behind the words of a whole film. Not one a scene: a free daily quota is a
// few hundred pictures and a founder making three films a day would spend it by lunchtime, and — the better
// reason — six frames of one film should look like six frames of one film. So a handful are drawn from the style
// bible and shared out, each scene taking its own crop, tint and drift of the same picture.
export const MAX_BACKGROUNDS = 4;
// A run of scenes this long shares one background before another is drawn.
export const SCENES_A_BACKGROUND = 3;
// A clip from the free Spaces spends somebody else's daily minutes, so a film makes at most two. A clip made on this
// machine spends nothing but time, so a film may have twice as many — the founder is told what that time costs.
export const MAX_AI = 2;
export const MAX_LOCAL_AI = 4;
export const LENGTHS = [15, 30, 60, 90] as const;
export const CAPS = { title: 80, heading: 90, text: 260, bullet: 100, bullets: 6, labels: 2, say: 420, image_prompt: 300, clip_prompt: 240, asset: 80, icon: 8, emphasis: 40 };

// How many words fit on the screen before a viewer is reading rather than watching. These are the numbers the critic
// holds the director to: a heading is a headline and a line of support is a line, never the narration written out.
export const HEADING_WORDS = 7;
export const TEXT_WORDS = 12;

// The words that carry nothing on their own. Every rule that reads a line — what a headline may end on, which word
// is the one the line turns on, whether two lines are the same line — counts the rest and ignores these.
export const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'so', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would',
  'can', 'could', 'should', 'may', 'might', 'must', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'as',
  'it', 'its', 'you', 'your', 'we', 'our', 'they', 'their', 'i', 'my', 'me', 'he', 'she', 'his', 'her', 'them', 'us',
  'what', 'when', 'where', 'who', 'how', 'why', 'which', 'there', 'here', 'about', 'into', 'over', 'just', 'like',
  'not', 'no', 'yes', 'up', 'out', 'down', 'off', 'all', 'any', 'some', 'more', 'most', 'very', 'really', 'actually']);

const bare = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
export const content = (text: string) => bare(text).filter((word) => !STOP.has(word) && word.length > 2);

// How much of one line is already in another, counted in the words that carry meaning. Two lines that share most of
// their nouns are one line said twice, whatever the grammar around them.
export function echoes(text: string, said: string): number {
  const mine = content(text);
  if (!mine.length) return 0;
  const theirs = new Set(content(said));
  return mine.filter((word) => theirs.has(word)).length / mine.length;
}

// Whether what is written on a scene is already the whole of the line being said over it. A hook is the spoken line
// set large, and a word-by-word caption under it is the same sentence twice on one frame — which is what the founder
// was handed. The test is how much of the *spoken* line is already on the screen: five words of a twelve-word line
// is emphasis and keeps its captions; five words of a five-word line is the caption, set large.
export function saysWhatItShows(scene: Scene): boolean {
  const said = scene.say?.trim();
  if (!said) return false;
  const shown = [scene.heading, scene.text, ...(scene.bullets ?? [])].filter(Boolean).join(' ');
  if (!shown.trim()) return false;
  return echoes(said, shown) >= 0.6;
}

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
// A scene that already fills the frame with something. Everything else gets a background drawn behind it.
export const VISUAL_LAYOUTS = new Set<Layout>(['picture', 'device', 'footage', 'clip', 'presenter', 'logo']);
// The frames a screenshot can be shown in.
export const FRAMES = ['phone', 'laptop', 'browser'] as const;

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
      if (scene[key] !== undefined && scene[key] !== null && scene[key] !== '') (made as Record<string, unknown>)[key] = words(scene[key], `${where}: "${what}"`, limit);
    };
    some('heading', 'heading', CAPS.heading);
    some('text', 'text', CAPS.text);
    some('say', 'say', CAPS.say);
    some('image_prompt', 'image_prompt', CAPS.image_prompt);
    some('bg_prompt', 'bg_prompt', CAPS.image_prompt);
    some('clip_prompt', 'clip_prompt', CAPS.clip_prompt);
    some('portrait_prompt', 'portrait_prompt', CAPS.image_prompt);
    some('asset', 'asset', CAPS.asset);
    some('emphasis', 'emphasis', CAPS.emphasis);
    some('source', 'source', CAPS.text);
    some('icon', 'icon', CAPS.icon);
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
    // A picture scene is a picture: its caption is welcome but not required, because a captioned film already has
    // words at the foot of the frame and a second line of them there is one line too many.
    if (layout === 'picture' && !made.image_prompt) throw new Error(`${where}: a picture scene needs "image_prompt" — the whole scene to draw`);
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
  if (isPack(asked.pack)) spec.pack = asked.pack;
  if (asked.sfx !== undefined && asked.sfx !== null) spec.sfx = asked.sfx !== false;
  if (asked.captions !== undefined && asked.captions !== null) spec.captions = asked.captions !== false;
  return spec;
}

// What the film is for. A purpose is not a style: it is the shape of the thing — how it opens, how long it holds, what
// it has to end with. The director reads one out of the brief, and the founder may overrule it on the card.
export const PURPOSES = ['explainer', 'launch', 'feature', 'ad', 'reel', 'pitch', 'testimonial'] as const;
export type Purpose = (typeof PURPOSES)[number];
export type Preset = { name: string; pace: Pace; format: Shape; length: number; music: Mood; captions: boolean; pack: Pack; person: boolean; shape: string };
export const PURPOSE: Record<Purpose, Preset> = {
  explainer: {
    name: 'product explainer', pace: 'calm', format: 'wide', length: 60, music: 'calm', captions: false, pack: 'clean', person: false,
    shape: 'Open on a title. Name the problem in one statement, show the product doing the thing (device scenes), then how it works in steps, then one proof — a stat or a quote — and close on a logo.',
  },
  launch: {
    name: 'launch announcement', pace: 'punchy', format: 'wide', length: 30, music: 'upbeat', captions: true, pack: 'neon', person: false,
    shape: 'Open on a hook: the thing is here. Say what it is in one statement, show it on screen, list what is new as a checklist, and end on a cta with where to get it.',
  },
  feature: {
    name: 'single feature', pace: 'calm', format: 'wide', length: 30, music: 'warm', captions: true, pack: 'clean', person: false,
    shape: 'Open on the moment the feature saves: a compare scene, before and after. Then the feature on screen, then the two or three things it does, then a cta.',
  },
  ad: {
    name: 'marketing ad', pace: 'punchy', format: 'square', length: 30, music: 'upbeat', captions: true, pack: 'creator', person: false,
    shape: 'Open on a hook that is a problem the viewer has. One statement of the turn. One device or footage scene of the product. One stat as proof. A cta. Nothing else — every scene must earn its seconds.',
  },
  reel: {
    name: 'influencer-style reel', pace: 'punchy', format: 'tall', length: 30, music: 'upbeat', captions: true, pack: 'creator', person: true,
    shape: 'Open on a hook in the first second — a claim, a number or a question, no title card. Then short scenes that cut fast: what it is, what it replaces, what it costs you not to have it. Talk like a person, not a brochure. End on a cta.',
  },
  pitch: {
    name: 'investor pitch', pace: 'calm', format: 'wide', length: 90, music: 'calm', captions: false, pack: 'editorial', person: false,
    shape: 'Open on a title. The problem, sized with a stat. What you built, on screen. Who it is for. Traction as stats. What is next as steps. Close on a logo.',
  },
  testimonial: {
    name: 'customer testimonial', pace: 'calm', format: 'tall', length: 30, music: 'warm', captions: true, pack: 'editorial', person: true,
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

// What really decides how long a film runs is not how many scenes it has but how much is said over them: a scene is
// never shorter than the line spoken on it, and every scene costs a breath before the line and a beat after it. The
// old studio budgeted the words and forgot the breaths, which is exactly how fifteen seconds came out at eighteen.
export const WORDS_A_SECOND = 2.4;
export const wordsFor = (seconds: number): number => Math.round(seconds * WORDS_A_SECOND);
export function budgetOf(seconds: number, scenes: number, pace: Pace): number {
  const beat = pace === 'punchy' ? 0.40 : 1.0;
  return Math.max(8, Math.round((seconds - scenes * beat) * WORDS_A_SECOND));
}

export const countWords = (text?: string): number => (text ?? '').trim().split(/\s+/).filter(Boolean).length;
export const saidWords = (spec: Spec): number => spec.scenes.reduce((sum, scene) => sum + countWords(scene.say), 0);

// A storyboard costs nothing to write and everything to render, so what came back is brought inside the caps rather
// than thrown away: too many drawn stills become statements, a third AI scene becomes what it would have fallen back
// to, and a scene naming an asset that is not there loses the name.
export function withinCaps(spec: Spec, allow: { ai: boolean; assets: string[]; most?: number }): { spec: Spec; notes: string[] } {
  const notes: string[] = [];
  const most = allow.most ?? MAX_AI;
  let drawn = 0;
  let spent = 0;
  const scenes = spec.scenes.map((scene, index): Scene => {
    if (scene.layout === 'picture') {
      drawn += 1;
      if (drawn > MAX_IMAGES) {
        notes.push(`scene ${index + 1} is set on a background rather than a picture of its own: a film draws at most ${MAX_IMAGES} in front of the words`);
        return { ...scene, layout: 'statement', text: scene.text || scene.heading || '', heading: undefined, image_prompt: undefined, bg_prompt: scene.bg_prompt ?? scene.image_prompt };
      }
    }
    if (AI_LAYOUTS.has(scene.layout)) {
      spent += 1;
      if (!allow.ai || spent > most) {
        notes.push(`scene ${index + 1} is its words rather than a moving shot: ${allow.ai ? `a film makes at most ${most} of those` : 'AI clips are switched off'}`);
        return fallbackOf(scene);
      }
    }
    if ((scene.layout === 'footage' || scene.layout === 'device') && scene.asset && !allow.assets.includes(scene.asset)) {
      notes.push(`scene ${index + 1} asked for "${scene.asset}", and there is nothing on the card by that name`);
      return fallbackOf({ ...scene, asset: undefined });
    }
    return scene;
  });
  return { spec: { ...spec, scenes }, notes };
}

// A last guard on the length. The word budget in the brief does most of the work, but a model that ignores it would
// otherwise hand the founder ninety seconds where they asked for thirty. Scenes go from the middle, never the opening
// and never the last two, and only while the film is still over what was asked for.
export function withinLength<T extends { seconds: number }>(shots: T[], target: number, slack = 1.1): { shots: T[]; dropped: number } {
  if (!target || shots.length <= 4) return { shots, dropped: 0 };
  const kept = [...shots];
  let total = kept.reduce((sum, one) => sum + one.seconds, 0);
  let dropped = 0;
  while (total > target * slack && kept.length > 4) {
    // The longest scene in the middle is the one the film can best do without.
    const middle = kept.slice(1, -2);
    const worst = middle.reduce((most, one) => (one.seconds > most.seconds ? one : most), middle[0]);
    kept.splice(kept.indexOf(worst), 1);
    total -= worst.seconds;
    dropped += 1;
  }
  return { shots: kept, dropped };
}

// What a scene becomes when the thing it needed could not be made or found. A clip keeps its words as a picture if it
// had any, and a presenter keeps saying what it was going to say — the film is never a scene shorter for it. Why it
// could not be made is told to the founder on the card; it is never set across the frame. A film that renders
// "nothing to show" or "Cloudflare answered 429" as its headline is worse than one that renders nothing at all.
export function fallbackOf(scene: Scene): Scene {
  if (scene.layout === 'clip') return { layout: 'picture', image_prompt: scene.clip_prompt ?? scene.text ?? 'an abstract product still, soft light', text: scene.text, say: scene.say, heading: scene.heading, emphasis: scene.emphasis };
  if (scene.layout === 'presenter') return { layout: 'statement', text: scene.text || scene.say || '', say: scene.say, heading: scene.heading, bg_prompt: scene.portrait_prompt, emphasis: scene.emphasis };
  if (scene.layout === 'device') return { layout: 'statement', text: scene.text || scene.heading || '', say: scene.say, bg_prompt: scene.bg_prompt, emphasis: scene.emphasis };
  if (scene.layout === 'footage') return { layout: 'statement', text: scene.text || scene.heading || '', say: scene.say, bg_prompt: scene.bg_prompt, emphasis: scene.emphasis };
  return { ...scene, layout: 'statement', text: scene.text || scene.heading || undefined, heading: undefined, image_prompt: undefined, bg_prompt: scene.bg_prompt ?? scene.image_prompt };
}
