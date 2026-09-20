import type { Shape } from '../../shared/model.ts';
import { MOODS, type Mood } from './audio.ts';
import { contrasty, criticise, figureIn, hasNumber, headlineOf, keywords, listy, repair, trimTo, type Want } from './critic.ts';
import {
  AI_LAYOUTS, budgetOf, CAPS, HEADING_WORDS, isPurpose, LAYOUTS, MAX_SCENES, parseSpec, PURPOSE, PURPOSES,
  saidWords, scenesFor, TEXT_WORDS, type Layout, type Purpose, type Scene, type Spec,
} from './spec.ts';
import { isPack, PACES, PACKS, type Brand, type Pace, type Pack } from './templates/looks.ts';
import { FILLER, sourcesOf } from './grounding.ts';

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
  const bible = typeof said.style_bible === 'string' && said.style_bible.trim().length > 12
    ? said.style_bible.trim().slice(0, 180)
    : bibleFor(understanding);
  const hook = typeof said.hook === 'string' && said.hook.trim() ? trimTo(said.hook.trim(), 9) : trimTo(asked.brief, 8);
  return { angle: String(said.angle ?? '').slice(0, 200) || asked.brief.slice(0, 160), hook, bible, beats: beats.slice(0, MAX_SCENES) };
}

// A style bible the film can fall back on: every pack has a way pictures look in it, and a film with a consistent
// look made out of a fixed line is still a film, where six unrelated stock pictures are not.
export function bibleFor(understanding: Understanding): string {
  const by: Record<Pack, string> = {
    creator: 'high-contrast editorial photography, single strong subject, deep shadows, one saturated accent light, shallow depth of field, shot on 35mm',
    editorial: 'quiet documentary photography, soft window light, muted warm palette, generous negative space, medium format stills',
    neon: 'dark technical photography, cyan and magenta rim light, glass and metal surfaces, volumetric haze, long lens',
    clean: 'calm studio photography, cool slate palette, soft directional light, clean geometry, matte surfaces',
    sketch: 'loose ink and watercolour illustration on warm paper, visible pencil under-drawing, limited palette',
    brand: 'clean still-life photography, soft even light, uncluttered surfaces, one accent colour, matte finish',
  };
  return by[understanding.pack] ?? by.clean;
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

// Which layouts this film may actually use, so nothing is offered that could not be filled.
export function layoutsFor(ask: { ai: boolean; material: Material }): Layout[] {
  return LAYOUTS.filter((layout) => ask.ai || !AI_LAYOUTS.has(layout))
    .filter((layout) => layout !== 'footage' || ask.material.assets.some((asset) => asset.kind === 'video'))
    .filter((layout) => layout !== 'device' || ask.material.assets.some((asset) => asset.kind === 'screen'));
}

export type Directed = { understanding: Understanding; plan: Plan; spec: Spec; bible: string };

// Four passes and a reading. The model is asked to fix its own work twice, because its writing is better than ours;
// after that the rules do it themselves, and the film is made either way.
export async function direct(asked: Asked, material: Material, think: Think, help: { report: (line: string) => void; ai?: boolean }): Promise<Directed> {
  const read = readBrief(asked.brief);
  const raw = await askJson(think, understandPrompt(asked, material)).catch(() => ({}));
  const understanding = understandingOf(raw, asked, read);
  help.report(understanding.said);

  const layouts = layoutsFor({ ai: help.ai === true, material });
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
    person: understanding.person,
  };

  // The storyboard, and one more go with the reason the first would not do: a model that forgot a field usually
  // remembers it when told which one. Only when it cannot manage that at all is the plan built into a film by hand.
  let spec: Spec | null = null;
  let wrong = '';
  const brief = specPrompt(plan, understanding, material, layouts);
  for (let attempt = 0; attempt < 2 && !spec; attempt += 1) {
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
  spec = final;
  help.report(`${spec.scenes.length} scenes, about ${saidWords(spec)} words said: ${spec.title}`);
  return { understanding, plan, spec, bible: plan.bible };
}

// A brief that asks for somebody talking to camera gets somebody talking to camera. With the founder's own footage
// or a made clip there is a real person; with neither, the film opens on a portrait with a slow push into it, which
// is what a reel does when the creator is not the one holding the camera. Nothing here invents a name or a claim —
// it is a face, and the words over it are the film's own.
// The most a film gets of somebody talking to the camera when this machine is drawing them: two, because each one
// costs minutes of the founder's time and a third is a third of the film.
export const MOST_FACES = 2;
// What somebody drawn for a film wears and how they are framed. Left unsaid, a small video model draws bare shoulders
// in a close crop, which is not who a founder wants speaking for them.
const DRESSED = 'fully dressed in a smart casual shirt';
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
export const hasSomebody = (scene: Scene): boolean =>
  scene.layout === 'presenter' || scene.layout === 'footage'
  || (scene.layout === 'clip' && SOMEBODY.test(`${scene.clip_prompt ?? ''} ${scene.portrait_prompt ?? ''}`));

export function onCamera(scenes: Scene[], understanding: Understanding, bible: string, report: (line: string) => void,
  filmHere?: { minutes: number }, face?: string): Scene[] {
  if (!understanding.person) return scenes;
  // A real picture of a real person, already on the card, beats anything drawn from a sentence — and it is what the
  // founder meant when they wired the studio that drew it. So it goes in before anything else is decided, and no
  // picture service is asked for a face the film already has.
  let held = scenes;
  if (face) {
    let used = false;
    held = scenes.map((scene) => {
      if (scene.layout !== 'presenter' || scene.asset) return scene;
      used = true;
      return { ...scene, asset: face, portrait_prompt: undefined };
    });
    if (used) { report('the film uses the picture from your image studio as the person on screen'); return held; }
    // Nobody on camera was written at all: the opening holds the picture instead of a drawing of a stranger.
    const at = held.findIndex((scene) => !scene.asset && !scene.image_prompt && scene.layout !== 'device' && scene.layout !== 'footage');
    if (at >= 0) {
      report('the film uses the picture from your image studio as the person on screen');
      return held.map((scene, index) => (index === at
        ? { ...scene, layout: 'picture' as Layout, asset: face, image_prompt: undefined, bg_prompt: undefined }
        : scene));
    }
  }
  if (held.some(hasSomebody)) return held;
  scenes = held;
  // The bible says "single strong subject, shallow depth of field", and a picture model reads that as a macro of
  // somebody's mouth. A talking head has to be asked for as a talking head: the framing first, and loudly.
  const look = bible.replace(/,?\s*shallow depth of field/i, '');
  const facing = `one person ${DRESSED}, seen from the waist up in a medium shot, facing the camera and talking to it, gesturing with both hands as they speak, head, shoulders and hands all inside the frame with room above, both eyes open and looking into the lens`;
  const portrait = `a medium shot of ${facing}, ${look}`;
  // The opening, and one more in the middle of anything long enough to come back to a face.
  const faces = new Set([0, ...(scenes.length >= 5 ? [Math.floor(scenes.length / 2)] : [])]);
  // Whether the person moves. A still of somebody mid-sentence is a photograph of a person, not a person talking,
  // and the brief asked for the second one — so where this machine can draw a moving shot, it draws one. It is not
  // left to the model to choose: a model that writes a talking-head scene writes it as a `presenter`, which only
  // the free online service makes, and when that is out of quota the film quietly has nobody in it at all.
  // A clip scene the model wrote of something else is one of the film's moving shots already, so the film does not
  // get two more on top of it — unless it sits where a face is going, in which case it is the one being replaced.
  const already = scenes.filter((one, index) => one.layout === 'clip' && !faces.has(index)).length;
  let given = 0;
  const made = scenes.map((scene, index) => {
    if (!faces.has(index) || scene.image_prompt || scene.asset) return scene;
    if (filmHere && given + already < MOST_FACES) {
      given += 1;
      return { ...scene, layout: 'clip' as Layout, clip_prompt: `${facing}, talking with their mouth moving, natural head movement and hand gestures, shifting their weight, static camera, ${look}`, bg_prompt: portrait, image_prompt: undefined };
    }
    given += 1;
    return { ...scene, bg_prompt: portrait };
  });
  if (given && filmHere) {
    report(`the brief wants somebody on camera, so this computer films ${given === 1 ? 'one shot' : `${given} shots`} of a person talking — about ${filmHere.minutes * given} minutes, and nothing leaves the machine`);
  } else if (given) {
    report(`the brief wants somebody on camera and there is no footage, so ${given === 1 ? 'the opening sits' : 'two scenes sit'} on a face`);
  }
  return made;
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
