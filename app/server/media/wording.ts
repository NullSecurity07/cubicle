import { content, countWords, STOP, VISUAL_LAYOUTS, type Layout, type Purpose, type Scene } from './spec.ts';

// Reading what a line of writing actually is: where a headline may stop, what a line's keywords are, whether it
// opens a door, carries a figure or asks for a face. The critic reads every storyboard with these, and the studio
// uses a few of them on their own; they are here so that neither has to reach into the critic's rules to get them.

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

// A line made shorter only by whole thoughts: a last sentence dropped, or a last clause, and only while what is left
// is still a sentence of four words or more. Anything else is left as it was. The length pass used to cut word by
// word, and it cut the site's hero film's promise to "You decide, and nothing leaves." in a film that already ran
// short — a line with its meaning cut off is worse than a film a second long.
export function trimWhole(said: string, most: number): string {
  const line = (said ?? '').trim();
  const sentences = line.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 1) {
    let kept = sentences;
    while (kept.length > 1 && countWords(kept.join(' ')) > most) kept = kept.slice(0, -1);
    return kept.join(' ');
  }
  const clauses = line.split(/(?<=[,;:])\s+|\s+[—–]\s+/);
  let kept = clauses;
  while (kept.length > 1 && countWords(kept.join(' ')) > most) {
    const next = kept.slice(0, -1);
    const left = next.join(' ').replace(/[\s,;:—–]+$/, '');
    if (countWords(left) < 4 || !endsClean(left)) break;
    kept = next;
  }
  if (kept.length === clauses.length) return line;
  return `${kept.join(' ').replace(/[\s,;:—–.!?]+$/, '')}.`;
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
  // An opening clause too short to stand ("You decide,") hands over to the next whole one that fits, its joining word
  // dropped: "nothing leaves your computer" is the headline of "You decide, and nothing leaves your computer that you
  // did not wire", where the first five words stop before saying what leaves.
  if (first && countWords(first) < 3) {
    for (const part of whole.split(CLAUSE).slice(1)) {
      const clause = part.replace(/^(?:and|but|so|or)\s+/i, '').replace(/[\s,;:]+$/, '').trim();
      if (clause && countWords(clause) <= room && countWords(clause) >= 3 && content(clause).length >= 2) {
        return clause.charAt(0).toUpperCase() + clause.slice(1);
      }
    }
  }
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
export const ECHO_FINE = new Set<Layout>(['hook', 'cta', 'logo', 'title', 'stat', 'quote', 'presenter']);
// The shapes that are information rather than a sentence set in type: a figure the size of the frame, bars that
// grow, a before beside an after, a list that arrives one line at a time. One of these is what "a data beat"
// means, and a film long enough to have something to measure has to carry one.
export const DATA = new Set<Layout>(['stat', 'chart', 'compare', 'checklist', 'steps']);
export const NEEDS_TEXT = new Set<Layout>(['statement', 'quote', 'outro', 'hook', 'cta']);
