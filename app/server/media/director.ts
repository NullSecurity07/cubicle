import type { Shape } from '../../shared/model.ts';
import { MOODS, type Mood } from './audio.ts';
import { contrasty, criticise, drawnWord, figureIn, headlineOf, keywords, listy, photographic, mendShots, repair, trimTo, type Want } from './critic.ts';
import {
  AI_LAYOUTS, budgetOf, CAPS, HEADING_WORDS, isPurpose, LAYOUTS, MAX_SCENES, parseSpec, PURPOSE, PURPOSES,
  saidWords, scenesFor, TEXT_WORDS, type Layout, type Purpose, type Scene, type Spec,
} from './spec.ts';
import { isPack, PACES, PACKS, type Brand, type Pace, type Pack } from './templates/looks.ts';
import { FILLER, sourcesOf } from './grounding.ts';
import type { Wanted } from './voice.ts';
import { criticiseVisuals, repairVisuals, visualsOf, visualsPrompt, type Visual } from './visuals.ts';
import { LENSES, motionMoves, SIZES, stillMoves } from './moves.ts';

// The director. Not a form to fill in — a person who reads the brief, works out what is being asked for, decides on
// an angle and a look, writes the beats, and only then writes the storyboard. Every one of those is a separate pass,
// because a weak free model asked to do all four at once does the first badly and the rest not at all.
//
// The founder's pickers are all "Auto" until they are not: what the founder sets, the director obeys; everything
// else it decides from the brief itself and says out loud on the card as it goes.

export type Choice<T> = T | 'auto' | undefined;

// What the founder set on the card, plus the brief. 'auto' and undefined mean the same thing: you decide.
export type Asked = {
  brief: string;
  purpose?: Choice<Purpose>; seconds?: number | 'auto'; shape?: Choice<Shape>;
  pace?: Choice<Pace>; pack?: Choice<Pack>; music?: Choice<Mood>;
  captions?: boolean; person?: boolean;
};

// What the film has to work with, gathered before a word of the storyboard is written.
// `pitch` is what the product says it is, in its own words — the thing the film argues. `lines` is everything else
// it says, which is what the film is checked against.
export type Material = { lines: string[]; pitch?: string; assets: { name: string; kind: string; what: string; prompt?: string }[]; brand?: Brand; using: string[] };

// What the director understood, which is the thing the card shows the founder before anything is made.
export type Understanding = {
  purpose: Purpose; audience: string; platform: string; shape: Shape; seconds: number;
  pace: Pace; tone: string; mood: Mood; pack: Pack; person: boolean; captions: boolean;
  // One line, in the founder's own kind of words: "reading the brief: a 15-second vertical reel, punchy, upbeat…"
  said: string;
};

// The creative plan: what this film is going to argue, how it opens, and what every picture in it has in common.
// `source` is the short quotation out of the material that this beat's claim rests on — the one thing that makes
// the difference between a film about a product and a film about a product somebody imagined.
export type Beat = { beat: string; on_screen: string; say: string; source?: string; seconds?: number };
export type Plan = { angle: string; hook: string; bible: string; beats: Beat[] };

const one = <T>(value: unknown, allowed: readonly T[]): T | undefined => (allowed as readonly unknown[]).includes(value) ? value as T : undefined;
const set = <T>(value: Choice<T>): T | undefined => (value === 'auto' || value === undefined || value === null || value === '' as unknown as T ? undefined : value);

// --- reading the brief without asking anybody -----------------------------------------------------------------

// The words a founder actually writes, and what each of them really asks for. This runs before the model and again
// as its net: a model that answers nonsense never moves the film away from what the brief plainly said.
const CUES: { was: RegExp; is: Partial<Understanding> }[] = [
  { was: /\b(reel|tiktok|short-?form|shorts|influencer|creator|vertical|for (?:my )?(?:ig|insta|instagram))\b/i, is: { purpose: 'reel', shape: 'tall', pace: 'punchy', pack: 'creator', captions: true, mood: 'upbeat' } },
  { was: /\b(ad|advert|commercial|promo)\b/i, is: { purpose: 'ad', pace: 'punchy', captions: true, mood: 'upbeat' } },
  { was: /\b(launch|launching|announc\w+|introducing|we (?:just )?shipped|out now|release)\b/i, is: { purpose: 'launch', pace: 'punchy', captions: true, mood: 'upbeat' } },
  { was: /\b(pitch|investors?|raising|seed round|fundrais\w+|vc)\b/i, is: { purpose: 'pitch', shape: 'wide', pace: 'calm', pack: 'editorial', mood: 'calm' } },
  { was: /\b(testimonial|customer story|case study|what .{0,20}customers? say)\b/i, is: { purpose: 'testimonial', pace: 'calm', mood: 'warm' } },
  { was: /\b(explain\w*|how it works|walkthrough|tutorial|demo|onboarding)\b/i, is: { purpose: 'explainer', shape: 'wide', pace: 'calm', pack: 'clean', mood: 'calm' } },
  { was: /\b(feature|one thing|new in)\b/i, is: { purpose: 'feature' } },
  { was: /\b(documentary|cinematic|film-?like|luxury|luxurious|long-?form|essay|letterbox\w*)\b/i, is: { pace: 'calm', pack: 'documentary', mood: 'calm', tone: 'measured' } },
  { was: /\b(calm|quiet|slow|editorial|elegant|minimal|considered|understated|thoughtful)\b/i, is: { pace: 'calm', pack: 'editorial', mood: 'calm', tone: 'considered' } },
  { was: /\b(punchy|fast|snappy|energetic|hype|bold|loud|upbeat)\b/i, is: { pace: 'punchy', mood: 'upbeat', tone: 'energetic' } },
  { was: /\b(tech|technical|developer|engineer|api|ai|futurist\w*|cyber)\b/i, is: { pack: 'neon', tone: 'technical' } },
  { was: /\b(hand-?drawn|sketch|doodle|notebook|whiteboard)\b/i, is: { pack: 'sketch' } },
  { was: /\b(on (?:the )?brand|our colours?|our colors?|brand look|in our brand)\b/i, is: { pack: 'brand' } },
  { was: /\b(talking|to camera|presenter|host|face|person talking|someone talking|speaker|influencer|vlog)\b/i, is: { person: true } },
  { was: /\b(square|feed post|1:1)\b/i, is: { shape: 'square' } },
  { was: /\b(wide|landscape|youtube|16:9|on a screen|website)\b/i, is: { shape: 'wide' } },
  { was: /\b(portrait|9:16|phone|vertical)\b/i, is: { shape: 'tall' } },
  { was: /\b(no music|silent|without music)\b/i, is: { mood: 'none' } },
];

// "15 second", "15s", "a minute", "half a minute", "thirty seconds".
export function secondsIn(brief: string): number | undefined {
  const named: [RegExp, number][] = [[/\bhalf a minute\b/i, 30], [/\ba minute and a half\b/i, 90], [/\bninety seconds\b/i, 90], [/\b(?:one |a )?minute\b/i, 60], [/\btwo minutes\b/i, 120]];
  for (const [was, is] of named) if (was.test(brief)) return is;
  const digits = /(\d{1,3})\s*[-\s]?\s*(?:seconds?|secs?|s)\b/i.exec(brief);
  if (digits) { const found = Number(digits[1]); if (found >= 8 && found <= 180) return found; }
  const spelled: Record<string, number> = { ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, forty5: 45, sixty: 60 };
  const word = /\b(ten|fifteen|twenty|thirty|forty|sixty)\b[- ]?(?:five)?\s*seconds?\b/i.exec(brief);
  if (word) return spelled[word[1].toLowerCase()] ?? undefined;
  return undefined;
}

// Everything the words of the brief say on their own, before a model is asked anything.
export function readBrief(brief: string): Partial<Understanding> {
  const read: Partial<Understanding> = {};
  for (const cue of CUES) if (cue.was.test(brief)) Object.assign(read, { ...cue.is, ...read });
  const seconds = secondsIn(brief);
  if (seconds) read.seconds = seconds;
  return read;
}

// --- pass one: understand --------------------------------------------------------------------------------------

export function understandPrompt(asked: Asked, material: Material): string {
  const fixed = [
    set(asked.purpose) && `what it is for: ${set(asked.purpose)}`,
    typeof asked.seconds === 'number' && `how long: ${asked.seconds} seconds`,
    set(asked.shape) && `shape: ${set(asked.shape)}`,
    set(asked.pace) && `pace: ${set(asked.pace)}`,
    set(asked.pack) && `look: ${set(asked.pack)}`,
    set(asked.music) && `music: ${set(asked.music)}`,
  ].filter(Boolean);
  return [
    'You are the director of a short film. Read the brief and say what is actually being asked for. Answer with one JSON object and nothing else.',
    '',
    '{"purpose": one of ' + PURPOSES.join(', ') + ',',
    ' "audience": "who is watching, in a few words",',
    ' "platform": "where it will be watched — tiktok, instagram, youtube, linkedin, a website, a meeting",',
    ' "format": "tall for a phone, wide for a screen, square for a feed",',
    ' "seconds": how long it should run, a whole number,',
    ' "pace": "punchy" if it cuts fast or "calm" if it has room,',
    ' "tone": "how it should sound, two or three words",',
    ` "music": one of ${MOODS.join(', ')},`,
    ` "look": one of ${PACKS.join(', ')} — creator is bold kinetic captions for a phone reel, editorial is a serif and pictures, neon is tech, clean is typographic, sketch is hand-drawn, brand takes the product's own colours,`,
    ' "person_on_camera": true if the brief wants somebody talking to camera,',
    ' "captions": true if the spoken words should be burned on screen,',
    ' "why": "one sentence on how you read the brief"}',
    '',
    fixed.length ? `The founder has already decided these, so answer with exactly them: ${fixed.join('; ')}.` : 'The founder decided none of it — every one of these is yours to read out of the brief.',
    material.using.length ? `The film can draw on: ${material.using.join(', ')}.` : '',
    '',
    'The brief:',
    asked.brief,
  ].filter((line) => line !== '').join('\n');
}

// One answer, read as loosely as it can honestly be read. Whatever is missing or wrong falls back to what the brief
// plainly said, and failing that to what the purpose has always meant.
export function understandingOf(raw: unknown, asked: Asked, read: Partial<Understanding>): Understanding {
  const said = (raw ?? {}) as Record<string, unknown>;
  // The order is the point. What the founder set is law; after that comes what the brief plainly says — "influencer",
  // "15 second", "calm" are not hints, they are instructions — and the model only fills what neither of those found.
  // A free model asked to read "15 second clip of influencer talking" called it a product explainer, which is how a
  // reel ends up looking like a slide deck.
  const purpose = set(asked.purpose) ?? read.purpose ?? (isPurpose(said.purpose) ? said.purpose : undefined) ?? 'explainer';
  const preset = PURPOSE[purpose];
  const seconds = (() => {
    const want = typeof asked.seconds === 'number' ? asked.seconds : read.seconds ?? Number(said.seconds);
    return Number.isFinite(want) && want >= 8 && want <= 180 ? Math.round(want) : preset.length;
  })();
  const person = set(asked.person) ?? read.person ?? (typeof said.person_on_camera === 'boolean' ? said.person_on_camera : undefined) ?? preset.person;
  const understanding: Understanding = {
    purpose,
    audience: typeof said.audience === 'string' && said.audience.trim() ? said.audience.trim().slice(0, 80) : 'whoever the founder is trying to reach',
    platform: typeof said.platform === 'string' && said.platform.trim() ? said.platform.trim().slice(0, 40) : (preset.format === 'tall' ? 'a phone feed' : 'a screen'),
    shape: set(asked.shape) ?? read.shape ?? one(said.format, ['wide', 'tall', 'square'] as const) ?? preset.format,
    seconds,
    pace: set(asked.pace) ?? read.pace ?? one(said.pace, PACES) ?? preset.pace,
    tone: typeof said.tone === 'string' && said.tone.trim() ? said.tone.trim().slice(0, 60) : read.tone ?? (preset.pace === 'punchy' ? 'direct and quick' : 'measured'),
    mood: set(asked.music) ?? read.mood ?? one(said.music, MOODS) ?? preset.music,
    pack: set(asked.pack) ?? read.pack ?? (isPack(said.look) ? said.look : undefined) ?? preset.pack,
    person,
    captions: asked.captions ?? read.captions ?? (typeof said.captions === 'boolean' ? said.captions : undefined) ?? preset.captions,
    said: '',
  };
  understanding.said = tellOf(understanding, typeof said.why === 'string' ? said.why : '');
  return understanding;
}

// The line the card shows: what the director read, in the words a founder would use.
export function tellOf(understanding: Understanding, why = ''): string {
  const shape = understanding.shape === 'tall' ? 'vertical' : understanding.shape === 'square' ? 'square' : 'widescreen';
  const bits = [
    `a ${understanding.seconds}-second ${shape} ${PURPOSE[understanding.purpose].name}`,
    understanding.pace === 'punchy' ? 'cut fast' : 'given room',
    understanding.tone,
    `${PACKS.includes(understanding.pack) ? understanding.pack : 'clean'} look`,
    understanding.captions ? 'captions on' : 'no captions',
    understanding.mood === 'none' ? 'no music' : `${understanding.mood} music`,
  ];
  return `reading the brief: ${bits.join(', ')}${why.trim() ? ` — ${why.trim().replace(/\.$/, '').slice(0, 120)}` : ''}`;
}

// --- pass two: the plan ------------------------------------------------------------------------------------------

export function planPrompt(understanding: Understanding, asked: Asked, material: Material): string {
  const [least, most] = scenesFor(understanding.seconds, understanding.pace);
  const budget = budgetOf(understanding.seconds, Math.round((least + most) / 2), understanding.pace);
  return [
    `You are directing a ${understanding.seconds}-second ${PURPOSE[understanding.purpose].name} for ${understanding.audience}, to be watched on ${understanding.platform}. The tone is ${understanding.tone}.`,
    'Before anything is storyboarded, decide what this film is actually going to do. Answer with one JSON object and nothing else.',
    '',
    '{"angle": "the one idea the whole film turns on, in a sentence — not a summary of the brief, a decision",',
    ' "hook": "the first line, five to nine words, said and shown at the same time. A claim, a number or a question. Never a title.",',
    ' "style_bible": "one line describing how every picture in this film looks: medium, light, colour, mood. It is pasted in front of every image prompt, so it must describe a look and name no subject.",',
    ` "beats": [{"beat": "what this beat does for the viewer", "on_screen": "what is seen — a picture of what, a number, a list, a screen", "say": "the line spoken over it, written the way a person would say it aloud", "source": "a short quotation, word for word, out of the material below that this beat's claim rests on"}]}`,
    '',
    `Write ${least} to ${most} beats. ${PURPOSE[understanding.purpose].shape}`,
    `All the "say" lines together must come to about ${budget} words — that is what makes the film ${understanding.seconds} seconds long, and it is a hard number. Count them.`,
    'Each beat says one thing. No beat says two things. Nothing is repeated in a later beat.',
    // A model handed a repository writes a film about the repository. What a stranger needs is the thing the
    // product is for, said as a whole thought — which is why the pitch goes above the material and not inside it.
    material.pitch ? `What this product is, in its own words. The whole film argues this, and everything else below is only there to keep it honest:\n${material.pitch}` : '',
    'Every "say" line is a complete thought a stranger understands on its own — a sentence with a subject and something happening. Never a fragment, never a label, never a feature name on its own.',
    'Write for somebody who has never seen this product. Do not name a kind of card, a screen, a setting, a folder, a file or a field unless the material itself explains what it is; say what it does for the person watching instead.',
    understanding.person ? 'The brief wants a person talking to camera, so the opening beats are written as somebody speaking, in the first person.' : '',
    material.lines.length
      ? 'Everything specific this film says — every feature, every number, every name — must come out of the material below, and every beat must carry the words it came from in "source", quoted exactly. Say it in your own words; the quotation is what proves it, not what you read out. A beat whose claim you cannot quote is a beat you must not write.'
      : 'There is no material behind this film, so it may say only what is generally true. No brand name, no product name, no customer, and no statistics at all — not a percentage, not a multiple, not a sum of money. A number nobody measured is a lie with a decimal point in it. Leave "source" out.',
    'A number belongs in this film only if it changes something for the person watching — money, time, how many people, how much better. How many kinds of something the product has is an inventory, not a number worth a scene.',
    understanding.pack === 'sketch'
      ? 'This film is drawn by hand from end to end, so the style bible describes one drawing and every picture in the film is that same drawing.'
      : 'Every picture in this film is the same photograph, so the style bible names a real medium and a real light, and it never asks for a cartoon, an illustration, a 3d render or a drawing.',
    material.lines.length
      ? 'The last beat asks the viewer to do one thing they really can do — an address, a command or an action the material names. If the material names none, close on something plain and true instead, with no invented website, download or button.'
      : 'The last beat closes on something plain: no website, no download, no button, because there is nothing behind this film to click.',
    `Never use these words, in any form: ${FILLER.slice(0, 20).join(', ')}. They are what writing sounds like when it has nothing to say.`,
    material.lines.length ? ['', 'Everything it says about itself:', ...material.lines].join('\n') : '',
    '',
    'The brief:',
    asked.brief,
  ].filter((line) => line !== '').join('\n');
}

export function planOf(raw: unknown, understanding: Understanding, asked: Asked): Plan {
  const said = (raw ?? {}) as Record<string, unknown>;
  const beats = (Array.isArray(said.beats) ? said.beats : []).map((one): Beat => {
    const beat = (one ?? {}) as Record<string, unknown>;
    return {
      beat: String(beat.beat ?? '').slice(0, 160),
      on_screen: String(beat.on_screen ?? '').slice(0, 200),
      say: String(beat.say ?? '').slice(0, CAPS.say),
      source: beat.source ? String(beat.source).slice(0, CAPS.text) : undefined,
    };
  }).filter((beat) => beat.say.trim() || beat.on_screen.trim());
  // The look the model wrote, kept only when it really is one. A model asked for a line of visual direction writes
  // "modern and dynamic" as often as it writes a medium and a light, and a picture model handed that draws whatever
  // it feels like — which is how one scene of a real reel came back a cartoon. A notebook film is the other way
  // round: it is drawn by hand on purpose, so its line has to say so.
  const written = typeof said.style_bible === 'string' && said.style_bible.trim().length > 12 ? said.style_bible.trim().slice(0, 180) : '';
  const fits = understanding.pack === 'sketch' ? !!drawnWord(written) : photographic(written);
  const bible = written && fits ? written : bibleFor(understanding);
  const hook = typeof said.hook === 'string' && said.hook.trim() ? trimTo(said.hook.trim(), 9) : trimTo(asked.brief, 8);
  return { angle: String(said.angle ?? '').slice(0, 200) || asked.brief.slice(0, 160), hook, bible, beats: beats.slice(0, MAX_SCENES) };
}

// A style bible the film can fall back on: every pack has a way pictures look in it, and a film with a consistent
// look made out of a fixed line is still a film, where six unrelated stock pictures are not.
export function bibleFor(understanding: Understanding): string {
  const by: Record<Pack, string> = {
    // Not "deep shadows": a picture model told that draws a black frame, and a scrim over a black frame is a
    // black frame. Bright, contrasty and lit is what a reel wants — the drama comes from the cut, not the grade.
    creator: 'bright high-contrast editorial photography, single strong subject, clean directional key light, one saturated accent colour, shallow depth of field, shot on 35mm',
    editorial: 'quiet documentary photography, soft window light, muted warm palette, generous negative space, medium format stills',
    documentary: 'cinematic documentary photography, available light, deep field of view, restrained muted palette, anamorphic stills, nothing staged',
    neon: 'dark technical photography, cyan and magenta rim light, glass and metal surfaces, volumetric haze, long lens',
    clean: 'calm studio photography, cool slate palette, soft directional light, clean geometry, matte surfaces',
    sketch: 'loose ink and watercolour illustration on warm paper, visible pencil under-drawing, limited palette',
    brand: 'clean still-life photography, soft even light, uncluttered surfaces, one accent colour, matte finish',
  };
  // Every pack but the notebook is photographed, and the line has to say what it is photographed on and in what
  // light or it is not a look at all. A pack whose line has drifted off that falls back to the plain studio one
  // rather than handing a picture model a mood word.
  const line = by[understanding.pack];
  if (understanding.pack === 'sketch') return line;
  return line && photographic(line) ? line : by.clean;
}

// --- pass three: the storyboard ----------------------------------------------------------------------------------

export function specPrompt(plan: Plan, understanding: Understanding, material: Material, layouts: Layout[]): string {
  const [least, most] = scenesFor(understanding.seconds, understanding.pace);
  const budget = budgetOf(understanding.seconds, plan.beats.length || Math.round((least + most) / 2), understanding.pace);
  const has = (layout: Layout) => layouts.includes(layout);
  return [
    `Turn this plan into a storyboard for a ${understanding.seconds}-second ${understanding.shape === 'tall' ? 'vertical' : understanding.shape} film. Answer with one JSON object and nothing else.`,
    '',
    '{"title": "the film\'s title, a few words", "scenes": [ ... ]}',
    '',
    `Each scene is {"layout": one of ${layouts.join(', ')}, and the fields that layout needs}.`,
    '- hook: "text" is the opening line, at most 7 words, set as large as the frame will take it.',
    '- statement: "text" is a HEADLINE of at most 7 words — never the sentence being spoken.',
    '- stat: "heading" is one figure ("74%", "3x", "$12k"), "text" says in at most 6 words what it measures.',
    '- checklist / bullets / steps: "heading" of at most 5 words, two to four "bullets" of at most 5 words each.',
    '- compare: "heading", exactly two "bullets" of at most 6 words, and "labels" naming the two sides.',
    '- picture: "image_prompt" describes the whole picture (subject, setting, light). "text" is optional and, if it is there, at most 8 words.',
    '- quote: "text" is the quotation, "heading" is who said it.',
    ...(has('device') ? ['- device: "asset" is the name of one of the screenshots listed below, "heading" at most 6 words, "frame" one of phone, laptop, browser.'] : []),
    ...(has('footage') ? ['- footage: "asset" is one of the founder\'s own files listed below, "start" and "seconds" cut into it, "mute" false keeps its sound.'] : []),
    ...(has('clip') ? ['- clip: "clip_prompt" describes three to five seconds of moving b-roll. Use at most one.'] : []),
    ...(has('presenter') ? ['- presenter: "say" is what the person on screen says, "portrait_prompt" describes them. Use at most one.'] : []),
    '- cta: "text" is what to do, "heading" is where to do it.',
    '- logo: "heading" is the product\'s name. - title: "heading" is the title, "text" one line under it.',
    '',
    'Every scene also takes:',
    '- "say": the line spoken over it, exactly as the plan wrote it.',
    `- "bg_prompt": the picture drawn full-bleed BEHIND the words, for any scene that is not already a picture, a screen or a clip. Write it as "${plan.bible}" followed by what this scene is about. Every scene needs one.`,
    '- "emphasis": the single word in "text" that carries the line, which is set in the accent colour.',
    ...(material.lines.length
      ? ['- "source": the quotation the beat carried, word for word, for any scene that states a feature, a number or a name.']
      : []),
    ...(understanding.pack === 'creator' ? ['- "icon": one emoji that belongs beside this scene, or leave it out.'] : []),
    `- ${has('clip') ? 'picture and clip scenes' : 'picture scenes'} may take "shot" (${SIZES.join(', ')}), "lens" (${LENSES.join(', ')}) and "move" (${stillMoves.map((one) => one.name).join(', ')}${has('clip') ? `; a clip may also use ${motionMoves.map((one) => one.name).join(', ')}` : ''}). Optional; the studio fills what you leave out.`,
    '',
    'The rules this storyboard is checked against, before it is rendered:',
    `- What is on screen is a headline, never the narration. A heading is at most ${HEADING_WORDS} words and a line of text at most ${TEXT_WORDS}.`,
    '- "heading" and "text" are words a viewer reads, never a note about what the shot shows. "Investors want proof" is a headline; "user growth shown" and "purpose highlighted" are directions to a camera operator and must never be set across a frame.',
    understanding.captions ? '- The spoken words are already captioned word by word at the foot of the frame. A scene that also writes them out shows the same sentence twice, so it must not.' : '- There are no captions, so the words on screen and the words spoken should not be the same words.',
    `- At least four different layouts. ${understanding.seconds} seconds of the same layout is a slideshow.`,
    '- A number is a stat scene. A list is a checklist or steps. A before-and-after is a compare.',
    understanding.pace === 'punchy' ? '- No scene holds for more than four seconds: at most ten spoken words a scene.' : '- No scene holds for more than six seconds.',
    `- All the "say" lines together come to about ${budget} words. Count them.`,
    understanding.person ? '- Headlines are grammatical English. "Investors ask a brutal question" is a headline; "Investors ask brutal question" is a telegram.' : '- Headlines are grammatical English, not telegrams with the small words removed.',
    material.lines.length
      ? '- Every feature, number and name has to be in the material, and has to be quoted in "source". Anything you cannot quote is cut before this is rendered.'
      : '- No statistics of any kind, and no product or company name: there is nothing behind this film to have measured or built anything.',
    understanding.pack === 'sketch'
      ? '- Every picture in this film is the same hand-drawn look, and no scene asks for a photograph.'
      : '- Every picture in this film is the same photograph. No scene may ask for a cartoon, an illustration, a 3d render, a drawing, a painting or anything else drawn: one scene in another look is the fault a stranger sees before they have read a word.',
    `- Never these words: ${FILLER.slice(0, 14).join(', ')}.`,
    ...(understanding.purpose === 'reel' || understanding.purpose === 'ad' ? ['- The first scene is a hook and the last is a cta.'] : []),
    '',
    `The angle: ${plan.angle}`,
    `The hook: ${plan.hook}`,
    `The look of every picture: ${plan.bible}`,
    '',
    'The beats:',
    ...plan.beats.map((beat, index) => `${index + 1}. ${beat.beat}${beat.on_screen ? ` — on screen: ${beat.on_screen}` : ''}\n   say: ${beat.say}`),
    ...(material.assets.length ? ['', 'These are on the card already. Name one in "asset" exactly as written here:', ...material.assets.map((asset) => `- ${asset.name} — ${asset.what}`)] : []),
    ...(material.assets.some((asset) => asset.kind === 'screen')
      ? ['These are the real product. At least one scene is a device scene holding one of them, before any scene is a drawn picture: a film about a product that never shows the product is a film about an idea.']
      : []),
  ].filter((line) => line !== '').join('\n');
}

// The net under the third pass. A plan is already a film — beats, in order, with the line said over each — so a
// storyboard can be built out of it without asking anybody anything. What this loses is judgement about layout, and
// the critic puts most of that back.
export function specFromPlan(plan: Plan, understanding: Understanding, layouts: Layout[]): Spec {
  const can = (layout: Layout) => layouts.includes(layout);
  const reel = understanding.purpose === 'reel' || understanding.purpose === 'ad';
  const scenes: Scene[] = plan.beats.map((beat, index): Scene => {
    const last = index === plan.beats.length - 1;
    const about = `${plan.bible}. ${beat.on_screen || keywords(beat.say, 8)}`;
    if (index === 0 && reel && can('hook')) return { layout: 'hook', text: trimTo(plan.hook || beat.say, HEADING_WORDS), say: beat.say, bg_prompt: about, source: beat.source };
    if (last && reel && can('cta')) return { layout: 'cta', text: trimTo(beat.say, HEADING_WORDS) || 'Follow for more', say: beat.say, bg_prompt: about, source: beat.source };
    const figure = figureIn(beat.on_screen) ?? figureIn(beat.say);
    if (figure && can('stat')) return { layout: 'stat', heading: figure, text: headlineOf(beat.say.replace(figure, ' '), 6), say: beat.say, bg_prompt: about, source: beat.source };
    if (contrasty(beat.say) && can('compare')) {
      const halves = beat.say.split(/\s+(?:but|instead of|rather than|versus|vs\.?)\s+/i);
      if (halves.length >= 2) return { layout: 'compare', bullets: [trimTo(halves[0], 6), trimTo(halves[1], 6)], say: beat.say, bg_prompt: about, source: beat.source };
    }
    if (listy(beat.say) && can('checklist')) {
      const parts = beat.say.split(/[,;]|\band\b/i).map((part) => trimTo(part.trim(), 5)).filter(Boolean).slice(0, 4);
      if (parts.length >= 2) return { layout: 'checklist', heading: 'What you get', bullets: parts, say: beat.say, bg_prompt: about, source: beat.source };
    }
    // One wordless picture in three: a reel that never writes anything is a slideshow of somebody else's photographs.
    if (can('picture') && index % 3 === 2) return { layout: 'picture', image_prompt: about, say: beat.say, source: beat.source };
    return { layout: 'statement', text: headlineOf(beat.say || beat.on_screen, 5), say: beat.say, bg_prompt: about, source: beat.source };
  });
  return { title: trimTo(plan.angle || understanding.audience, 8), scenes: scenes.length ? scenes : [{ layout: 'statement', text: trimTo(plan.hook, HEADING_WORDS), say: plan.hook }] };
}

// --- the whole job ------------------------------------------------------------------------------------------------

export type Think = (prompt: string) => Promise<string>;

// The JSON out of a model that also wanted to explain itself first.
export function jsonIn(said: string): unknown {
  const body = said.slice(said.indexOf('{'), said.lastIndexOf('}') + 1);
  if (!body) throw new Error('the answer held no JSON object');
  try { return JSON.parse(body); } catch { throw new Error('the answer was not valid JSON'); }
}
const askJson = async (think: Think, prompt: string, tries = 2): Promise<unknown> => {
  let problem = '';
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try { return jsonIn(await think(`${prompt}${problem ? `\n\nYour last answer could not be used: ${problem}\nAnswer again, JSON only.` : ''}`)); } catch (error) { problem = (error as Error).message; }
  }
  throw new Error(problem || 'no answer');
};

// Which layouts this film may actually use, so nothing is offered that could not be filled — or, in the presenter's
// case, could not be filled *honestly*. A presenter is a mouth moving to a recording, so it is offered only where a
// real lip-sync backend is standing by; without one the model never sees the word and never writes the scene.
export function layoutsFor(ask: { ai: boolean; lipsync?: boolean; material: Material }): Layout[] {
  return LAYOUTS.filter((layout) => ask.ai || !AI_LAYOUTS.has(layout))
    .filter((layout) => layout !== 'presenter' || ask.lipsync === true)
    .filter((layout) => layout !== 'footage' || ask.material.assets.some((asset) => asset.kind === 'video'))
    .filter((layout) => layout !== 'device' || ask.material.assets.some((asset) => asset.kind === 'screen'));
}

export type Directed = { understanding: Understanding; plan: Plan; spec: Spec; bible: string };

// Four passes and a reading. The model is asked to fix its own work twice, because its writing is better than ours;
// after that the rules do it themselves, and the film is made either way.
export async function direct(asked: Asked, material: Material, think: Think,
  help: { report: (line: string) => void; ai?: boolean; lipsync?: boolean; signal?: AbortSignal }): Promise<Directed> {
  // A film stopped while the director is thinking asks the model nothing more. Each pass swallows its own failure
  // and falls back, so the stop is looked at before each one rather than left to a failure nobody hears.
  const halt = () => { if (help.signal?.aborted) throw new Error('stopped'); };
  halt();
  const read = readBrief(asked.brief);
  const raw = await askJson(think, understandPrompt(asked, material)).catch(() => ({}));
  const understanding = understandingOf(raw, asked, read);
  help.report(understanding.said);

  const layouts = layoutsFor({ ai: help.ai === true, lipsync: help.lipsync === true, material });
  halt();
  const plan = planOf(await askJson(think, planPrompt(understanding, asked, material)).catch(() => ({})), understanding, asked);
  if (plan.beats.length) help.report(`the angle: ${plan.angle.slice(0, 120)}`);
  else help.report('the plan came back empty, so the storyboard is written straight from the brief');

  const want: Want = {
    seconds: understanding.seconds, pace: understanding.pace, purpose: understanding.purpose,
    captions: understanding.captions, bible: plan.bible, layouts,
    reel: understanding.purpose === 'reel' || understanding.purpose === 'ad',
    product: material.lines.length > 0 || material.assets.length > 0 || !!material.brand,
    sources: sourcesOf(material, asked.brief),
    screens: material.assets.filter((asset) => asset.kind === 'screen').map((asset) => asset.name),
    pictures: givenPictures(material).slice(0, MOST_GIVEN),
    // A rule that cannot be satisfied honestly is not a rule. Asked for somebody on camera with nothing able to
    // lip-sync one, the critic used to recast a scene as "a person moving" — which is a drawn stranger whose
    // mouth moves to a recording they never made, and is precisely what the founder rejected.
    person: understanding.person && help.lipsync === true,
  };

  // The storyboard, and one more go with the reason the first would not do: a model that forgot a field usually
  // remembers it when told which one. Only when it cannot manage that at all is the plan built into a film by hand.
  let spec: Spec | null = null;
  let wrong = '';
  const brief = specPrompt(plan, understanding, material, layouts);
  for (let attempt = 0; attempt < 2 && !spec; attempt += 1) {
    halt();
    try {
      spec = parseSpec(await askJson(think, `${brief}${wrong ? `\n\nYour last storyboard could not be used: ${wrong}\nAnswer again, the whole object, JSON only.` : ''}`, 1));
    } catch (error) { wrong = (error as Error).message; }
  }
  if (!spec?.scenes.length) {
    help.report(`the storyboard would not come out of the model (${wrong || 'it answered nothing'}), so it is built from the plan`);
    spec = specFromPlan(plan, understanding, layouts);
  }

  // The reading. Two goes at its own work, then the rules do it.
  for (let round = 0; round < 2; round += 1) {
    const found = criticise(spec, want);
    if (!found.length) break;
    halt();
    help.report(round === 0 ? `the first storyboard did not hold up (${found[0].says}), tightening it` : 'still not right, one more pass');
    try {
      const fixed = parseSpec(await askJson(think, fixPrompt(spec, found, understanding, layouts), 1));
      if (criticise(fixed, want).length < found.length) spec = fixed;
      else break;
    } catch { break; }
  }
  const last = criticise(spec, want);
  if (last.length) {
    const { spec: mended, notes } = repair(spec, want);
    spec = mended;
    for (const line of notes.slice(0, 5)) help.report(line);
  }
  // Whatever survives, the last word on shape and length is the rules', not the model's.
  const { spec: final } = repair(spec, want);
  // How each picture is taken, last, because every pass above may have changed which scenes are pictures.
  const shots = mendShots(final, { pace: understanding.pace, look: understanding.pack });
  spec = shots.spec;
  for (const line of shots.notes.slice(0, 3)) help.report(line);
  help.report(`${spec.scenes.length} scenes, about ${saidWords(spec)} words said: ${spec.title}`);
  return { understanding, plan, spec, bible: plan.bible };
}

// A brief that asks for somebody talking to camera gets somebody talking to camera — or it gets told, plainly,
// why it cannot have one today.
//
// What used to happen here is the whole of what the founder rejected. A brief saying "influencer talking, real
// face" was answered by asking a small text-to-video model for "a person talking to camera", stretching the three
// seconds it gave back over seventeen by cutting between the shot and a re-crop of the same shot, and laying an
// unrelated recording over the top of it. Every one of those is a known failure: a mouth that does not match the
// audio is flagged before a viewer has thought about it and downgrades trust in everything else on screen; a
// re-crop of one clip is not a second angle, it is the same three seconds again; and a person who moves without
// any physical reason for moving reads as weightless. The research is unanimous and there is no dissent to weigh:
// **a non-lip-synced talking figure under narration is never acceptable.**
//
// So there is now exactly one way a person speaks in one of these films: a real lip-sync backend, given the actual
// recording, makes the actual mouth match it. When none is ready the film does not fake it — it becomes the
// faceless edit, which the same research says performs no worse for informational content, and the card says what
// would be needed to get a real one instead.
// The shapes an opening can take and still be somebody talking. A wordmark or a title card is the one thing a
// person cannot be put inside.
const OPENS = new Set<Layout>(['hook', 'statement', 'picture', 'quote', 'outro', 'cta', 'stat']);
// How many handed-over pictures a film will carry. More than this and the film is a slideshow of somebody's folder.
export const MOST_GIVEN = 3;

// The pictures a film has been handed: drawn in a wired image studio, dropped on the stage, or named outright by
// somebody who had just made one. A film given a picture and not showing it is a film that ignored the founder.
export const givenPictures = (material: Material): string[] =>
  material.assets.filter((one) => one.kind === 'image').map((one) => one.name);

// Whether there is somebody in a picture, read off the words it was drawn from. That is the only description of it
// anybody has when nothing has the quota to look at it, and it is usually a good one: a picture of an influencer
// was asked for as a picture of an influencer.
const SOMEBODY_IN = /\b(person|people|man|woman|girl|boy|founder|influencer|presenter|speaker|host|face|portrait|headshot|selfie|model|someone|somebody|talking|speaking)\b/i;
export const showsSomebody = (asset: { prompt?: string; what?: string }): boolean =>
  SOMEBODY_IN.test(`${asset.prompt ?? ''} ${asset.what ?? ''}`);

// The one of a film's pictures that can stand in for the person the brief asked for, or nothing.
export const faceIn = (material: Material): string | undefined =>
  material.assets.find((one) => one.kind === 'image' && showsSomebody(one))?.name;

// Whether a moving scene already has somebody in it. A clip of hands over a desk is a clip; it is not the person
// the brief asked for, and a film that counts it as one has nobody on camera at all.
const SOMEBODY = /\b(person|people|man|woman|founder|speaker|influencer|presenter|host|face|talking head|him|her|they|creator|someone|somebody)\b/i;
// Somebody whose mouth is moving. This is the one thing the studio will not draw without a lip-sync backend, so
// it is matched on its own terms rather than inferred from "there is a person in this shot": hands over a desk
// are b-roll, a face saying words is a promise the film cannot keep.
const SPEAKING = /\b(talking|speaking|says?|saying|to camera|down the lens|into the lens|piece to camera|presenter|host|vlog|address(?:ing|es)?)\b/i;
export const hasSomebody = (scene: Scene): boolean =>
  scene.layout === 'presenter' || scene.layout === 'footage'
  || (scene.layout === 'clip' && SOMEBODY.test(`${scene.clip_prompt ?? ''} ${scene.portrait_prompt ?? ''}`));

// Who the film reads itself in. Nothing here guesses at a person's identity: it reads the words the founder wrote
// — "a man's voice", "British", "her" — and hands the rest to the grades.
const SAYS_MAN = /\b(male|man's|mans|man |men|guy|his voice|he |him |bloke|gentleman|male voice|deep voice|father|dad|brother|son|sir|mr\b)/i;
const SAYS_WOMAN = /\b(female|woman's|womans|woman |women|her voice|she |her |lady|female voice|mother|mum|mom|sister|daughter|ms\b|mrs\b)/i;
const SAYS_BRITISH = /\b(british|uk|england|english accent|london|received pronunciation|rp\b)/i;
const SAYS_AMERICAN = /\b(american|us|usa|new york|california|midwest|american accent)\b/i;
export function narratorWanted(brief: string, understanding?: { audience?: string; tone?: string }): Wanted {
  const said = `${brief} ${understanding?.audience ?? ''} ${understanding?.tone ?? ''}`;
  const want: Wanted = {};
  if (SAYS_MAN.test(said) && !SAYS_WOMAN.test(said)) want.gender = 'm';
  else if (SAYS_WOMAN.test(said) && !SAYS_MAN.test(said)) want.gender = 'f';
  if (SAYS_BRITISH.test(said)) want.accent = 'British';
  else if (SAYS_AMERICAN.test(said)) want.accent = 'American';
  return want;
}

// What a scene of somebody on camera becomes when nobody can lip-sync it: the line is still said, the picture the
// founder made is still shown, but nobody's mouth moves out of time with the words. A face held still under a
// voice is a photograph of a person, which is honest; a face moving out of sync with the voice is not.
const facelessly = (scene: Scene): Scene => (scene.asset
  ? { ...scene, layout: 'picture', image_prompt: undefined, portrait_prompt: undefined, clip_prompt: undefined, person: undefined }
  : { ...scene, layout: 'statement', text: scene.text || headlineOf(scene.say ?? '', HEADING_WORDS) || undefined, heading: undefined,
    bg_prompt: undefined, portrait_prompt: undefined, clip_prompt: undefined, image_prompt: undefined, person: undefined });

// Why this film has nobody speaking on camera, and the two real ways to get one. Said once, in plain words, because
// a founder who asked for a face and got type deserves the reason rather than a silence.
export const NO_FACE_HINT = 'nothing here can make a mouth match a recording, so the film shows no talking person at all — '
  + 'a fake one is the single fastest way to make a film look generated. To get a real one: drop your own footage of somebody '
  + 'talking on the card, or add HF_TOKEN to .env so the free lip-sync service can be used.';

// The whole of the person question, settled before anything is made.
//
// `lipsync` is whether a real lip-sync backend is ready right now. It is the only thing that decides whether the
// film may show a mouth moving; nothing else in here can grant it.
export function onCamera(scenes: Scene[], understanding: Understanding, bible: string, report: (line: string) => void,
  lipsync?: { ready: boolean; narratorGender?: 'f' | 'm'; personGender?: 'f' | 'm' }, face?: string): Scene[] {
  const able = lipsync?.ready === true;
  // A voice that does not match the person on screen is the other half of the same fault. Where the film knows both
  // — the founder named a gender, or the picture was drawn as a man or a woman — and they disagree, nobody is put
  // on camera at all, whatever the backend could have done.
  const mismatched = !!lipsync?.narratorGender && !!lipsync?.personGender && lipsync.narratorGender !== lipsync.personGender;
  const mayShow = able && !mismatched;

  // Whatever anybody wrote, nothing gets to be a talking person unless a real lip-sync backend will really make
  // it. This runs before the brief is even consulted, so a person's own tool call cannot walk round it — and it
  // catches both ways of asking: a `presenter` scene, and a `clip` scene whose prompt is somebody speaking to
  // camera, which is the same fault with the layout filed off.
  let held = scenes;
  const faking = (one: Scene) => one.layout === 'presenter'
    || (one.layout === 'clip' && SPEAKING.test(`${one.clip_prompt ?? ''} ${one.portrait_prompt ?? ''}`));
  if (!mayShow && scenes.some(faking)) {
    report(mismatched
      ? 'the narrator and the person on screen are not the same gender, so the film shows nobody speaking rather than a face that does not match the voice'
      : NO_FACE_HINT);
    held = scenes.map((one) => (faking(one) ? facelessly(one) : one));
  }
  if (!understanding.person) return held;

  // A real picture of a real person, already on the card, is who the film puts on screen. It is what the founder
  // meant when they wired the studio that drew it, and a still with a slow move on it is a shot — it is only a
  // *speaking* face that has to be earned.
  if (face) {
    let used = false;
    const withFace = held.map((scene) => {
      if (scene.layout !== 'presenter' || scene.asset) return scene;
      used = true;
      return { ...scene, asset: face, portrait_prompt: undefined };
    });
    if (used) { report('the film uses the picture from your image studio as the person on screen'); return withFace; }
    const at = held.findIndex((scene) => !scene.asset && !scene.image_prompt && scene.layout !== 'device' && scene.layout !== 'footage');
    if (at >= 0) {
      report('the film uses the picture from your image studio as the person on screen');
      return held.map((scene, index) => (index === at
        ? { ...scene, layout: 'picture' as Layout, asset: face, image_prompt: undefined, bg_prompt: undefined }
        : scene));
    }
  }

  // Somebody is in this film already — the model wrote them, or a person's own tool call did. That is not the same
  // as the film opening on them, and a reel that wants a person is a reel where the person says the hook.
  if (held.some(hasSomebody)) {
    if (hasSomebody(held[0]) || !OPENS.has(held[0].layout)) return held;
    const first = held.find(hasSomebody)!;
    report('the brief asks for somebody on camera, so the film opens on them rather than getting to them later');
    return held.map((scene, index) => (index === 0
      ? { ...scene, layout: first.layout, person: true, clip_prompt: first.clip_prompt, portrait_prompt: first.portrait_prompt, asset: face ?? first.asset, image_prompt: undefined }
      : scene));
  }

  // Nobody on camera, and nothing that can honestly put them there. The film stays faceless and says so once —
  // rather than drawing a stranger, moving their mouth to somebody else's words, and hoping.
  report(NO_FACE_HINT);
  return held;
}

export function fixPrompt(spec: Spec, found: { says: string }[], understanding: Understanding, layouts: Layout[]): string {
  return [
    'This storyboard was read by the film\'s editor and sent back. Fix exactly these things and change nothing else. Answer with the whole corrected JSON object and nothing else.',
    '',
    ...found.map((one) => `- ${one.says}`),
    '',
    `Layouts you may use: ${layouts.join(', ')}.`,
    `A heading is at most ${HEADING_WORDS} words and a line of text at most ${TEXT_WORDS}. ${understanding.captions ? 'The narration is already captioned on screen, so a scene must not also write it out.' : ''}`,
    `All the "say" lines together must come to about ${budgetOf(understanding.seconds, spec.scenes.length, understanding.pace)} words.`,
    '',
    JSON.stringify(spec),
  ].join('\n');
}

// --- pass four: the pictures ---------------------------------------------------------------------------------
//
// The three passes above decide what the film says. This one decides what is on the screen while it says it, and
// it runs after the edit rather than before it, because until the film has been read aloud and cut nobody knows
// how many pictures it needs. The rules, the critic and the deterministic repair are all in `visuals.ts`; this is
// only the part that talks to a model, and it works the way every other pass here does — two goes at its own
// work, because a model's own repair is better writing than ours, and then the rules do it and the film is made
// either way.
export async function photograph(slots: Visual[], bible: string, angle: string, think: Think,
  help: { report: (line: string) => void; signal?: AbortSignal }): Promise<Visual[]> {
  const halt = () => { if (help.signal?.aborted) throw new Error('stopped'); };
  halt();
  let visuals = slots;
  try {
    visuals = visualsOf(await askJson(think, visualsPrompt(slots, bible, angle), 1), slots);
  } catch { help.report('nothing came back about what is on screen, so the pictures are built from the lines themselves'); }

  for (let round = 0; round < 2; round += 1) {
    const found = criticiseVisuals(visuals);
    if (!found.length) break;
    halt();
    help.report(round === 0
      ? `the pictures did not hold up (${found[0].says}), so they are being written again`
      : 'the pictures are still repeating themselves, one more pass');
    try {
      const again = visualsOf(await askJson(think, fixPictures(visuals, found, bible), 1), visuals);
      if (criticiseVisuals(again).length < found.length) visuals = again;
      else break;
    } catch { break; }
  }
  const { visuals: mended, notes } = repairVisuals(visuals);
  for (const line of notes.slice(0, 3)) help.report(line);
  return mended;
}

// The pictures, sent back with what is wrong with each one named. A model told "picture four is generic" fixes
// picture four; a model told "try again" writes the same six pictures.
export function fixPictures(visuals: Visual[], found: { at: number; says: string }[], bible: string): string {
  return [
    'These pictures were read by the film\'s editor and sent back. Fix exactly these and change nothing else.',
    'Answer with the whole corrected JSON object and nothing else.',
    '',
    ...found.slice(0, 10).map((one) => `- ${one.says}`),
    '',
    `Every picture is shot the same way: ${bible}`,
    'A picture names a subject, what it is doing and where. No two pictures in the film may be of the same thing.',
    'At most one picture in the film may have a person in it; the rest are places, objects and details.',
    'Nothing in a picture may carry writing — no screen, no chart, no sign, no document, no logo.',
    '',
    JSON.stringify({ pictures: visuals.map((one) => ({ at: one.at + 1, subject: one.subject, metaphor: one.metaphor })) }),
  ].join('\n');
}
