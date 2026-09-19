import type { Shape } from '../../shared/model.ts';
import { MOODS, type Mood } from './audio.ts';
import { contrasty, criticise, figureIn, hasNumber, keywords, listy, repair, trimTo, type Want } from './critic.ts';
import {
  AI_LAYOUTS, budgetOf, CAPS, HEADING_WORDS, isPurpose, LAYOUTS, MAX_SCENES, parseSpec, PURPOSE, PURPOSES,
  saidWords, scenesFor, TEXT_WORDS, type Layout, type Purpose, type Scene, type Spec,
} from './spec.ts';
import { isPack, PACES, PACKS, type Brand, type Pace, type Pack } from './templates/looks.ts';

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
export type Material = { lines: string[]; assets: { name: string; kind: string; what: string }[]; brand?: Brand; using: string[] };

// What the director understood, which is the thing the card shows the founder before anything is made.
export type Understanding = {
  purpose: Purpose; audience: string; platform: string; shape: Shape; seconds: number;
  pace: Pace; tone: string; mood: Mood; pack: Pack; person: boolean; captions: boolean;
  // One line, in the founder's own kind of words: "reading the brief: a 15-second vertical reel, punchy, upbeat…"
  said: string;
};

// The creative plan: what this film is going to argue, how it opens, and what every picture in it has in common.
export type Beat = { beat: string; on_screen: string; say: string; seconds?: number };
export type Plan = { angle: string; hook: string; bible: string; beats: Beat[] };

const one = <T>(value: unknown, allowed: readonly T[]): T | undefined => (allowed as readonly unknown[]).includes(value) ? value as T : undefined;
const set = <T>(value: Choice<T>): T | undefined => (value === 'auto' || value === undefined || value === null || value === '' as unknown as T ? undefined : value);

// --- reading the brief without asking anybody -----------------------------------------------------------------

// The words a founder actually writes, and what each of them really asks for. This runs before the model and again
// as its net: a model that answers nonsense never moves the film away from what the brief plainly said.
const CUES: { was: RegExp; is: Partial<Understanding> }[] = [
  { was: /\b(reel|tiktok|short-?form|shorts|influencer|creator|vertical|for (?:my )?(?:ig|insta|instagram))\b/i, is: { purpose: 'reel', shape: 'tall', pace: 'punchy', pack: 'creator', captions: true, mood: 'drive' } },
  { was: /\b(ad|advert|commercial|promo)\b/i, is: { purpose: 'ad', pace: 'punchy', captions: true, mood: 'drive' } },
  { was: /\b(launch|launching|announc\w+|introducing|we (?:just )?shipped|out now|release)\b/i, is: { purpose: 'launch', pace: 'punchy', captions: true, mood: 'bright' } },
  { was: /\b(pitch|investors?|raising|seed round|fundrais\w+|vc)\b/i, is: { purpose: 'pitch', shape: 'wide', pace: 'calm', pack: 'editorial', mood: 'calm' } },
  { was: /\b(testimonial|customer story|case study|what .{0,20}customers? say)\b/i, is: { purpose: 'testimonial', pace: 'calm', mood: 'warm' } },
  { was: /\b(explain\w*|how it works|walkthrough|tutorial|demo|onboarding)\b/i, is: { purpose: 'explainer', shape: 'wide', pace: 'calm', pack: 'clean', mood: 'calm' } },
  { was: /\b(feature|one thing|new in)\b/i, is: { purpose: 'feature' } },
  { was: /\b(calm|quiet|slow|editorial|elegant|minimal|considered|understated|thoughtful)\b/i, is: { pace: 'calm', pack: 'editorial', mood: 'calm', tone: 'considered' } },
  { was: /\b(punchy|fast|snappy|energetic|hype|bold|loud|upbeat)\b/i, is: { pace: 'punchy', mood: 'drive', tone: 'energetic' } },
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
  const digits = /(\d{1,3})\s*(?:-|\s)?\s*(?:second|sec|s)\b/i.exec(brief);
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
  const purpose = set(asked.purpose) ?? (isPurpose(said.purpose) ? said.purpose : undefined) ?? read.purpose ?? 'explainer';
  const preset = PURPOSE[purpose];
  const seconds = (() => {
    const want = typeof asked.seconds === 'number' ? asked.seconds : read.seconds ?? Number(said.seconds);
    return Number.isFinite(want) && want >= 8 && want <= 180 ? Math.round(want) : preset.length;
  })();
  const person = set(asked.person) ?? (typeof said.person_on_camera === 'boolean' ? said.person_on_camera : undefined) ?? read.person ?? preset.person;
  const understanding: Understanding = {
    purpose,
    audience: typeof said.audience === 'string' && said.audience.trim() ? said.audience.trim().slice(0, 80) : 'whoever the founder is trying to reach',
    platform: typeof said.platform === 'string' && said.platform.trim() ? said.platform.trim().slice(0, 40) : (preset.format === 'tall' ? 'a phone feed' : 'a screen'),
    shape: set(asked.shape) ?? one(said.format, ['wide', 'tall', 'square'] as const) ?? read.shape ?? preset.format,
    seconds,
    pace: set(asked.pace) ?? one(said.pace, PACES) ?? read.pace ?? preset.pace,
    tone: typeof said.tone === 'string' && said.tone.trim() ? said.tone.trim().slice(0, 60) : read.tone ?? (preset.pace === 'punchy' ? 'direct and quick' : 'measured'),
    mood: set(asked.music) ?? one(said.music, MOODS) ?? read.mood ?? preset.music,
    pack: set(asked.pack) ?? (isPack(said.look) ? said.look : undefined) ?? read.pack ?? preset.pack,
    person,
    captions: asked.captions ?? (typeof said.captions === 'boolean' ? said.captions : undefined) ?? read.captions ?? preset.captions,
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
    ` "beats": [{"beat": "what this beat does for the viewer", "on_screen": "what is seen — a picture of what, a number, a list, a screen", "say": "the line spoken over it, written the way a person would say it aloud"}]}`,
    '',
    `Write ${least} to ${most} beats. ${PURPOSE[understanding.purpose].shape}`,
    `All the "say" lines together must come to about ${budget} words — that is what makes the film ${understanding.seconds} seconds long, and it is a hard number. Count them.`,
    'Each beat says one thing. No beat says two things. Nothing is repeated in a later beat.',
    understanding.person ? 'The brief wants a person talking to camera, so the opening beats are written as somebody speaking, in the first person.' : '',
    material.lines.length ? 'Use the product\'s own words and its real claims below; invent no feature, number or customer it does not have.' : 'Invent no numbers, no customer names and no claims that cannot be checked.',
    material.lines.length ? ['', ...material.lines].join('\n') : '',
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
    brand: 'clean product photography, soft even light, uncluttered surfaces, one accent colour, matte finish',
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
    ...(understanding.pack === 'creator' ? ['- "icon": one emoji that belongs beside this scene, or leave it out.'] : []),
    '',
    'The rules this storyboard is checked against, before it is rendered:',
    `- What is on screen is a headline, never the narration. A heading is at most ${HEADING_WORDS} words and a line of text at most ${TEXT_WORDS}.`,
    understanding.captions ? '- The spoken words are already captioned word by word at the foot of the frame. A scene that also writes them out shows the same sentence twice, so it must not.' : '- There are no captions, so the words on screen and the words spoken should not be the same words.',
    `- At least four different layouts. ${understanding.seconds} seconds of the same layout is a slideshow.`,
    '- A number is a stat scene. A list is a checklist or steps. A before-and-after is a compare.',
    understanding.pace === 'punchy' ? '- No scene holds for more than four seconds: at most ten spoken words a scene.' : '- No scene holds for more than six seconds.',
    `- All the "say" lines together come to about ${budget} words. Count them.`,
    ...(understanding.purpose === 'reel' || understanding.purpose === 'ad' ? ['- The first scene is a hook and the last is a cta.'] : []),
    '',
    `The angle: ${plan.angle}`,
    `The hook: ${plan.hook}`,
    `The look of every picture: ${plan.bible}`,
    '',
    'The beats:',
    ...plan.beats.map((beat, index) => `${index + 1}. ${beat.beat}${beat.on_screen ? ` — on screen: ${beat.on_screen}` : ''}\n   say: ${beat.say}`),
    ...(material.assets.length ? ['', 'These are on the card already. Name one in "asset" exactly as written here:', ...material.assets.map((asset) => `- ${asset.name} — ${asset.what}`)] : []),
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
    if (index === 0 && reel && can('hook')) return { layout: 'hook', text: trimTo(plan.hook || beat.on_screen || beat.say, HEADING_WORDS), say: beat.say, bg_prompt: about };
    if (last && reel && can('cta')) return { layout: 'cta', text: trimTo(keywords(beat.say, 5), 5) || 'Follow for more', say: beat.say, bg_prompt: about };
    const figure = figureIn(beat.on_screen) ?? figureIn(beat.say);
    if (figure && can('stat')) return { layout: 'stat', heading: figure, text: trimTo(keywords((beat.on_screen || beat.say).replace(figure, ' '), 6), 6), say: beat.say, bg_prompt: about };
    if (contrasty(beat.say) && can('compare')) {
      const halves = beat.say.split(/\s+(?:but|instead of|rather than|versus|vs\.?)\s+/i);
      if (halves.length >= 2) return { layout: 'compare', bullets: [trimTo(halves[0], 6), trimTo(halves[1], 6)], say: beat.say, bg_prompt: about };
    }
    if (listy(beat.say) && can('checklist')) {
      const parts = beat.say.split(/[,;]|\band\b/i).map((part) => trimTo(part.trim(), 5)).filter(Boolean).slice(0, 4);
      if (parts.length >= 2) return { layout: 'checklist', heading: 'What you get', bullets: parts, say: beat.say, bg_prompt: about };
    }
    if (can('picture') && index % 2 === 1) return { layout: 'picture', image_prompt: about, say: beat.say };
    return { layout: 'statement', text: trimTo(keywords(beat.on_screen || beat.say, HEADING_WORDS), HEADING_WORDS), say: beat.say, bg_prompt: about };
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
  };

  let spec: Spec;
  try {
    spec = parseSpec(await askJson(think, specPrompt(plan, understanding, material, layouts)));
  } catch (error) {
    help.report(`the storyboard would not come out of the model (${(error as Error).message}), so it is built from the plan`);
    spec = specFromPlan(plan, understanding, layouts);
  }
  if (!spec.scenes.length) spec = specFromPlan(plan, understanding, layouts);

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
    for (const line of notes.slice(0, 4)) help.report(line);
  }
  // Whatever survives, the last word on shape and length is the rules', not the model's.
  const { spec: final } = repair(spec, want);
  spec = final;
  help.report(`${spec.scenes.length} scenes, about ${saidWords(spec)} words said: ${spec.title}`);
  return { understanding, plan, spec, bible: plan.bible };
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
