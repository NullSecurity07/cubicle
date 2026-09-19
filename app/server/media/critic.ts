import {
  budgetOf, countWords, HEADING_WORDS, MAX_SCENES, saidWords, TEXT_WORDS, VISUAL_LAYOUTS,
  type Layout, type Purpose, type Scene, type Spec,
} from './spec.ts';
import type { Pace } from './templates/looks.ts';

// The critic. A free model asked for a storyboard will, left alone, write the same scene three times, put the whole
// of the narration on screen as a wall of type, and hand back a minute and a half where fifteen seconds were asked
// for. That is not a prompt problem — it is what a weak model does under any prompt — so nothing the model writes
// reaches the renderer until it has been read by a set of rules that know what a film is.
//
// Every rule here can say what is wrong *and* put it right without asking anybody. The model gets two goes at fixing
// its own work, because a model's repair is better writing than ours; after that these functions do it, and the job
// never fails for want of a good storyboard.

export type Want = {
  seconds: number; pace: Pace; purpose: Purpose; captions: boolean;
  // Whether this film has a product behind it. Without one, a wordmark is a brand the film made up.
  product?: boolean;
  // The one line of visual direction every drawn picture in this film is prefixed with, so six pictures look like
  // six frames of one film rather than six stock photos.
  bible: string;
  // The layouts this film may actually use: no footage without footage, no clip without a clip maker.
  layouts: Layout[];
  // A reel or an ad opens on a hook and closes on a call to action; an explainer does not have to.
  reel: boolean;
};

export type Finding = { rule: string; scene?: number; says: string };

// --- reading what a line of writing actually is -------------------------------------------------------------

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'so', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would',
  'can', 'could', 'should', 'may', 'might', 'must', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'as',
  'it', 'its', 'you', 'your', 'we', 'our', 'they', 'their', 'i', 'my', 'me', 'he', 'she', 'his', 'her', 'them', 'us',
  'what', 'when', 'where', 'who', 'how', 'why', 'which', 'there', 'here', 'about', 'into', 'over', 'just', 'like',
  'not', 'no', 'yes', 'up', 'out', 'down', 'off', 'all', 'any', 'some', 'more', 'most', 'very', 'really', 'actually']);

// Words that only ever introduce what comes after them. A headline may not end on one.
const WEAK_END = new Set(['whether', 'while', 'since', 'though', 'although', 'unless', 'until', 'because', 'after',
  'before', 'during', 'without', 'within', 'between', 'among', 'across', 'around', 'toward', 'towards', 'onto',
  'upon', 'per', 'via', 'every', 'each', 'both', 'either', 'neither', 'nor', 'one', 'two', 'three']);

const bare = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
const content = (text: string) => bare(text).filter((word) => !STOP.has(word) && word.length > 2);

// How much of one line is already in another, counted in the words that carry meaning. Two lines that share most of
// their nouns are one line said twice, whatever the grammar around them.
export function echoes(text: string, said: string): number {
  const mine = content(text);
  if (!mine.length) return 0;
  const theirs = new Set(content(said));
  return mine.filter((word) => theirs.has(word)).length / mine.length;
}

// A line cut to a headline: whole words, stopping at the last punctuation that makes a phrase rather than mid-clause.
export function trimTo(text: string, most: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= most) return text.trim();
  // A clause that already fits is a better headline than the first N words of a sentence.
  const clause = text.split(/(?<=[.!?])\s+|\s+[—–-]\s+|[,;:]\s+/)[0]?.trim() ?? '';
  if (clause && countWords(clause) <= most && countWords(clause) >= Math.min(3, most)) return clause.replace(/[,;:]$/, '');
  // The longest cut that still ends on a word that carries something: "there is a" is not a headline, and neither
  // is anything ending on a word whose whole job is to introduce what comes next.
  for (let end = most; end >= 2; end -= 1) {
    const last = words[end - 1].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (end === 2 || (!STOP.has(last) && !WEAK_END.has(last))) return words.slice(0, end).join(' ').replace(/[,;:.!?]$/, '');
  }
  return words.slice(0, most).join(' ').replace(/[,;:.!?]$/, '');
}

// The words of a line that are worth putting on a screen, in the order they were written. Used to turn a spoken
// sentence into the three words a viewer actually reads, without inventing anything that was not said.
export function keywords(said: string, most: number): string {
  const words = said.trim().split(/\s+/).filter(Boolean);
  const kept = words.filter((word) => !STOP.has(word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')) && word.replace(/[^\p{L}\p{N}]+/gu, '').length > 2);
  const picked = (kept.length >= 2 ? kept : words).slice(0, most).map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  return picked.join(' ');
}

// What a line is about, in a handful of words, for the picture drawn behind it.
export const subjectOf = (scene: Scene): string => {
  const source = [scene.text, scene.heading, ...(scene.bullets ?? []), scene.say].find((one) => one && one.trim()) ?? '';
  return keywords(source, 8) || 'an abstract product still';
};

const FIGURE_IN = /([$£€]\s?\d[\d,.]*\s*(?:%|x\b|k\b|m\b|bn\b)?|\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s*(?:%|x\b|k\b|m\b|bn\b)|\d+\s+(?:out of|of)\s+\d+|\b\d{2,}(?:\.\d+)?\b)/i;
export const hasNumber = (text?: string): boolean => FIGURE_IN.test(text ?? '');
// Pieces that could really be bullets: two words at the least, none of them opening on a word that only makes sense
// as the middle of a sentence. A "list" of sentence fragments is worse on screen than the sentence was.
const OPENERS = new Set(['which', 'that', 'who', 'whose', 'where', 'when', 'because', 'so', 'then', 'but', 'or']);
export const listable = (parts: string[]): boolean =>
  parts.length >= 2 && parts.every((one) => countWords(one) >= 2 && countWords(one) <= 6 && !OPENERS.has(one.trim().split(/\s+/)[0].toLowerCase()));

export const listy = (text?: string): boolean => ((text ?? '').match(/,/g)?.length ?? 0) >= 2 || /\b(?:first|second|third|then|finally)\b/i.test(text ?? '');
export const contrasty = (text?: string): boolean => /\b(?:but|instead of|rather than|versus|vs\.?|used to|before|after|no longer|not\s+\w+\s+but)\b/i.test(text ?? '');

// The one number a stat scene is built on, pulled out of the line that mentions it.
export const figureIn = (text?: string): string | null => {
  const found = FIGURE_IN.exec(text ?? '');
  return found ? found[1].trim().replace(/[.,]$/, '') : null;
};

// A scene that shows something rather than only saying it: a picture, a screen, a clip, or a picture drawn behind it.
export const carriesVisual = (scene: Scene): boolean =>
  VISUAL_LAYOUTS.has(scene.layout) || !!scene.bg_prompt?.trim() || !!scene.image_prompt?.trim() || !!scene.asset?.trim();

// Whose words on screen are allowed to be the words being said: a hook *is* the spoken line set large, a quote is the
// quotation, a wordmark is the name. Everywhere else, saying it and writing it is saying it twice.
const ECHO_FINE = new Set<Layout>(['hook', 'cta', 'logo', 'title', 'stat', 'quote', 'presenter']);
const NEEDS_TEXT = new Set<Layout>(['statement', 'quote', 'outro', 'hook', 'cta']);

// --- the reading --------------------------------------------------------------------------------------------

export function criticise(spec: Spec, want: Want): Finding[] {
  const found: Finding[] = [];
  const scenes = spec.scenes;
  const say = (rule: string, says: string, scene?: number) => found.push({ rule, says, scene });

  scenes.forEach((scene, index) => {
    const at = index + 1;
    if (scene.heading && countWords(scene.heading) > HEADING_WORDS && scene.layout !== 'stat') {
      say('headline', `scene ${at}'s heading is ${countWords(scene.heading)} words — a heading is a headline, ${HEADING_WORDS} words at the most`, at);
    }
    if (scene.text && countWords(scene.text) > TEXT_WORDS) {
      say('headline', `scene ${at} puts ${countWords(scene.text)} words on screen — a viewer reads ${TEXT_WORDS}, and the rest is narration written out`, at);
    }
    if (want.captions && scene.say && scene.text && !ECHO_FINE.has(scene.layout) && echoes(scene.text, scene.say) >= 0.6) {
      say('echo', `scene ${at} writes out what is already said over it and already captioned under it`, at);
    }
    const spoken = countWords(scene.say);
    const ceiling = want.pace === 'punchy' ? 4 : 6;
    if (spoken / 2.4 > ceiling) say('pace', `scene ${at} says ${spoken} words, which holds one scene for ${Math.round(spoken / 2.4)} seconds`, at);
    if ((scene.bullets?.length ?? 0) > 4) say('headline', `scene ${at} carries ${scene.bullets!.length} lines — four is what fits and what is read`, at);
  });

  if (want.reel) {
    if (scenes[0]?.layout !== 'hook') say('open', 'a reel that opens on anything but a hook is a reel nobody watches the second second of');
    const last = scenes.at(-1)?.layout;
    if (last !== 'cta' && last !== 'logo' && last !== 'outro') say('close', 'the film does not close on a call to action');
  }
  const kinds = new Set(scenes.map((one) => one.layout));
  if (want.seconds > 10 && kinds.size < 4 && scenes.length >= 4) {
    say('variety', `the whole film is ${[...kinds].join(' and ')} — ${scenes.length} scenes of the same shape is a slideshow`);
  }
  const seen = scenes.filter(carriesVisual).length;
  if (seen / Math.max(1, scenes.length) < 0.7) say('visuals', `${scenes.length - seen} of ${scenes.length} scenes have nothing to look at`);

  const budget = budgetOf(want.seconds, scenes.length, want.pace);
  const said = saidWords(spec);
  if (said > budget * 1.1) say('length', `the narration runs to ${said} words, which is about ${Math.round(said / 2.4 + scenes.length * 0.4)} seconds, not ${want.seconds}`);
  if (said && said < budget * 0.6) say('length', `the narration is only ${said} words, which leaves the film holding still`);

  // The three shapes a line of writing asks to be given, and is not.
  scenes.forEach((scene, index) => {
    if (scene.layout !== 'statement' && scene.layout !== 'outro') return;
    const line = `${scene.heading ?? ''} ${scene.text ?? ''} ${scene.say ?? ''}`;
    if (hasNumber(line)) say('shape', `scene ${index + 1} has a number in it and is set as a sentence`, index + 1);
    else if (listy(line)) say('shape', `scene ${index + 1} is a list written as a paragraph`, index + 1);
    else if (contrasty(line)) say('shape', `scene ${index + 1} is a before and an after written as one line`, index + 1);
  });
  return found;
}

// --- putting it right ---------------------------------------------------------------------------------------

// Everything above, done to the storyboard rather than said about it. Nothing here asks anybody anything, and it
// always terminates: each pass either changes a scene into a shape it is allowed to be or leaves it alone.
export function repair(spec: Spec, want: Want): { spec: Spec; notes: string[] } {
  const notes: string[] = [];
  const allowed = new Set(want.layouts);
  const can = (layout: Layout) => allowed.has(layout);
  let scenes = spec.scenes.map((one) => ({ ...one }));
  const note = (line: string) => { if (!notes.includes(line)) notes.push(line); };
  // What a scene of these words could be, given a shape to try; nothing when its own words will not carry it. Every
  // pass that changes a scene's shape goes through here, so a film never ends up with five of the same thing.
  const recast = (scene: Scene, next: Layout): Scene | null => {
    if (!can(next)) return null;
    if (next === 'picture') return { ...scene, layout: 'picture', image_prompt: scene.image_prompt || `${want.bible}. ${subjectOf(scene)}`, text: scene.text && countWords(scene.text) <= 8 ? scene.text : undefined };
    if (next === 'quote') return { ...scene, layout: 'quote', text: trimTo(scene.text || scene.say || '', 16), heading: scene.heading };
    if (next === 'hook') return { ...scene, layout: 'hook', text: trimTo(scene.text || keywords(scene.say ?? '', 5), HEADING_WORDS), heading: undefined };
    if (next === 'stat') { const figure = figureIn(scene.text) ?? figureIn(scene.say); return figure && countWords(figure) <= 3 ? { ...scene, layout: 'stat', heading: figure, text: trimTo(keywords((scene.text ?? scene.say ?? '').replace(figure, ' '), 6), 6) } : null; }
    if (next === 'compare') {
      const halves = (scene.text || scene.say || '').split(/\s+(?:but|instead of|rather than|versus|vs\.?)\s+/i);
      return halves.length >= 2 && halves[0].trim() && halves[1].trim()
        ? { ...scene, layout: 'compare', heading: scene.heading && countWords(scene.heading) <= HEADING_WORDS ? scene.heading : undefined, bullets: [trimTo(halves[0], 6), trimTo(halves[1], 6)], text: undefined } : null;
    }
    const parts = (scene.text || scene.say || '').split(/[,;]|\band\b/i).map((part) => trimTo(part.trim(), 5)).filter(Boolean).slice(0, 4);
    return listable(parts) ? { ...scene, layout: next, heading: scene.heading && countWords(scene.heading) <= HEADING_WORDS ? scene.heading : 'What you get', bullets: parts, text: undefined } : null;
  };
  // The shapes already in the film. A recast prefers one that is not in here, which is how variety happens without
  // anybody counting it afterwards.
  const kinds = new Set(scenes.map((one) => one.layout));
  const reshape = (scene: Scene, order: Layout[], onlyNew = false): Scene | null => {
    const tries = onlyNew ? order.filter((one) => !kinds.has(one)) : [...order.filter((one) => !kinds.has(one)), ...order];
    for (const next of tries) {
      const made = recast(scene, next);
      if (made) { kinds.add(next); return made; }
    }
    return null;
  };

  // 1. A reel opens on a hook and closes on a call to action. Both are recasts of a scene that is already there, so
  //    the film is never a scene longer or shorter for it.
  if (want.reel && scenes.length >= 2) {
    if (scenes[0].layout !== 'hook' && can('hook')) {
      const first = scenes[0];
      const line = first.text || first.heading || keywords(first.say ?? '', 6);
      scenes[0] = { ...first, layout: 'hook', heading: undefined, text: trimTo(line, HEADING_WORDS) || 'Watch this' };
      note('the film opened on a title card, so the first scene is a hook instead');
    }
    const last = scenes.at(-1)!;
    if (last.layout !== 'cta' && last.layout !== 'logo' && last.layout !== 'outro' && can('cta')) {
      const line = last.text || last.heading || keywords(last.say ?? '', 6);
      scenes[scenes.length - 1] = { ...last, layout: 'cta', text: trimTo(line, HEADING_WORDS) || 'Follow for more', heading: last.heading && countWords(last.heading) <= 4 ? last.heading : undefined };
      note('the film had no ending, so the last scene is a call to action');
    }
  }

  // 2a. A figure scene carries a figure. "25% Faster funding" set as one line is a ten-character string sized down to
  //     a caption; "25%" over "Faster funding" is the scene the number deserves.
  scenes = scenes.map((scene) => {
    if (scene.layout !== 'stat' || !scene.heading) return scene;
    const figure = figureIn(scene.heading);
    if (!figure || scene.heading.trim() === figure) return scene;
    const rest = scene.heading.replace(figure, ' ').replace(/\s+/g, ' ').trim();
    note('the words beside a figure are set under it, so the figure can be the size of the scene');
    return { ...scene, heading: figure, text: trimTo([rest, scene.text].filter(Boolean).join(' '), 6) || scene.text };
  });

  // 2b. A wordmark is the mark of something. A film with no product behind it closes on what to do instead.
  if (want.product === false) {
    scenes = scenes.map((scene) => {
      if (scene.layout !== 'logo') return scene;
      note('there is no product behind this film, so it closes on what to do rather than on a made-up wordmark');
      return { ...scene, layout: 'cta', text: trimTo(scene.text || scene.heading || 'Follow for more', HEADING_WORDS), heading: undefined };
    });
  }

  // 2. A number is a stat scene, a list is a checklist, a contrast is a comparison. This is the difference between a
  //    film and a set of subtitles: the shape of a scene is what a viewer reads before they read a word of it.
  scenes = scenes.map((scene) => {
    if (scene.layout !== 'statement' && scene.layout !== 'outro') return scene;
    const line = `${scene.text ?? ''} ${scene.say ?? ''}`;
    if (hasNumber(line)) { const made = recast(scene, 'stat'); if (made) { note('a scene with a number on it is set as a figure rather than a sentence'); return made; } }
    if (contrasty(line)) { const made = recast(scene, 'compare'); if (made) { note('a before and an after are set side by side rather than in one line'); return made; } }
    if (listy(line)) { const made = recast(scene, 'checklist'); if (made) { note('a list written as a paragraph is set as a list'); return made; } }
    return scene;
  });
  for (const scene of scenes) kinds.add(scene.layout);

  // 3. What is on screen is a headline, and never the narration. Captioned, a scene that writes out what is being
  //    said is three lines of the same sentence stacked on one frame, which is exactly what the founder was handed.
  scenes = scenes.map((scene) => {
    let made = { ...scene };
    if (want.captions && made.say && !ECHO_FINE.has(made.layout)) {
      const repeats = echoes(made.text ?? '', made.say) >= 0.6;
      if (repeats && made.text) {
        note('the words on screen were the words being said, so those scenes show a picture and let the captions do the talking');
        made = { ...made, text: undefined };
        // The scene still has to be something, and what it becomes is decided the same way everything else is:
        // the shape its own words will carry, preferring one this film has not used yet.
        if (NEEDS_TEXT.has(made.layout)) {
          made = reshape({ ...made, text: scene.text }, ['stat', 'compare', 'checklist', 'picture'])
            ?? { ...made, text: trimTo(keywords(scene.say ?? '', 4), 4) || 'Keep watching' };
          // Whatever shape it took, the words that were the echo do not survive into it.
          if (made.text && scene.say && !ECHO_FINE.has(made.layout) && echoes(made.text, scene.say) >= 0.6) made = { ...made, text: undefined };
        }
      }
      if (made.bullets?.length) made = { ...made, bullets: made.bullets.map((one) => trimTo(one, 5)) };
    }
    if (made.heading && countWords(made.heading) > HEADING_WORDS && made.layout !== 'stat') made = { ...made, heading: trimTo(made.heading, HEADING_WORDS) };
    if (made.text && countWords(made.text) > TEXT_WORDS) made = { ...made, text: trimTo(made.text, made.layout === 'hook' ? HEADING_WORDS : TEXT_WORDS) };
    if (made.bullets && made.bullets.length > 4) made = { ...made, bullets: made.bullets.slice(0, 4) };
    if (made.bullets) made = { ...made, bullets: made.bullets.map((one) => trimTo(one, 7)) };
    return made;
  });

  // 4. Four shapes, at least, in anything over ten seconds. A scene that is the third of its kind is given the shape
  //    its own words ask for, and failing that a picture — which is what a film does with a line it cannot draw.
  if (want.seconds > 10 && scenes.length >= 4) {
    const count = new Map<Layout, number>();
    for (const scene of scenes) count.set(scene.layout, (count.get(scene.layout) ?? 0) + 1);
    const order: Layout[] = ['stat', 'checklist', 'compare', 'steps', 'picture', 'hook'];
    scenes = scenes.map((scene, index) => {
      if (kinds.size >= 4) return scene;
      if (index === 0 || index === scenes.length - 1) return scene;
      if ((count.get(scene.layout) ?? 0) < 2) return scene;
      const made = reshape(scene, order.filter((one) => one !== scene.layout), true);
      if (!made) return scene;
      count.set(scene.layout, (count.get(scene.layout) ?? 1) - 1);
      count.set(made.layout, (count.get(made.layout) ?? 0) + 1);
      note('every scene had the same shape, so the middle of the film is cut differently');
      return made;
    });
  }

  // 5. No scene holds longer than a breath. A line too long for one scene is two scenes when there is room for one
  //    and a shorter line when there is not.
  const ceiling = want.pace === 'punchy' ? 4 : 6;
  const most = Math.floor(ceiling * 2.4);
  const split: Scene[] = [];
  const waiting = [...scenes];
  while (waiting.length) {
    const scene = waiting.shift()!;
    const spoken = countWords(scene.say);
    if (spoken <= most || !scene.say) { split.push(scene); continue; }
    const sentences = scene.say.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length >= 2 && split.length + waiting.length < MAX_SCENES - 1) {
      // Break on the sentence nearest the middle, so neither half is a fragment.
      let half = 0;
      let run = 0;
      for (const [index, sentence] of sentences.entries()) { run += countWords(sentence); if (run >= spoken / 2) { half = index + 1; break; } }
      const first = sentences.slice(0, Math.max(1, half)).join(' ');
      const rest = sentences.slice(Math.max(1, half)).join(' ');
      note('a scene that ran for half the film is cut in two');
      // Both halves go back in the queue: one cut is rarely enough for a model that wrote a paragraph.
      waiting.unshift({ ...scene, say: first }, { layout: can('picture') ? 'picture' : 'statement', say: rest, image_prompt: can('picture') ? `${want.bible}. ${subjectOf(scene)}` : undefined, text: can('picture') ? undefined : trimTo(keywords(rest, 5), 5) });
      continue;
    }
    note('a line too long to hold one scene is shortened');
    split.push({ ...scene, say: trimTo(scene.say, most) });
  }
  scenes = split.slice(0, MAX_SCENES);

  // 6. The length. A film is as long as what is said over it, so the fit is done in words, and done from the end of
  //    the longest scenes — never by cutting the opening or the close.
  const budget = budgetOf(want.seconds, scenes.length, want.pace);
  let said = scenes.reduce((sum, one) => sum + countWords(one.say), 0);
  if (said > budget * 1.1) {
    note(`the narration was ${said} words for ${want.seconds} seconds, so it is cut back to about ${budget}`);
    const order = scenes.map((one, index) => index).sort((a, b) => countWords(scenes[b].say) - countWords(scenes[a].say));
    let guard = 0;
    while (said > budget && guard < 200) {
      guard += 1;
      let moved = false;
      for (const index of order) {
        if (said <= budget) break;
        const scene = scenes[index];
        const spoken = countWords(scene.say);
        if (spoken <= 4) continue;
        const sentences = (scene.say ?? '').split(/(?<=[.!?])\s+/).filter(Boolean);
        const shorter = sentences.length > 1 ? sentences.slice(0, -1).join(' ') : trimTo(scene.say!, Math.max(4, spoken - 3));
        scenes[index] = { ...scene, say: shorter };
        said -= spoken - countWords(shorter);
        moved = true;
      }
      if (!moved) break;
    }
  }

  // 7. Everything a viewer looks at. A scene with nothing of its own gets a picture drawn behind it out of the film's
  //    own style bible, which is the whole difference between depth and a flat dark rectangle.
  scenes = scenes.map((scene) => (carriesVisual(scene) ? scene : { ...scene, bg_prompt: `${want.bible}. ${subjectOf(scene)}` }));
  if (scenes.some((scene, index) => !carriesVisual(spec.scenes[index] ?? {} as Scene) && scene.bg_prompt)) {
    note('every scene with nothing to show is given a picture of its own to sit on');
  }

  // 8. The one word in a line that is the line, for the colour pop. The director may have named it; when it did not,
  //    the number is it, and failing that the longest word that means something.
  scenes = scenes.map((scene) => {
    if (scene.emphasis || !scene.text) return scene;
    const figure = figureIn(scene.text);
    const words = scene.text.split(/\s+/).map((one) => one.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter((one) => one.length > 3 && !STOP.has(one.toLowerCase()));
    const longest = words.sort((a, b) => b.length - a.length)[0];
    const pick = figure ?? longest;
    return pick && countWords(scene.text) > 2 ? { ...scene, emphasis: pick } : scene;
  });

  return { spec: { ...spec, scenes }, notes };
}
