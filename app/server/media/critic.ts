import {
  budgetOf, content, countWords, echoes, HEADING_WORDS, MAX_SCENES, saidWords, saysWhatItShows, STOP, TEXT_WORDS,
  VISUAL_LAYOUTS, type Layout, type Purpose, type Scene, type Spec,
} from './spec.ts';
import type { Pace } from './templates/looks.ts';
import type { Pack } from './templates/packs.ts';
import { dealMoves, dealShots, LENS_OF, moveOf, stillOf, takesMove, type Size } from './moves.ts';
import { claimsOf, figureSaid, fillerIn, madeUpNames, preciseFigures, realLine, unfill, ungrounded, type Sources } from './grounding.ts';

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
};

export type Finding = { rule: string; scene?: number; says: string };

// --- reading what a line of writing actually is -------------------------------------------------------------

// The stop words, what one line has of another, and whether a scene writes out its own narration all live in
// `spec.ts` now, because the renderer needs the last of them to decide whether a scene keeps its captions.
export { echoes, saysWhatItShows } from './spec.ts';

// Words that only ever introduce what comes after them. A headline may not end on one.
const WEAK_END = new Set(['whether', 'while', 'since', 'though', 'although', 'unless', 'until', 'because', 'after',
  'before', 'during', 'without', 'within', 'between', 'among', 'across', 'around', 'toward', 'towards', 'onto',
  'upon', 'per', 'via', 'every', 'each', 'both', 'either', 'neither', 'nor', 'one', 'two', 'three']);

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

// A cut that ends on "with a small" stops in the middle of the thing it was about to name. A determiner in the last
// two words is that: whatever it introduced did not make the cut.
const DANGLING = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'our', 'their', 'its',
  'his', 'her', 'no', 'every', 'each', 'another', 'some', 'any', 'one', 'two', 'three', 'both']);
export const endsClean = (line: string): boolean =>
  !line.split(/\s+/).map((one) => one.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')).slice(-2).some((one) => DANGLING.has(one));

// A line said aloud, made shorter. A sentence read out is not a string: cut it at ten words and the founder hears
// "I'm a founder, I feel." — which is what a real film said, because the fit was done with a headline's scissors.
// So whole sentences go first, then whole clauses, and a line with neither stays as long as it is: a film a second
// over is better than a film that stops mid-breath.
export function shorten(said: string, most: number): string {
  const sentences = (said ?? '').split(/(?<=[.!?])\s+/).map((one) => one.trim()).filter(Boolean);
  if (!sentences.length) return said ?? '';
  if (sentences.length > 1) {
    let kept = sentences;
    while (kept.length > 1 && countWords(kept.join(' ')) > most) kept = kept.slice(0, -1);
    if (countWords(kept.join(' ')) <= most) return kept.join(' ');
    return shorten(kept[0], most);
  }
  const one = sentences[0];
  if (countWords(one) <= most) return one;
  let run = '';
  for (const part of one.split(/(?<=[,;:])\s+|\s+[—–]\s+/)) {
    const next = run ? `${run} ${part}` : part;
    if (run && countWords(next) > most) break;
    run = next;
  }
  const cut = run.replace(/[\s,;:—–]+$/, '').trim();
  if (countWords(cut) >= 3 && countWords(cut) < countWords(one)) return `${cut.replace(/[.!?]+$/, '')}.`;
  // One long sentence with nothing to break it on. The words themselves, then, stopping on one that carries
  // something — never on "and", and never on the "a" whose noun did not make the cut.
  let words = trimTo(one, most);
  for (let cap = countWords(words); cap > 4 && !endsClean(words); cap = countWords(words)) {
    const shorter = trimTo(one, cap - 1);
    if (countWords(shorter) >= cap) break;
    words = shorter;
  }
  return countWords(words) >= 4 && countWords(words) < countWords(one) && endsClean(words) ? `${words.replace(/[.!?]+$/, '')}.` : one;
}

// A headline, out of a line somebody would say. It is English: "Investors ask a brutal question", never "Investors
// ask brutal question", which is what taking the small words out of a sentence leaves behind — three characters
// saved and the grammar gone. So the cut is made in whole words, on a clause where there is one, and only the
// throat-clearing at the front is dropped.
const LEAD_IN = new Set(['so', 'and', 'but', 'well', 'now', 'then', 'basically', 'actually', 'look', 'okay', 'right']);
// Where one thought ends and the next begins, for the purpose of cutting between them.
const CLAUSE = /(?<=[,;:])\s+|\s+[—–]\s+|\s+(?:and|but|so|because|which|that|while|when)\s+/i;
export function headlineOf(said: string, most: number): string {
  const words = (said ?? '').trim().replace(/^[^\p{L}\p{N}]+/u, '').split(/\s+/).filter(Boolean);
  while (words.length > 3 && LEAD_IN.has(words[0].toLowerCase().replace(/[^\p{L}]+/gu, ''))) words.shift();
  // A full stop belongs to a sentence, not to a headline; a question mark and an exclamation are the headline.
  const whole = words.join(' ').replace(/[,;:.]+$/, '');
  if (!whole) return '';
  // A line a word or two over the cap is set whole rather than broken in half: "I solve a single, painful problem"
  // is a headline, and "I solve a single" is the first half of one.
  const room = most + 2;
  if (countWords(whole) <= room) return whole;
  // A whole clause is a whole thought, and the one a line opens on is the one with the subject in it: "The founder
  // stays the operator" is the headline of that sentence, and "people speed the founder up" is the middle of it.
  // Nothing dangles at a clause boundary: that is the writer's own stopping place, so "the operator" ends the
  // thought it belongs to. Only a cut made in the middle of a line has to be checked for what it left behind.
  const first = whole.split(CLAUSE)[0]?.replace(/[\s,;:]+$/, '').trim() ?? '';
  if (first && countWords(first) <= room && countWords(first) >= 3 && content(first).length >= 2) return first;
  // No clause fits, so the words themselves — stopping on one that carries something, and never between "a" and
  // the thing it was about to name.
  let line = trimTo(whole, most);
  for (let cap = countWords(line); cap > 2 && !endsClean(line); cap = countWords(line)) {
    const shorter = trimTo(whole, cap - 1);
    if (countWords(shorter) >= cap) break;
    line = shorter;
  }
  // "The founder stays" is a subject and its verb and nothing they did: the beginning of a headline rather than
  // one. Three things said is the least that stands on its own, and below it the scene is better off with nothing
  // written on it at all, letting the captions carry the line.
  return content(line).length >= 3 && endsClean(line) ? line : '';
}

// An action a film may only ask for if somebody really offers it. A call to book, a number to ring, a page to visit
// or a thing to download is a promise the founder has to keep, and a film that invents one sends a stranger looking
// for a door that is not there. "Book a call, let's talk now" closed a reel whose founder had offered neither a
// call nor any way to make one.
const A_DOOR = /\b(book|booking|call us|call me|call now|ring|phone|dial|whatsapp|dm|message us|email us|sign ?up|subscribe|register|download|install|buy|order|shop|visit|click|tap|link in bio|schedule|demo|free trial|apply)\b/i;
export const opensADoor = (line?: string): string | null => A_DOOR.exec(line ?? '')?.[0] ?? null;

// What a film closes on when nobody has offered anything: something true that costs the viewer nothing to believe.
export const plainClose = (purpose: Purpose): { text: string; say: string } =>
  (purpose === 'reel' || purpose === 'ad' ? { text: 'Follow for more', say: 'Follow for more.' }
    : purpose === 'explainer' || purpose === 'launch' || purpose === 'feature' ? { text: 'Try it this week', say: 'Try it this week.' }
      : { text: 'Save this for later', say: 'Save this for later.' });

// What a picture behind the words is of: the thing being talked about — a workspace, a screen, hands at work, the
// light in a room. Never somebody looking down the lens. A film has one person in it and they are on camera; a face
// behind a headline is a second person the film never introduced, and a reel once sat five scenes on a close-up of
// a stranger who was not even its presenter.
const A_FACE = /\b(portraits? of|portrait|close[- ]?ups? of (?:a |the )?(?:person|man|woman|face|founder|presenter|speaker)|close[- ]?up (?:portrait|face)|(?:a |the )?face to camera|facing the camera|looking into the lens|head and shoulders|talking to camera|headshots?|selfies?)\b/gi;
export const facesCamera = (prompt?: string): string | null => {
  const found = A_FACE.exec(prompt ?? '');
  A_FACE.lastIndex = 0;
  return found ? found[0] : null;
};

// The same line with the face taken out of it, so what is left is the thing the scene is about.
export const noFace = (prompt: string): string =>
  prompt.replace(A_FACE, ' ').replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').replace(/^[\s,.]+|[\s,]+$/g, '').trim();

// A figure worth a scene of its own. A number belongs in a film because it changes something for the person
// watching: money, time, how many people, how much better. "17 — scene shapes" is an inventory of the product's own
// parts set forty points high, which tells a stranger how somebody's code is organised and nothing else.
const VIEWER_FIGURE = /(%|[$£€]|\b\d+(?:\.\d+)?\s*x\b)/i;
const VIEWER_WORDS = /\b(per ?cents?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|people|persons?|founders?|customers?|users?|clients?|teams?|companies|company|dollars?|pounds?|euros?|revenue|sales|cost|costs|price|prices|faster|quicker|slower|cheaper|longer|shorter|more|less|fewer|times|a ?week|a ?day|a ?month)\b/i;
// A figure scene is a figure set the size of the frame. "Proven" is not a figure, and a real reel set it forty
// points high because the line beside it happened to say "every month" — the words around a figure were being
// allowed to make something a figure. They can only ever make a figure *worth* setting that large.
export const worthAStat = (figure: string, beside = ''): boolean =>
  (VIEWER_FIGURE.test(figure) || /\d/.test(figure))
  && (VIEWER_FIGURE.test(figure) || VIEWER_WORDS.test(`${figure} ${beside}`));

// A path, a flag or a filename is something a founder types, not something a stranger reads off a screen.
export const CODEY = /(?:\S*\/\S*\.[a-z]{1,5}\b|\S+\/\s*$|\s--[a-z][\w-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|json|py|rs|go|md|yml|yaml|toml|sh)\b)/i;

// The same, but never padded out with the words that carry nothing: a line whose only real word is "goes" has no
// headline in it, and "It is" is not one. Used where a short line has to stand on its own or not be written at all.
export function kickerOf(said: string, most: number): string {
  const kept = said.trim().split(/\s+/).filter((word) => {
    const bareWord = word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    return bareWord.length > 2 && !STOP.has(bareWord);
  }).map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  return kept.length >= 2 ? kept.slice(0, most).join(' ') : '';
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
// A bullet is a thing, not the second half of a sentence. Anything opening on one of these is the rest of the
// line it was cut out of — "No proof" over "they walk away" is one sentence set as two bullets, which reads worse
// than the sentence did, and a real reel shipped with it.
const OPENERS = new Set(['which', 'that', 'who', 'whose', 'where', 'when', 'because', 'so', 'then', 'but', 'or',
  'they', 'it', 'he', 'she', 'we', 'you', 'i', 'this', 'these', 'those', 'there', 'his', 'her', 'its', 'their']);
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
// How many of the spoken line's own words may be set on screen before it stops being emphasis and starts being a
// transcript. Three or four is a creator reel; a sentence is a wall of type.
export const EMPHASIS_WORDS = 4;
const ECHO_FINE = new Set<Layout>(['hook', 'cta', 'logo', 'title', 'stat', 'quote', 'presenter']);
// The shapes that are information rather than a sentence set in type: a figure the size of the frame, bars that
// grow, a before beside an after, a list that arrives one line at a time. One of these is what "a data beat"
// means, and a film long enough to have something to measure has to carry one.
export const DATA = new Set<Layout>(['stat', 'chart', 'compare', 'checklist', 'steps']);
const NEEDS_TEXT = new Set<Layout>(['statement', 'quote', 'outro', 'hook', 'cta']);

// --- one film, one look -------------------------------------------------------------------------------------

// A film is shot one way. The style bible is one line of visual direction pasted in front of every picture, and it
// was meant to be enough — but a model writing six scenes will write "a 3d render of a founder" into scene four and
// the bible in front of it does not stop it, so a real fifteen-second reel came back with a cartoon character
// standing next to four photographs. Nothing reads worse: it is the one fault a stranger sees before they have read
// a word. So the words that ask for a drawing are named here, and a picture prompt that uses one is caught and put
// back into the look the rest of the film is in.
//
// A notebook film is drawn by hand on purpose, so none of this applies to it: what decides is the film's own bible,
// not our opinion of the word. A bible that says "illustration" is a film of illustrations, and every scene in it
// may say so too.
const DRAWN: RegExp[] = [
  /\bcartoons?\b/i,
  /\billustrat(?:ion|ions|ed|ive)\b/i,
  // "3-D render", "3d rendered", "3 D rendering": one thing, written five ways, and the one that made the fault.
  /\b3[\s-]?d\s*render(?:ed|ing|s)?\b/i,
  /\bcgi\b/i,
  /\banime\b/i,
  /\bcomics?\b/i,
  /\bvector\s+art\b/i,
  /\bflat\s+design\b/i,
  /\bclip\s+art\b/i,
  /\bpaintings?\b/i,
  /\bwater\s?colou?rs?\b/i,
  /\bsketch(?:es|ed|y)?\b/i,
  // "drawing on experience" and "drawing up a list" are things a person does, not things a picture is. Only the
  // noun counts, and the plural is always the noun: "drawings on the wall" are drawings.
  /\bdrawing\b(?!\s+(?:on|from|up|out|board|attention|breath|to)\b)|\bdrawings\b/i,
  // A "render" is a picture; "rendering" and "rendered" are what this tool does to a film every time it makes one,
  // so the bare noun is the only form that may be read as a style.
  /\brenders?\b/i,
];

// What a film is really shot on, and the light it is shot in. A bible that names neither is not a look, it is a
// mood word, and a picture model handed it will do whatever it likes — which is the fault this is here to stop.
const PHOTO_MEDIUM = /\b(photograph\w*|photos?|cinematograph\w*|film stills?|shot on|\d{2}\s?mm|medium format|documentary|portraits?|long lens|telephoto|macro|anamorphic|camera)\b/i;
const PHOTO_LIGHT = /\b(light\w*|lit|sunlight|daylight|backlit|shadows?|haze|glows?|glowing|golden hour|overcast|dusk|dawn|flare|contrast|exposure|silhouettes?|bright|dark\w*|moody)\b/i;

// The word in a line that asks for a drawing, as it was written, or nothing. Used on a bible to work out what kind
// of film this is, and on a scene's own prompt to work out whether it has wandered off.
export function drawnWord(text: string): string | null {
  for (const pattern of DRAWN) {
    const found = pattern.exec(text ?? '');
    if (found) return found[0].trim();
  }
  return null;
}

// Whether this film is a photographed one: it names a real medium and a real light, and it asks for nothing drawn.
export const photographic = (bible: string): boolean =>
  !drawnWord(bible ?? '') && PHOTO_MEDIUM.test(bible ?? '') && PHOTO_LIGHT.test(bible ?? '');

// What the film is made of, in the two forms a prompt needs it: "a photograph OF a founder" and "a photographED
// founder". The bible is written in adjectives — "editorial photography" — and a scene needs the thing itself, so
// the medium the bible names is turned back into a noun and the verb that goes with it.
const mediumOf = (bible: string): { noun: string; shot: string } =>
  (/cinemat|film still/i.test(PHOTO_MEDIUM.exec(bible)?.[0] ?? '')
    ? { noun: 'film still', shot: 'filmed' }
    : { noun: 'photograph', shot: 'photographed' });

// The word a picture prompt uses to ask for a look this film is not in, or nothing. A film that is drawn by hand
// allows all of them, because in that film they are the look.
export const offStyle = (prompt: string, bible: string): string | null =>
  (photographic(bible) ? drawnWord(prompt ?? '') : null);

// The same prompt, in the film's own look: every word that asked for a drawing is replaced by what the bible says
// this film is made of. Nothing else about the line is touched, because the subject was never the problem.
export function inStyle(prompt: string, bible: string): string {
  if (!prompt?.trim() || !photographic(bible)) return prompt;
  const { noun, shot } = mediumOf(bible);
  let said = prompt;
  // "a cartoon of a founder" is a thing; "a cartoon founder" is a way of being one. Which of the two words goes in
  // is decided by whether an "of" follows, because "a photograph founder" is not English and a picture model reads
  // a prompt the way a person does.
  for (const pattern of DRAWN) {
    said = said.replace(new RegExp(`(?:${pattern.source})(\\s+of\\b)?`, 'gi'), (_, of: string | undefined) => (of ? `${noun}${of}` : shot));
  }
  // A prompt that named two drawn looks in a row — "a 3d render cartoon of a desk" — would otherwise ask for the
  // same photograph twice. The last of the run is the one beside the subject, so that is the one that stays.
  const both = `\\b(?:${noun}|${shot})\\b`;
  return said
    .replace(new RegExp(`${both}(?:[\\s,]+${both})+`, 'gi'), (run) => run.trim().split(/[\s,]+/).at(-1) ?? run)
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim();
}

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

  const budget = budgetOf(want.seconds, scenes.length, want.pace);
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

  // 1a. A reel opens on a hook and closes on a call to action. Both are recasts of a scene that is already there, so
  //     the film is never a scene longer or shorter for it.
  if (want.reel && scenes.length >= 2) {
    if (scenes[0].layout !== 'hook' && can('hook')) {
      const first = scenes[0];
      const line = first.text || first.heading || first.say || '';
      scenes[0] = { ...first, layout: 'hook', heading: undefined, text: trimTo(line, HEADING_WORDS) || 'Watch this' };
      note('the film opened on a title card, so the first scene is a hook instead');
    }
    const last = scenes.at(-1)!;
    if (last.layout !== 'cta' && last.layout !== 'logo' && last.layout !== 'outro' && can('cta')) {
      const line = last.text || last.heading || last.say || '';
      scenes[scenes.length - 1] = { ...last, layout: 'cta', text: trimTo(line, HEADING_WORDS) || 'Follow for more', heading: last.heading && countWords(last.heading) <= 4 ? last.heading : undefined };
      note('the film had no ending, so the last scene is a call to action');
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
        if (made.layout === 'stat') made = recast(made, 'statement') ?? { ...made, layout: 'statement', text: made.text || 'What matters', heading: undefined };
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
          note('there is no address or command in your material, so the film closes on something plain rather than a made-up one');
          keep.push({ ...made, text: want.reel ? 'Follow for more' : 'Try it this week', heading: undefined, say: want.reel ? 'Follow for more.' : 'Try it this week.', source: undefined });
          continue;
        }
        // Nothing points at this. Either the founder's own words go in its place, or the scene goes.
        const real = sources.has ? realLine(sources, used) : null;
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

  // 2b. A wordmark is the mark of something. A film with no product behind it closes on what to do instead.
  if (want.product === false) {
    scenes = scenes.map((scene) => {
      if (scene.layout !== 'logo') return scene;
      note('there is no product behind this film, so it closes on what to do rather than on a made-up wordmark');
      return { ...scene, layout: 'cta', text: trimTo(scene.text || scene.heading || 'Follow for more', HEADING_WORDS), heading: undefined };
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
        const shorter = shorten(scene.say!, Math.max(4, spoken - 3));
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

  return { spec: { ...spec, scenes }, notes };
}

// --- the camera -----------------------------------------------------------------------------------------------
//
// How each picture is taken: its size, its lens and what the camera does. A storyboard may say any of these or none
// of them; the studio deals what it leaves out. What it did say is read against four rules, all of which can be put
// right here without asking anybody, and every one put right is said on the card.
//
//   1. Three pictures in a row the same size is one shot held three times. The third is re-dealt.
//   2. A close-up on a wide lens bends what is close to it; an extreme wide on a long lens cannot take in a place.
//   3. A move the studio does not know is dropped and dealt again; a move only a real clip can make, asked of a
//      still, becomes the nearest move a still can make.
//   4. Two neighbours making the same move is one move made twice. The second is dealt again.

const SIZE_WORDS: Record<Size, string> = { ecu: 'extreme close-up', cu: 'close-up', mcu: 'medium close-up', ms: 'medium', ws: 'wide', ews: 'extreme wide' };
// The size a run of one size is broken with: from far to near, and from near to far.
const BREAK: Record<Size, Size> = { ecu: 'ws', cu: 'ws', mcu: 'ws', ms: 'cu', ws: 'cu', ews: 'mcu' };
// "a orbit" is not English.
const article = (word: string) => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);

export function criticiseShots(spec: Spec, _want?: Want): Finding[] {
  const found: Finding[] = [];
  const say = (rule: string, says: string, scene?: number) => found.push({ rule, says, scene });
  const scenes = spec.scenes;
  const shown = scenes.map((scene, index) => ({ scene, index })).filter(({ scene }) => takesMove(scene.layout));
  shown.forEach(({ scene, index }, order) => {
    const at = index + 1;
    const before = shown.slice(Math.max(0, order - 2), order).map((one) => one.scene.shot);
    if (scene.shot && before.length === 2 && before.every((one) => one === scene.shot)) {
      say('sizes', `scenes ${shown[order - 2].index + 1} to ${at} are all ${SIZE_WORDS[scene.shot]} shots — a film cuts between sizes`, at);
    }
    if ((scene.shot === 'cu' || scene.shot === 'ecu') && (scene.lens === 24 || scene.lens === 35)) {
      say('lens', `scene ${at} is a ${SIZE_WORDS[scene.shot]} on a ${scene.lens}mm lens, which bends whatever is close to it`, at);
    }
    if (scene.shot === 'ews' && scene.lens === 135) say('lens', `scene ${at} is an extreme wide on a 135mm lens, which cannot take in a place`, at);
  });
  scenes.forEach((scene, index) => {
    const at = index + 1;
    if (!scene.move || !takesMove(scene.layout)) return;
    const move = moveOf(scene.move);
    if (!move) { say('move', `scene ${at} asks the camera to "${scene.move}", which is not a move the studio knows`, at); return; }
    if (takesMove(scene.layout) === 'still' && move.kind === 'motion') say('move', `scene ${at} is a still, and a still cannot ${move.name === 'handheld' ? 'be handheld' : `make ${article(move.name)}`}`, at);
    const last = index > 0 ? moveOf(scenes[index - 1].move) : undefined;
    if (last && last.name === move.name && takesMove(scenes[index - 1].layout)) say('move', `scenes ${index} and ${at} both ${move.name === 'static' ? 'stand still' : `make ${article(move.name)}`}`, at);
  });
  return found;
}

// The four rules done rather than said, and every blank dealt. Nothing here asks anybody anything.
export function mendShots(spec: Spec, want: Pick<Want, 'pace'> & { look?: Pack }): { spec: Spec; notes: string[] } {
  const notes: string[] = [];
  const note = (line: string) => { if (!notes.includes(line)) notes.push(line); };
  // A move on a scene that has no picture of its own to move is nothing, and goes quietly.
  let scenes = spec.scenes.map((one) => (one.move && !takesMove(one.layout) ? { ...one, move: undefined } : { ...one }));

  // 1. Sizes: a third in a row is broken, and its lens goes with it, because the lens belonged to the size.
  const shown = scenes.map((scene, index) => ({ scene, index })).filter(({ scene }) => takesMove(scene.layout));
  shown.forEach(({ index }, order) => {
    const size = scenes[index].shot;
    if (!size || order < 2) return;
    const [a, b] = [scenes[shown[order - 2].index].shot, scenes[shown[order - 1].index].shot];
    if (a !== size || b !== size) return;
    const next = BREAK[size];
    scenes[index] = { ...scenes[index], shot: next, lens: LENS_OF[next] };
    note(`three pictures in a row were ${SIZE_WORDS[size]} shots, so scene ${index + 1} is ${article(SIZE_WORDS[next])} instead`);
  });
  scenes = dealShots(scenes);

  // 2. Lenses that fight their size.
  scenes = scenes.map((scene, index) => {
    if ((scene.shot === 'cu' || scene.shot === 'ecu') && (scene.lens === 24 || scene.lens === 35)) {
      note(`scene ${index + 1} was a close shot on a wide lens, which bends whatever is near it, so it is taken on an 85`);
      return { ...scene, lens: 85 };
    }
    if (scene.shot === 'ews' && scene.lens === 135) {
      note(`scene ${index + 1} was an extreme wide on a long lens, which cannot take in a place, so it is taken on a 35`);
      return { ...scene, lens: 35 };
    }
    return scene;
  });

  // 3. Moves the studio does not know, and moves a still cannot make.
  scenes = scenes.map((scene, index) => {
    if (!scene.move) return scene;
    const move = moveOf(scene.move);
    if (!move) {
      note(`scene ${index + 1} asked the camera to "${scene.move}", which is not a move the studio knows, so it is given one that is`);
      return { ...scene, move: undefined };
    }
    if (takesMove(scene.layout) === 'still' && move.kind === 'motion') {
      const still = stillOf(move.name)!;
      note(`scene ${index + 1} is a still, and only a real clip can ${move.name === 'handheld' ? 'be handheld' : `make ${article(move.name)}`}, so it ${still.name === 'static' ? 'holds still' : `makes ${article(still.name)}`} instead`);
      return { ...scene, move: still.name };
    }
    // A still move the clip model does not read well is left to the deal, quietly: the clip is still made.
    if (takesMove(scene.layout) === 'motion' && move.kind === 'still' && !move.wanReads) return { ...scene, move: undefined };
    return { ...scene, move: move.name };
  });

  // 4. The same move twice running: the second is dealt again.
  for (let index = 1; index < scenes.length; index += 1) {
    const [before, now] = [scenes[index - 1].move, scenes[index].move];
    if (!now || now !== before) continue;
    note(`scenes ${index} and ${index + 1} made the same move, so the second is given another`);
    scenes[index] = { ...scenes[index], move: undefined };
  }
  scenes = dealMoves(scenes, spec.pace ?? want.pace, spec.pack ?? want.look);
  return { spec: { ...spec, scenes }, notes };
}
