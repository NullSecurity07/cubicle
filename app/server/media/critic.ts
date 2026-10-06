import {
  budgetOf, content, countWords, echoes, HEADING_WORDS, MAX_SCENES, saidWords, STOP, TEXT_WORDS,
  type Layout, type Purpose, type Scene, type Spec,
} from './spec.ts';
import type { Pace } from './templates/looks.ts';
import type { Pack } from './templates/packs.ts';
import { contradictions, factLine, factsIn, factSteps } from './against-brief.ts';
import { claimsOf, figureSaid, fillerIn, flat, fromBrief, madeUpNames, preciseFigures, realLine, saysMostOf, unfill, ungrounded, type Sources } from './grounding.ts';
import { inStyle, offStyle, photographic } from './style.ts';
import { closeScene, firstHeadline, namesTheBrief, type Close } from './close.ts';
import { freshHeadlines, phraseFor, repeatsCaptions, type Phrases } from './headlines.ts';
import {
  carriesVisual, CODEY, contrasty, DATA, ECHO_FINE, EMPHASIS_WORDS, facesCamera, figureIn, hasNumber, headlineOf, keywords,
  kickerOf, listable, listy, NEEDS_TEXT, noFace, opensADoor, plainClose, shorten, stockHeading, subjectOf, trimTo, trimWhole, wholeBullet, worthAStat,
} from './wording.ts';

// What a creator says to an audience on a platform, never a film's close anywhere else.
const SIGN_OFF = /\b(?:follow (?:for more|us|me|along)|like and (?:share|subscribe)|smash (?:that|the) \w+|hit (?:the )?(?:like|follow|subscribe)|link in (?:the )?bio)\b/i;

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
  // Everything the founder wired, dropped or typed. Every specific claim in the film is checked against it.
  sources?: Sources;
  // The real screenshots of the product on the card, by name. A film that has these and draws a picture instead is
  // a film about a product nobody has seen.
  screens?: string[];
  // Pictures the film was handed, by name: drawn in a wired image studio, dropped on the stage, or given to the
  // tool outright. The founder who put them there meant them to be in the film.
  pictures?: string[];
  // Whether the brief asked for somebody on camera. A film that was asked for one and shows a photograph instead is
  // the thing a founder wrote "no talking, no body and hand movement" about.
  person?: boolean;
  // Whether the brief asked for real moving footage ("with real footage clips of the stalls"). A film that was asked
  // for clips and plans none is a slideshow nobody asked for.
  footage?: boolean;
  // The one line of visual direction every drawn picture in this film is prefixed with, so six pictures look like
  // six frames of one film rather than six stock photos.
  bible: string;
  // The layouts this film may actually use: no footage without footage, no clip without a clip maker.
  layouts: Layout[];
  // A reel or an ad opens on a hook and closes on a call to action; an explainer does not have to.
  reel: boolean;
  // The look the film wears, when it is already known, so the camera moves in its register. The storyboard's own
  // pack wins over this.
  look?: Pack;
  // The line the film closes on, decided out of the brief and the material before the storyboard (`close.ts`).
  close?: Close;
  // The founder's own phrases, the brief's first, for a headline that must not be the captions again (`headlines.ts`).
  phrases?: Phrases;
  // What the brief asked the film to end on ("end on the promise"), resolved to one of the brief's own clauses
  // (`close.ts`). It is said last, or last before the call to action.
  endOn?: string;
  // The narrator's measured words a second, when the script has been read once (`length.ts`). The budget uses it.
  rate?: number;
};

export type Finding = { rule: string; scene?: number; says: string };


// Reading what a line of writing is lives in `wording.ts`, a film's one look in `style.ts`, and the camera's own
// rules in `shot-critic.ts`. They are said again here, by the names the studio has always imported them under.
// The stop words, what one line has of another, and whether a scene writes out its own narration live in `spec.ts`,
// because the renderer needs the last of them to decide whether a scene keeps its captions.
export { echoes, saysWhatItShows } from './spec.ts';
export {
  carriesVisual, CODEY, contrasty, DATA, EMPHASIS_WORDS, endsClean, facesCamera, figureIn, hasNumber, headlineOf, keywords,
  kickerOf, listable, listy, noFace, opensADoor, plainClose, shorten, subjectOf, trimTo, worthAStat,
} from './wording.ts';
export { drawnWord, inStyle, offStyle, photographic } from './style.ts';
export { criticiseShots, mendShots } from './shot-critic.ts';

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
    // How much of the *spoken* line is already on the screen. A scene that shows what it says loses its captions
    // when it is rendered, so saying it twice is no longer the fault — the fault is the sentence. A headline the
    // voice happens to read is a scene; a paragraph of it is the narration set in type, which nobody watches.
    // Whether the screen says the line is a question about the *line*, not about how long the headline is. A real
    // reel came back with a six-word headline on every scene, each of them the whole of the sentence spoken over
    // it — under the old seven-word threshold not one of them counted, every scene silenced its own captions, and
    // the film ran fifteen seconds with a voice and no words under it at all. The hook and the close are the two
    // places a spoken line *is* the type, and they are exempt; everywhere else the captions do the talking.
    if (want.captions && scene.say && scene.text && !ECHO_FINE.has(scene.layout) && echoes(scene.say, scene.text) >= 0.6) {
      say('echo', `scene ${at} writes out what is already said over it and already captioned under it`, at);
    }
    const spoken = countWords(scene.say);
    const ceiling = want.pace === 'punchy' ? 4 : 6;
    if (spoken / 2.4 > ceiling) say('pace', `scene ${at} says ${spoken} words, which holds one scene for ${Math.round(spoken / 2.4)} seconds`, at);
    if ((scene.bullets?.length ?? 0) > 4) say('headline', `scene ${at} carries ${scene.bullets!.length} lines — four is what fits and what is read`, at);
    // A number set forty points high is a promise that it means something to the person watching.
    if (scene.layout === 'stat' && scene.heading && !worthAStat(scene.heading, `${scene.text ?? ''} ${scene.say ?? ''}`)) {
      say('stat', `scene ${at} sets "${scene.heading}" the size of the frame, and it counts the product's own parts rather than anything the viewer gets`, at);
    }
    // A path, a flag or a filename on screen is a founder reading their own terminal out to a stranger.
    const onScreen = [scene.heading, scene.text, ...(scene.bullets ?? [])].filter(Boolean).join(' ');
    if (CODEY.test(onScreen)) say('headline', `scene ${at} puts "${onScreen.match(CODEY)?.[0].trim()}" on screen, which is something a founder types rather than something a stranger reads`, at);
    // One film, one look. A scene that asks to be drawn while the rest of the film is photographed is the fault a
    // stranger sees first: a cartoon character standing in the middle of four photographs.
    const off = offStyle(`${scene.image_prompt ?? ''} ${scene.bg_prompt ?? ''}`, want.bible);
    if (off) say('style', `scene ${at} asks for a "${off}" and the rest of this film is photographed — one film, one look`, at);
  });

  if (want.reel) {
    if (scenes[0]?.layout !== 'hook') say('open', 'a reel that opens on anything but a hook is a reel nobody watches the second second of');
    const last = scenes.at(-1)?.layout;
    if (last !== 'cta' && last !== 'logo' && last !== 'outro') say('close', 'the film does not close on a call to action');
  }
  // A film over fifteen seconds whose script has a number, a list, a comparison or a process in it, and no graphic
  // anywhere, is a film reading its own bullet points out over a photograph. That is what the proof films did —
  // "a long static hold of a list over a blurred field" — and it is the difference between information and a slide.
  if (want.seconds > 15 && scenes.length >= 3 && !scenes.some((one) => DATA.has(one.layout))) {
    const script = scenes.map((one) => `${one.text ?? ''} ${one.heading ?? ''} ${(one.bullets ?? []).join(' ')} ${one.say ?? ''}`).join(' ');
    if (hasNumber(script) || listy(script) || contrasty(script)) {
      say('data', `${want.seconds} seconds with ${hasNumber(script) ? 'a number' : listy(script) ? 'a list' : 'a before and an after'} in the script and not one graphic in the film`);
    }
  }
  const kinds = new Set(scenes.map((one) => one.layout));
  if (want.seconds > 10 && kinds.size < 4 && scenes.length >= 4) {
    say('variety', `the whole film is ${[...kinds].join(' and ')} — ${scenes.length} scenes of the same shape is a slideshow`);
  }
  const seen = scenes.filter(carriesVisual).length;
  if (seen / Math.max(1, scenes.length) < 0.7) say('visuals', `${scenes.length - seen} of ${scenes.length} scenes have nothing to look at`);
  // The product itself. A drawn picture of a founder at a laptop is a stock photograph; the screenshot on the card
  // is the thing being launched, and a launch film that never shows it is a film about an idea.
  if (want.screens?.length && !scenes.some((one) => one.layout === 'device' || one.layout === 'footage')) {
    say('screens', `there ${want.screens.length === 1 ? 'is a real picture' : `are ${want.screens.length} real pictures`} of the product on the card and the film shows none of them`);
  }
  // Somebody on camera, and moving. A still of a person under a voice-over is a photograph with words over it, and
  // a founder who asked for a face said so in exactly those terms. This bites only where a moving shot can really
  // be made — where none can, a still with a camera move on it is the honest best.
  const moving = want.layouts.includes('presenter') || want.layouts.includes('clip');
  // A picture behind the words that is a face to camera: a second person the film never introduced.
  scenes.forEach((scene, index) => {
    if (scene.person || scene.layout === 'presenter' || scene.layout === 'clip') return;
    const face = facesCamera(scene.bg_prompt);
    if (face) say('faces', `scene ${index + 1} puts "${face}" behind its words, and the only person in a film is the one on camera`, index + 1);
  });
  if (want.person && moving && !scenes.some((one) => one.layout === 'presenter' || one.layout === 'clip' || one.layout === 'footage')) {
    say('person', 'the brief asks for somebody on camera and no scene has anybody moving in it');
  }
  // The pictures the film was handed. Listing them for the model to choose from was not enough: a founder who drew
  // a picture and wired it to the studio was shown a film of drawings of something else.
  const held = new Set(scenes.map((one) => one.asset).filter(Boolean));
  const unused = (want.pictures ?? []).filter((one) => !held.has(one));
  if (unused.length) {
    say('pictures', `${unused.length === 1 ? 'a picture you were given is' : `${unused.length} pictures you were given are`} not in the film — ${unused.join(', ')}`);
  }

  const budget = budgetOf(want.seconds, scenes.length, want.pace, want.rate);
  const said = saidWords(spec);
  if (said > budget * 1.1) say('length', `the narration runs to ${said} words, which is about ${Math.round(said / 2.4 + scenes.length * 0.4)} seconds, not ${want.seconds}`);
  if (said && said < budget * 0.6) say('length', `the narration is only ${said} words, which leaves the film holding still`);

  // What the film says is so. A claim that cannot be pointed at is not a style problem, it is a lie, and a founder
  // cannot publish a film that invents their own product's features.
  if (want.sources) {
    scenes.forEach((scene, index) => {
      const at = index + 1;
      const claims = claimsOf(scene);
      const filler = claims.flatMap((one) => fillerIn(one));
      if (filler.length) say('filler', `scene ${at} says "${filler[0]}", which is a word for having nothing to say`, at);
      const figures = claims.flatMap((one) => preciseFigures(one));
      for (const figure of figures) {
        if (!want.sources!.has) { say('invented', `scene ${at} claims "${figure}" and there is nothing behind this film to have measured it`, at); break; }
        if (!figureSaid(figure, want.sources!)) { say('invented', `scene ${at} claims "${figure}", which is nowhere in what you wired to the card`, at); break; }
      }
      // A name nobody wired and nobody wrote in the brief is a company the film made up — and a title card is
      // exactly where one goes, so this is asked of every scene, whatever it is.
      const named = madeUpNames(scene, want.sources!);
      if (named.length) say('invented', `scene ${at} names "${named[0]}", which is in neither your brief nor your material`, at);
      // A line that hands to a person what the brief has the product do itself ("staff reply by hand" over a product
      // that texts the caller back on its own) is the product working the wrong way, however well it reads.
      if (want.sources!.has) {
        const wrong = contradictions(scene, factsIn(want.sources!))[0];
        if (wrong) say('contradicts', `scene ${at} says "${trimTo(wrong.line, 10)}", but the brief says: "${trimTo(wrong.fact, 24)}"`, at);
      }
      // Everything else a scene states has to be in the material, or to point at the words it came from.
      if (want.sources!.has) {
        const made = ungrounded(scene, want.sources!);
        if (made) say('invented', `scene ${at} says "${trimTo(made, 8)}", which is nowhere in what you wired to the card`, at);
      }
    });
  }

  // The three shapes a line of writing asks to be given, and is not.
  scenes.forEach((scene, index) => {
    if (scene.layout !== 'statement' && scene.layout !== 'outro') return;
    const line = `${scene.heading ?? ''} ${scene.text ?? ''} ${scene.say ?? ''}`;
    if (hasNumber(line)) say('shape', `scene ${index + 1} has a number in it and is set as a sentence`, index + 1);
    else if (listy(line)) say('shape', `scene ${index + 1} is a list written as a paragraph`, index + 1);
    else if (contrasty(line)) say('shape', `scene ${index + 1} is a before and an after written as one line`, index + 1);
  });
  // A headline made of the words the captions are saying under it: the frame says one thing twice.
  scenes.forEach((scene, index) => {
    const field = repeatsCaptions(scene, want.captions);
    if (field) say('echo', `scene ${index + 1}'s ${field === 'text' ? 'headline' : 'heading'} "${scene[field]}" is the words its own captions are saying — give it a different phrase from the brief, or none`, index + 1);
  });
  // The close. The founder's own call to action is the line, as written; failing one, a close has to name something
  // the founder wrote, or it is a line that fits every product and says nothing about this one.
  const closing = scenes.at(-1);
  if (scenes.length >= 2 && closing && (closing.layout === 'cta' || closing.layout === 'outro')) {
    if (want.close?.asked && !sameLine(closing.text, want.close.line)) {
      say('close', `the film closes on "${closing.text ?? closing.say ?? ''}", and the brief's call to action is "${want.close.line}" — close on that, word for word`, scenes.length);
    } else if (!want.close?.asked && want.sources && !namesTheBrief(closing, want.sources, want.reel)) {
      say('close', `the close "${closing.text ?? closing.say ?? ''}" names nothing from the brief${want.close ? ` — close on "${want.close.line}"` : ''}`, scenes.length);
    }
  }
  return found;
}

const sameLine = (a: string | undefined, b: string): boolean =>
  (a ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// --- putting it right ---------------------------------------------------------------------------------------

// Everything above, done to the storyboard rather than said about it. Nothing here asks anybody anything, and it
// always terminates: each pass either changes a scene into a shape it is allowed to be or leaves it alone.
// The shapes a film may end on: each one is its closing line, or the product's own mark, set on the look itself.
export const CLOSES = new Set<Layout>(['cta', 'logo', 'outro', 'title']);
// Whether a scene is the film's close, which sits on the look's own ground: nothing is drawn behind it, so the last
// frame is the closing line and never a picture of something the line is not about.
export const closesOnGround = (layout: Layout, index: number, count: number): boolean => index === count - 1 && CLOSES.has(layout);

export function repair(spec: Spec, want: Want): { spec: Spec; notes: string[] } {
  const notes: string[] = [];
  const allowed = new Set(want.layouts);
  const can = (layout: Layout) => allowed.has(layout);
  let scenes = spec.scenes.map((one) => ({ ...one }));
  const note = (line: string) => { if (!notes.includes(line)) notes.push(line); };
  // What a scene of these words could be, given a shape to try; nothing when its own words will not carry it. Every
  // pass that changes a scene's shape goes through here, so a film never ends up with five of the same thing.
  const headed = new Set(scenes.flatMap((one) => [one.text, one.heading]).filter((one): one is string => !!one).map((one) => one.toLowerCase()));
  const listHeading = (scene: Scene): string | undefined => {
    const own = scene.heading?.trim();
    if (own && countWords(own) <= HEADING_WORDS && !stockHeading(own)) return own;
    const fresh = phraseFor(scene.say ?? scene.text ?? '', want.phrases ?? { brief: [], lines: [] }, headed);
    if (fresh) headed.add(fresh.toLowerCase());
    return fresh ?? undefined;
  };
  const recast = (scene: Scene, next: Layout): Scene | null => {
    if (!can(next)) return null;
    if (next === 'picture') return { ...scene, layout: 'picture', image_prompt: scene.image_prompt || `${want.bible}. ${subjectOf(scene)}`, text: scene.text && countWords(scene.text) <= 8 ? scene.text : undefined };
    if (next === 'quote') return { ...scene, layout: 'quote', text: trimTo(scene.text || scene.say || '', 16), heading: scene.heading };
    if (next === 'hook') return { ...scene, layout: 'hook', text: scene.text ? trimTo(scene.text, HEADING_WORDS) : headlineOf(scene.say ?? '', HEADING_WORDS), heading: undefined };
    if (next === 'stat') {
      const figure = figureIn(scene.text) ?? figureIn(scene.say);
      // A number only becomes the size of the frame when it is a number the viewer gets something from.
      if (!figure || countWords(figure) > 3 || !worthAStat(figure, `${scene.text ?? ''} ${scene.say ?? ''}`)) return null;
      return { ...scene, layout: 'stat', heading: figure, text: headlineOf((scene.text ?? scene.say ?? '').replace(figure, ' '), 6) };
    }
    if (next === 'compare') {
      const halves = (scene.text || scene.say || '').split(/\s+(?:but|instead of|rather than|versus|vs\.?)\s+/i);
      return halves.length >= 2 && halves[0].trim() && halves[1].trim()
        ? { ...scene, layout: 'compare', heading: scene.heading && countWords(scene.heading) <= HEADING_WORDS ? scene.heading : undefined, bullets: [trimTo(halves[0], 6), trimTo(halves[1], 6)], text: undefined } : null;
    }
    if (next === 'chart') {
      // A chart is only a chart where there are numbers to draw. Two bars at the least, each one a label and a
      // figure, out of whatever the scene already says.
      // The line with the numbers in it, which is usually the spoken one: a headline is a headline precisely
      // because the figures have been taken out of it.
      const counted = [scene.say, scene.text].find((one) => figureIn(one ?? '')) ?? scene.text ?? scene.say ?? '';
      const bars = counted.split(/[,;]|\band\b/i).map((part) => part.trim())
        .filter((part) => figureIn(part) && content(part).length >= 1).map((part) => trimTo(part, 5)).slice(0, 4);
      return bars.length >= 2 && bars.every((one) => figureIn(one))
        ? { ...scene, layout: 'chart', heading: scene.heading && countWords(scene.heading) <= HEADING_WORDS ? scene.heading : undefined, bullets: bars, text: undefined }
        : null;
    }
    const parts = (scene.text || scene.say || '').split(/[,;]|\band\b/i).map((part) => trimTo(part.trim(), 5)).filter(Boolean).slice(0, 4);
    // A list's heading is its own or the brief's (`listHeading`), never one out of a table that fits every film.
    return listable(parts) ? { ...scene, layout: next, heading: listHeading(scene), bullets: parts, text: undefined } : null;
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

  // 1a. A reel opens on a hook and closes on a call to action. Both are recasts of a scene that is already there, so
  //     the film is never a scene longer or shorter for it.
  if (want.reel && scenes.length >= 2) {
    if (scenes[0].layout !== 'hook' && can('hook')) {
      const first = scenes[0];
      const line = first.text || first.heading || first.say || '';
      scenes[0] = { ...first, layout: 'hook', heading: undefined, text: trimTo(line, HEADING_WORDS) || 'Watch this' };
      note('the film opened on a title card, so the first scene is a hook instead');
    }
  }
  // …and every film, reel or not, ends on a scene whose shape carries its closing line. A picture or a paragraph as
  // the last thing on screen leaves the film to end on whatever was drawn for it — the site's own hero film ended on
  // an empty warehouse under its last line. The close is the line set as a close, on the look's own ground.
  if (scenes.length >= 2) {
    const last = scenes.at(-1)!;
    if (!CLOSES.has(last.layout) && can('cta')) {
      const line = last.text || last.heading || last.say || '';
      scenes[scenes.length - 1] = {
        ...last, layout: 'cta', text: trimTo(line, HEADING_WORDS) || want.close?.line || firstHeadline(scenes) || (want.reel ? 'Follow for more' : 'Watch it again'),
        heading: last.heading && countWords(last.heading) <= 4 ? last.heading : undefined,
        image_prompt: undefined, bullets: undefined,
      };
      note('the film had no ending, so the last scene is its closing line, set as a close');
    }
  }

  // 1b. The truth, before any of the shape is decided: a scene built on a claim nobody can point at is cut, and a scene
  //    that is only a little wrong is put right with the founder's own words. Nothing invented is dressed up.
  if (want.sources) {
    const sources = want.sources;
    const used = new Set<string>();
    const keep: Scene[] = [];
    let dropped = 0;
    for (const scene of scenes) {
      let made = { ...scene };
      // A line that says the product works the way the brief says it does not is put right with the brief's own fact:
      // the line said becomes the fact, a headline that says it goes, and a list keeps only its true steps or becomes
      // the fact's own steps.
      const wrong = sources.has ? contradictions(made, factsIn(sources)) : [];
      if (wrong.length) {
        const bad = new Set(wrong.map((one) => one.line));
        const fact = wrong[0].fact;
        const kept = made.bullets?.filter((one) => !bad.has(one));
        made = {
          ...made,
          say: made.say && bad.has(made.say) ? factLine(fact, factsIn(sources)) : made.say,
          text: made.text && bad.has(made.text) ? undefined : made.text,
          heading: made.heading && bad.has(made.heading) ? undefined : made.heading,
          bullets: made.bullets && kept && kept.length < made.bullets.length ? (kept.length >= 2 ? kept : factSteps(fact, factsIn(sources))) : made.bullets,
          source: made.say && bad.has(made.say) ? trimTo(fact, 12) : made.source,
        };
        note('a line said the product works the way the brief says it does not, so it says what the brief says');
      }
      // Filler first: it is never true and it never has to be, so it simply goes.
      for (const key of ['heading', 'text', 'say'] as const) {
        const said = made[key];
        if (said && fillerIn(said).length) {
          const clean = unfill(said);
          made = { ...made, [key]: countWords(clean) >= 2 ? clean : undefined } as Scene;
          note('the words that only sound like something were taken out');
        }
      }
      if (made.bullets?.some((one) => fillerIn(one).length)) {
        made = { ...made, bullets: made.bullets.map(unfill).filter((one) => countWords(one) >= 1) };
        note('the words that only sound like something were taken out');
      }
      const claims = claimsOf(made);
      const figures = claims.flatMap((one) => preciseFigures(one));
      const unsourced = figures.filter((one) => !sources.has || !figureSaid(one, sources));
      const pointless = ungrounded(made, sources);
      const invented = madeUpNames(made, sources);

      if (!unsourced.length && !pointless && !invented.length) { keep.push(made); continue; }
      // A figure nobody measured cannot be a figure scene, and cannot sit in a line either.
      if (unsourced.length) {
        note(sources.has
          ? `${unsourced.length === 1 ? 'a number' : `${unsourced.length} numbers`} nobody in your material measured ${unsourced.length === 1 ? 'was' : 'were'} taken out`
          : 'there is nothing behind this film to measure, so the numbers in it were taken out');
        if (made.layout === 'stat') made = recast(made, 'statement') ?? { ...made, layout: 'statement', text: made.text || headlineOf(made.say ?? '', HEADING_WORDS) || undefined, heading: undefined };
        for (const key of ['heading', 'text', 'say'] as const) {
          const said = made[key];
          if (!said) continue;
          const clean = unsourced.reduce((line, figure) => line.replace(figure, ''), said).replace(/\s{2,}/g, ' ').replace(/\s+([,.!?%])/g, '$1').trim();
          made = { ...made, [key]: countWords(clean) >= 2 ? clean : undefined } as Scene;
        }
        made = { ...made, bullets: made.bullets?.map((one) => unsourced.reduce((line, figure) => line.replace(figure, ''), one).trim()).filter((one) => countWords(one) >= 1) };
      }
      // A company the film made up is struck out of every line it appears in; there is nothing to put in its place,
      // because there was never anything there.
      if (invented.length) {
        note(`"${invented[0]}" is in neither your brief nor your material, so ${invented.length === 1 ? 'that name was' : `those ${invented.length} names were`} taken out`);
        const strike = (line: string) => invented.reduce((said, one) => said.replace(new RegExp(`\\b${one}\\b`, 'g'), ''), line).replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
        for (const key of ['heading', 'text', 'say'] as const) {
          const said = made[key];
          if (!said) continue;
          const clean = strike(said);
          made = { ...made, [key]: countWords(clean) >= 2 ? clean : undefined } as Scene;
        }
        made = { ...made, bullets: made.bullets?.map(strike).filter((one) => countWords(one) >= 1) };
      }
      if (pointless) {
        // A close is not a claim to be replaced with another claim: it asks somebody to do something. Where the
        // material names no place to go, the film closes on something plain and true instead of a button to a
        // website nobody has built.
        if (made.layout === 'cta' || made.layout === 'outro') {
          // What it closes on instead is the founder's own line (`close.ts`): their call to action, their positioning,
          // or the film's first headline said again. A line that fits every product is the last resort.
          const plain = want.close?.line ?? firstHeadline(keep.length ? keep : scenes);
          note(plain
            ? `there is no address or command behind that close, so the film closes on "${plain}" instead`
            : 'there is no address or command in your material, so the film closes on something plain rather than a made-up one');
          keep.push(plain ? closeScene(made, plain) : { ...made, text: want.reel ? 'Follow for more' : 'Watch it again', heading: undefined, say: want.reel ? 'Follow for more.' : 'Watch it again.', source: undefined });
          continue;
        }
        // The founder's own line is never swapped out: one written in the brief, or most of it a sentence of the brief
        // said again, or the line the brief asked the film to end on. The hero film lost its promise right here.
        const said = made.say ?? pointless;
        if (fromBrief(pointless, sources) || (want.endOn && saysMostOf(said, want.endOn))) { keep.push(made); continue; }
        // Nothing points at this. Either the founder's own words about the same thing go in its place, or the scene goes.
        const real = sources.has ? realLine(sources, used, { line: `${pointless} ${made.say ?? ''}`, source: made.source }) : null;
        if (real) {
          note(`"${trimTo(pointless, 6)}" is nowhere in your material, so that scene says your own words instead`);
          keep.push({ ...made, text: headlineOf(real, TEXT_WORDS), say: real, heading: undefined, bullets: undefined, source: real, layout: made.layout === 'stat' ? 'statement' : made.layout });
          continue;
        }
        if (keep.length + 1 < scenes.length && scenes.length - dropped > 3) {
          dropped += 1;
          note(`I could not find "${trimTo(pointless, 6)}" in your material, so ${dropped === 1 ? 'that claim was' : `those ${dropped} claims were`} dropped`);
          continue;
        }
        // A film too short to lose the scene still may not keep the claim: the last resort is a sentence of the
        // material that is not about the same thing, which is true at least.
        const any = sources.has ? realLine(sources, used) : null;
        if (any) {
          note(`"${trimTo(pointless, 6)}" is nowhere in your material, so that scene says your own words instead`);
          keep.push({ ...made, text: headlineOf(any, TEXT_WORDS), say: any, heading: undefined, bullets: undefined, source: any, layout: made.layout === 'stat' ? 'statement' : made.layout });
          continue;
        }
      }
      if (!claimsOf(made).length) { dropped += 1; continue; }
      keep.push(made);
    }
    scenes = keep.length >= 2 ? keep : scenes;
  }

  // 1c. The words a viewer actually reads. A number that counts the product's own parts is not a headline the size
  //     of the frame, and a file path is not a headline at all.
  scenes = scenes.map((scene) => {
    let made = scene;
    if (made.layout === 'stat' && made.heading && !worthAStat(made.heading, `${made.text ?? ''} ${made.say ?? ''}`)) {
      note(`"${made.heading}" counts this product's own parts rather than anything the viewer gets, so it is said rather than set the size of the frame`);
      const line = [made.heading, made.text].filter(Boolean).join(' ');
      made = recast({ ...made, text: line, heading: undefined }, 'statement')
        ?? { ...made, layout: 'statement', heading: undefined, text: headlineOf(line, TEXT_WORDS) || undefined };
    }
    const shown = [made.heading, made.text, ...(made.bullets ?? [])].filter(Boolean).join(' ');
    if (CODEY.test(shown)) {
      note('a file path is something you type, not something a stranger reads off a screen, so it came off');
      const clean = (line?: string) => (line && CODEY.test(line) ? undefined : line);
      made = {
        ...made,
        heading: clean(made.heading),
        text: clean(made.text) ?? (headlineOf(made.say ?? '', TEXT_WORDS) || undefined),
        bullets: made.bullets?.filter((one) => !CODEY.test(one)),
      };
    }
    return made;
  });

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

  // 2b5. A picture behind the words is of the thing being talked about, not of somebody looking down the lens. The
  //      film's own person is on camera; anybody else is a stranger the film never introduced.
  scenes = scenes.map((scene) => {
    if (scene.person || scene.layout === 'presenter' || scene.layout === 'clip' || !scene.bg_prompt) return scene;
    const face = facesCamera(scene.bg_prompt);
    if (!face) return scene;
    note('a picture behind the words was of somebody looking at the camera, so it is of what the scene is about instead');
    const left = noFace(scene.bg_prompt);
    return { ...scene, bg_prompt: countWords(left) >= 3 ? left : `${want.bible}. ${subjectOf(scene)}` };
  });

  // 2b4. A close that asks for something nobody offered. Where the film has material it answers for itself; where
  //      it has none, a door has to be named in the brief or it is not there to be opened.
  if (!want.sources?.has) {
    scenes = scenes.map((scene) => {
      if (scene.layout !== 'cta' && scene.layout !== 'outro') return scene;
      const door = opensADoor(`${scene.text ?? ''} ${scene.heading ?? ''} ${scene.say ?? ''}`);
      if (!door || (want.sources?.brief ?? '').includes(door.toLowerCase())) return scene;
      note(`nothing here offers a ${door.toLowerCase()}, so the film closes on something it can stand behind instead`);
      const close = plainClose(want.purpose);
      return { ...scene, text: close.text, say: close.say, heading: undefined };
    });
  }

  // 2b4b. A platform's sign-off belongs to a social post. "Follow for more" closed a pottery documentary nobody was
  //       going to post from an account, so on anything but a reel or an advert it is a plain close instead.
  if (!want.reel) {
    scenes = scenes.map((scene) => {
      if (!SIGN_OFF.test(`${scene.text ?? ''} ${scene.heading ?? ''} ${scene.say ?? ''}`)) return scene;
      note('a sign-off for followers is for a social post, so this film closes on something plain instead');
      const close = plainClose(want.purpose);
      return { ...scene, text: close.text, say: close.say, heading: undefined };
    });
  }

  // 2b. A wordmark is the mark of something. A film with no product behind it closes on what to do instead.
  if (want.product === false) {
    scenes = scenes.map((scene) => {
      if (scene.layout !== 'logo') return scene;
      note('there is no product behind this film, so it closes on what to do rather than on a made-up wordmark');
      return { ...scene, layout: 'cta', text: trimTo(scene.text || scene.heading || (want.reel ? 'Follow for more' : plainClose(want.purpose).text), HEADING_WORDS), heading: undefined };
    });
  }

  // 2b2. The pictures the film was handed, put in it. A scene that was going to be a drawing holds a real picture
  //      instead, because a real one is what the founder made and wired up.
  if (want.pictures?.length && can('picture')) {
    const held = new Set(scenes.map((one) => one.asset).filter(Boolean));
    for (const name of want.pictures) {
      if (held.has(name)) continue;
      const at = scenes.findIndex((one) => !one.asset && (one.layout === 'picture' || one.layout === 'statement' || one.layout === 'hook'));
      if (at < 0) break;
      note('a picture you were given is in the film, rather than a drawing of something like it');
      scenes = scenes.map((one, index) => (index === at
        ? { ...one, layout: 'picture' as Layout, asset: name, image_prompt: undefined, bg_prompt: undefined }
        : one));
      held.add(name);
    }
  }

  // 2b3. Somebody on camera, moving. Where the brief asked for a face and a moving shot can be made, one scene is
  //      a person rather than a picture of one — which is the difference between a film and a photograph with a
  //      voice over it.
  const canMove = want.layouts.includes('presenter') ? 'presenter' as Layout : want.layouts.includes('clip') ? 'clip' as Layout : null;
  if (want.person && canMove && !scenes.some((one) => one.layout === 'presenter' || one.layout === 'clip' || one.layout === 'footage')) {
    // The opening, wherever it can hold somebody: a reel that wants a person is a reel where the person says the
    // hook. A film that produced its presenter in scene three had a person in it the way a leaflet has a
    // photograph in it. Only a wordmark or a close is left alone.
    const holds = (one: Scene) => one.layout !== 'logo' && one.layout !== 'title' && one.layout !== 'cta';
    const at = holds(scenes[0]) ? 0 : scenes.findIndex((one, index) => index < Math.max(1, scenes.length - 1) && holds(one) && one.say?.trim());
    if (at >= 0) {
      note('the brief asks for somebody on camera, so one scene is a person moving rather than a picture of one');
      scenes = scenes.map((one, index) => (index === at
        ? { ...one, layout: canMove, ...(canMove === 'presenter' ? { portrait_prompt: one.portrait_prompt ?? `${want.bible}. somebody talking to camera` } : { clip_prompt: one.clip_prompt ?? `${want.bible}. somebody talking to camera` }) }
        : one));
    }
  }

  // 2b4. Footage, where footage was asked for. The director is told it may use one clip and often uses none; a brief
  //      that says "real footage clips" gets one, in the middle of the film, of what that scene's picture was of.
  if (want.footage && can('clip') && !scenes.some((one) => one.layout === 'clip' || one.layout === 'footage' || one.layout === 'presenter')) {
    const moving = (one: Scene) => one.layout === 'picture' && !one.asset && !one.person;
    const middle = scenes.findIndex((one, index) => index > 0 && index < scenes.length - 1 && moving(one));
    const at = middle >= 0 ? middle : scenes.findIndex(moving);
    if (at >= 0) {
      note('the brief asks for real footage, so one scene is a moving clip rather than a still');
      scenes = scenes.map((one, index) => (index === at
        ? { ...one, layout: 'clip' as Layout, clip_prompt: (one.clip_prompt ?? one.image_prompt ?? one.text ?? one.say ?? '').slice(0, 240), seconds: Math.min(5, Math.max(3, one.seconds ?? 4)) }
        : one));
    }
  }

  // 2c. The product, shown. Where there are real screenshots on the card and not one scene holds one, the scene that
  //     was going to be a drawing holds a screenshot instead — that being the picture the founder actually has.
  if (want.screens?.length && can('device') && !scenes.some((one) => one.layout === 'device' || one.layout === 'footage')) {
    const middle = scenes.findIndex((one, index) => index > 0 && index < scenes.length - 1 && (one.layout === 'picture' || one.layout === 'statement'));
    const where = middle >= 0 ? middle : scenes.findIndex((one) => one.layout === 'picture' || one.layout === 'statement');
    if (where >= 0) {
      note('the project had real pictures of the product in it, so one scene shows the product rather than a drawing of it');
      scenes = scenes.map((one, index) => (index === where
        ? { ...one, layout: 'device' as Layout, asset: want.screens![0], frame: one.frame ?? 'browser', image_prompt: undefined, heading: undefined, text: one.text || trimTo(one.heading ?? '', HEADING_WORDS) || undefined }
        : one));
    }
  }

  // 1d. One graphic in a film that has something to measure. The scene in the middle whose own words will carry a
  //     figure, a list or a comparison becomes one, in that order of preference: a chart where there are numbers
  //     to draw, a figure where there is one, a comparison where there is a turn, a list where there is a list.
  if (want.seconds > 15 && scenes.length >= 3 && !scenes.some((one) => DATA.has(one.layout))) {
    const script = scenes.map((one) => `${one.text ?? ''} ${one.heading ?? ''} ${one.say ?? ''}`).join(' ');
    if (hasNumber(script) || listy(script) || contrasty(script)) {
      const order: Layout[] = ['chart', 'stat', 'compare', 'checklist', 'steps'];
      for (let index = 1; index < scenes.length - 1; index += 1) {
        const made = reshape(scenes[index], order);
        if (!made) continue;
        note('the film had something to measure and no graphic in it, so one scene is drawn rather than written');
        scenes[index] = made;
        break;
      }
    }
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
      const repeats = made.text && echoes(made.say, made.text) >= 0.6;
      if (repeats && made.text) {
        // First try: a headline out of the line's own opening, in English — the clause it begins on, where it has
        // one. That is emphasis and not a transcript, and it keeps something on screen: a film of nothing but
        // photographs and subtitles is the other way of getting this wrong. Failing that, the words it turns on.
        const opening = headlineOf(made.say, HEADING_WORDS);
        const kicker = opening && echoes(made.say, opening) < 0.6 ? opening : kickerOf(made.say, EMPHASIS_WORDS);
        // A few words *of* the line is emphasis; a few words that are still most of the line is the same fault in
        // fewer characters, and a repair that leaves what it was called to fix is worse than none.
        if (countWords(kicker) >= 2 && echoes(made.say, kicker) < 0.6 && !ECHO_FINE.has(made.layout) && made.layout !== 'picture') {
          note('a sentence set on screen is cut to the words it turns on, and the captions say the rest');
          made = { ...made, text: kicker, emphasis: undefined };
          if (made.bullets?.length) made = { ...made, bullets: made.bullets.map((one) => trimTo(one, 5)) };
          return made;
        }
        note('the words on screen were the words being said, so those scenes show a picture and let the captions do the talking');
        made = { ...made, text: undefined };
        // The scene still has to be something, and what it becomes is decided the same way everything else is:
        // the shape its own words will carry, preferring one this film has not used yet.
        if (NEEDS_TEXT.has(made.layout)) {
          made = reshape({ ...made, text: scene.text }, ['stat', 'compare', 'checklist', 'picture'])
            ?? { ...made, text: trimTo(keywords(scene.say ?? '', 4), 4) || 'Keep watching' };
          // Whatever shape it took, the words that were the echo do not survive into it.
          if (made.text && scene.say && !ECHO_FINE.has(made.layout) && echoes(scene.say, made.text) >= 0.6) made = { ...made, text: undefined };
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

  // 4b. Nothing is said twice. Journey 13: the director, asked for one more line to fill twenty seconds, wrote the
  //     film's closing line again, and "Taste the difference real dirt and sunshine make" was heard in scenes three
  //     and five. The second saying goes; when it is the close, the earlier one goes instead, so the film still ends
  //     on it. A scene that shows something real (a screenshot, a picture, a clip) stays on screen without the
  //     line; one that only said it is dropped.
  const shows = (scene: Scene) => !!(scene.asset || scene.image_prompt || scene.clip_prompt || scene.portrait_prompt) || scene.layout === 'device' || scene.layout === 'footage';
  const sayOnce = () => {
    for (let later = 1; later < scenes.length && scenes.length > 2; later += 1) {
      const said = scenes[later].say?.trim();
      if (!said) continue;
      const earlier = scenes.findIndex((one, index) => index < later && !!one.say?.trim() && saidAgain(one.say!, said));
      if (earlier < 0) continue;
      const quiet = later === scenes.length - 1 ? earlier : later;
      note('a line the film already said was said again, so it is said once');
      if (shows(scenes[quiet])) scenes = scenes.map((one, index) => (index === quiet ? { ...one, say: undefined, source: undefined } : one));
      else { scenes = scenes.filter((_one, index) => index !== quiet); later -= 1; }
    }
  };
  sayOnce();

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
      waiting.unshift({ ...scene, say: first }, { layout: can('picture') ? 'picture' : 'statement', say: rest, image_prompt: can('picture') ? `${want.bible}. ${subjectOf(scene)}` : undefined, text: can('picture') ? undefined : headlineOf(rest, 5) });
      continue;
    }
    note('a line too long to hold one scene is shortened');
    split.push({ ...scene, say: shorten(scene.say, most) });
  }
  scenes = split.slice(0, MAX_SCENES);

  // 6. The length. A film is as long as what is said over it, so the fit is done in words, and done from the end of
  //    the longest scenes — never by cutting the opening or the close.
  const budget = budgetOf(want.seconds, scenes.length, want.pace, want.rate);
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
        // Whole sentences and clauses only: a line cut word by word loses what it was saying (`trimWhole`).
        const shorter = trimWhole(scene.say!, Math.max(4, spoken - 3));
        if (countWords(shorter) >= spoken) continue;
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

  // 7b. The look, held to one. Whatever the pictures ended up asking for — the model's own words, or a subject that
  //     came out of a line about a cartoon — every prompt is put back into the medium the film is shot in. A film
  //     that is drawn by hand is left alone: there the drawn words are the look.
  if (photographic(want.bible)) {
    let wandered = false;
    scenes = scenes.map((scene) => {
      const image = scene.image_prompt ? inStyle(scene.image_prompt, want.bible) : scene.image_prompt;
      const bg = scene.bg_prompt ? inStyle(scene.bg_prompt, want.bible) : scene.bg_prompt;
      if (image === scene.image_prompt && bg === scene.bg_prompt) return scene;
      wandered = true;
      return { ...scene, image_prompt: image, bg_prompt: bg };
    });
    if (wandered) note('a scene asked to be drawn rather than photographed, so it is shot the way the rest of the film is');
  }

  // 7c. Emoji. One in a film at the very most, on the scene that closes it — a reel with a chart, a map and a
  //     rocket scattered down it reads as clip art, and a picture of a chart is the one thing the pictures in
  //     this film are forbidden from containing.
  {
    const carries = scenes.map((one, index) => (one.icon?.trim() ? index : -1)).filter((one) => one >= 0);
    if (carries.length) {
      const keep = carries.at(-1);
      if (carries.length > 1) note('a film carries one emoji at the most, so the rest came off');
      scenes = scenes.map((one, index) => (one.icon && index !== keep ? { ...one, icon: undefined } : one));
    }
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

  // 9. The last word on the one rule every pass above can quietly undo. Recasting a scene puts words back on it,
  //    and a scene that ends up saying on screen exactly what is said over it silences its own captions — which,
  //    on a whole film, is a voice with nothing under it. Nothing leaves here still doing that.
  if (want.captions) {
    scenes = scenes.map((scene) => (scene.text && scene.say && !ECHO_FINE.has(scene.layout) && echoes(scene.say, scene.text) >= 0.6
      ? { ...scene, text: undefined, emphasis: undefined }
      : scene));
  }

  // 10. A headline is never the captions again: one made of the words being said under it is given another phrase of
  //     the founder's, or taken off so the captions carry the line (`headlines.ts`).
  {
    const fresh = freshHeadlines(scenes, want.captions, want.phrases ?? { brief: [], lines: [] });
    scenes = fresh.scenes;
    for (const line of fresh.notes) note(line);
  }

  // 11. The close is the founder's line. Their call to action, word for word, whenever they named one; otherwise a
  //     close that names nothing they wrote becomes their positioning line, or the film's first headline again.
  const closing = scenes.at(-1);
  if (scenes.length >= 2 && closing && (closing.layout === 'cta' || closing.layout === 'outro')) {
    const asked = want.close?.asked ? want.close.line : undefined;
    // The film's own title is its first headline when no scene is left with one.
    const title = spec.title && countWords(spec.title) <= HEADING_WORDS ? spec.title.trim() : undefined;
    const plain = !asked && want.sources && !namesTheBrief(closing, want.sources, want.reel) ? (want.close?.line ?? firstHeadline(scenes) ?? title) : undefined;
    // The founder's call to action is the whole close: no heading of the model's own ("Get started today") beside it.
    const line = asked && (!sameLine(closing.text, asked) || !!closing.heading) ? asked : plain;
    if (line) {
      note(asked ? `the film closes on your call to action, "${line}"` : `the close named nothing from your brief, so it closes on "${line}"`);
      scenes = [...scenes.slice(0, -1), closeScene(closing, line)];
    }
  }

  // 12. A list is a list of something. A checklist, steps, bullets or a comparison that has lost its lines along the
  //     way renders as an empty frame — the hero film had two — so it is its headline set as a statement, or a
  //     picture when it has none.
  scenes = scenes.map((scene) => {
    if (!LISTS.has(scene.layout) || (scene.bullets?.filter((one) => one.trim()).length ?? 0) >= 2) return scene;
    note('a list with nothing left in it is set as its headline instead');
    const line = scene.text?.trim() || scene.heading?.trim();
    if (line) return { ...scene, layout: 'statement' as Layout, text: line, heading: undefined, bullets: undefined };
    return can('picture')
      ? { ...scene, layout: 'picture' as Layout, heading: undefined, bullets: undefined, image_prompt: scene.image_prompt ?? scene.bg_prompt ?? `${want.bible}. ${subjectOf(scene)}` }
      : { ...scene, layout: 'statement' as Layout, text: headlineOf(scene.say ?? '', HEADING_WORDS) || undefined, bullets: undefined };
  });

  // 12b. A list's lines are things, and its heading is somebody's. A line that is the tail of the spoken sentence
  //      ("right here.") is not a list line; a list with one of those in it is its words set plainly, as a
  //      statement. A heading out of the stock table is the brief's phrase about the line instead, or none.
  scenes = scenes.map((scene) => {
    if (scene.layout !== 'checklist' && scene.layout !== 'bullets' && scene.layout !== 'steps') return scene;
    const kind = scene.layout === 'steps' ? 'step' : 'thing';
    const lines = (scene.bullets ?? []).filter((one) => one.trim()).map((one) => wholeBullet(one, kind));
    if (lines.some((one) => !one)) {
      note('a list line that was only the end of a sentence is set as plain words instead');
      const heading = scene.heading?.trim() && !stockHeading(scene.heading) ? scene.heading.trim() : undefined;
      return { ...scene, layout: 'statement' as Layout, text: heading ?? (headlineOf(scene.say ?? '', HEADING_WORDS) || undefined), heading: undefined, bullets: undefined };
    }
    const heading = stockHeading(scene.heading) ? listHeading({ ...scene, heading: undefined }) : scene.heading;
    if (heading !== scene.heading) note(`the list heading "${scene.heading}" fits any film, so it ${heading ? `says "${heading}", from your brief,` : 'is left off'} instead`);
    return { ...scene, bullets: lines as string[], heading };
  });

  // 13. A film ends on its close, and the close is said. The site's hero film ended on a picture with nothing said
  //     over it: a wordmark, a title card or a close with no line is the film stopping rather than ending. Whatever
  //     is last becomes the close (`close.ts`), with the founder's line when they gave one and its own words when not.
  if (scenes.length >= 2) {
    const closing = scenes.at(-1)!;
    if ((closing.layout !== 'cta' && closing.layout !== 'outro') || !closing.say?.trim()) {
      const title = spec.title && countWords(spec.title) <= HEADING_WORDS ? spec.title.trim() : undefined;
      const own = [closing.text, closing.heading].map((one) => one?.trim()).find((one) => !!one && countWords(one) >= 2 && countWords(one) <= HEADING_WORDS);
      const line = ((want.close?.asked ? want.close.line : undefined) ?? own ?? want.close?.line ?? firstHeadline(scenes) ?? title)?.replace(/[.!\s]+$/, '');
      if (line) {
        note(`the film ended on a scene with nothing to say, so it closes on "${line}", said aloud`);
        scenes = [...scenes.slice(0, -1), closeScene(closing, line)];
      }
    }
  }

  // 13b. …and nothing beside it the founder did not write. A close sets its heading as a button next to the line, and
  //      the hero film's first run showed "Get started today" there: a door the model made up, beside the founder's
  //      own. A heading on a close stays only when it is the founder's words as written, in the brief or the material.
  {
    const closing = scenes.at(-1);
    const heading = closing?.heading?.trim();
    // With nothing wired and no brief to hold it to there is nothing to check it against, and a reel's handle beside
    // "Follow for more" is the account the film is posted from.
    if (scenes.length >= 2 && closing && heading && want.sources && !heading.startsWith('@') && (closing.layout === 'cta' || closing.layout === 'outro')) {
      const theirs = !!want.sources && flat(heading).length >= 3
        && [want.sources.brief, want.sources.corpus].some((body) => ` ${body} `.includes(` ${flat(heading).replace(/[.]+$/, '')} `));
      if (!theirs) {
        note(`"${heading}" beside the close was not yours, so the close is its line alone`);
        scenes = [...scenes.slice(0, -1), { ...closing, heading: undefined, ...(closing.text ? {} : { text: closing.say?.replace(/[.!\s]+$/, '') }) }];
      }
    }
  }

  // 14. "End on the promise." The line the brief asked the film to end on is the last thing said: the close itself
  //     when there is no call to action, and the scene just before the close when there is. A scene that already
  //     says it is moved there; with none, the founder's own sentence for it is added, from the material when a
  //     sentence there says it, else from the brief as written.
  if (want.endOn && scenes.length >= 2 && (!want.close?.asked || !sameLine(want.close.line, want.endOn))) {
    const pin = want.endOn;
    const at = scenes.length - 2;
    const says = (scene: Scene) => saysMostOf(scene.say ?? scene.text ?? '', pin);
    if (!says(scenes[at])) {
      let found = -1;
      for (let index = at - 1; index >= 1; index -= 1) if (says(scenes[index])) { found = index; break; }
      if (found > 0) {
        const moved = scenes[found];
        scenes = [...scenes.slice(0, found), ...scenes.slice(found + 1, -1), moved, scenes.at(-1)!];
        note(`the brief asked to end on "${pin}", so that scene is now the last before the close`);
      } else {
        const said = want.sources?.lines.find((line) => saysMostOf(line, pin)) ?? `${pin}.`;
        const text = countWords(said) <= HEADING_WORDS ? said.replace(/[.!\s]+$/, '') : headlineOf(said, HEADING_WORDS);
        scenes = [...scenes.slice(0, -1), { layout: 'statement', text, say: said, source: said }, scenes.at(-1)!];
        note(`the brief asked to end on "${pin}", so the film says it just before the close`);
      }
    }
  }

  // 15. Nothing is said twice, once more: the close and the promise above may have put a line back.
  sayOnce();

  return { spec: { ...spec, scenes }, notes };
}

// Whether two spoken lines are the same line: each has nearly all of the other's words.
export const saidAgain = (one: string, other: string): boolean => echoes(one, other) >= 0.8 && echoes(other, one) >= 0.8;

const LISTS = new Set<Layout>(['checklist', 'steps', 'bullets', 'compare', 'chart']);
