import { foreignIn } from './places.ts';
import { content, countWords, STOP, type Layout, type Scene } from './spec.ts';
import { inStyle, noFace, photographic, trimTo } from './critic.ts';
import { framingOf, lensPhrase, SIZE_PHRASE, SIZES_OF, type Lens, type Size } from './moves.ts';

// The pictures.
//
// Everything before this decides what the film says and when it cuts. This decides what is actually on the screen
// at each of those cuts, and it is the pass that was missing. The three proof films made without it came back with
// five pictures of a hand holding a phone filming a street under a script about what investors look for — five
// photographs that could have illustrated any sentence in any film, which is the same as illustrating none of them.
//
// The fault was structural, not a bad prompt. A picture was drawn per *scene* out of `keywords(scene.text)`, the
// same picture was shared down a run of scenes, and nothing anywhere compared one picture's subject to another's.
// So the rules are here, and they are rules rather than hopes:
//
//   - **A picture belongs to a shot, not to a scene.** The editor cuts a scene into several shots; each of them
//     shows something of its own, or the cut changes nothing and is worse than a hold.
//   - **A picture comes out of the phrase being spoken under it** — the words on the clock at that moment, not the
//     scene's headline and not the film's subject in general.
//   - **It names a subject, an action and a place.** "Investors" is not a picture. "A partner reading a one-page
//     summary across a table in an empty meeting room" is.
//   - **No two pictures in one film share a subject.** Measured as token overlap, not hoped for.
//   - **Nothing generic.** There is a banned list, and it holds the exact shots that came back on the proof films.
//   - **Variety is assigned, not requested.** Each slot is given a kind — wide, medium, detail, object, environment
//     — before the model sees it, so a film cannot come back as six medium shots of the same thing.
//   - **A picture that sits under type is composed with a hole where the type goes**, and is measured afterwards to
//     make sure the type really clears it.

// The six ways a shot can be framed. A film that cuts between them reads as a film; one that does not reads as a
// slideshow, however different the subjects are.
export const KINDS = ['wide', 'medium', 'detail', 'object', 'environment', 'data'] as const;
export type Kind = (typeof KINDS)[number];

// Where on the frame the words are going to sit, so the picture can be composed with room for them. `none` is a
// picture with nothing over it at all, which is the only one that may fill the frame.
export type Room = 'foot' | 'top' | 'none';

// One picture, for one shot.
export type Visual = {
  // Which shot in the film this is, counted from zero, and which scene it belongs to.
  at: number; scene: number; take: number;
  // The words spoken under it. Everything else in here is checked against these.
  line: string;
  // The whole line the scene says, of which `line` is the part that lands on this shot. A shot in the middle of a
  // sentence gets a fragment — "sales. Prove customers" was a real one — and a fragment has too few words in it to
  // judge a picture against, so the sentence it came out of counts too.
  about?: string;
  // What is in the picture: a subject doing something somewhere, in the words a picture model reads.
  subject: string;
  kind: Kind;
  room: Room;
  // When the line is an abstraction — "trust", "momentum", "what investors look for" — the picture is a declared
  // stand-in for it rather than a photograph of the word. Naming it is what makes it checkable: a picture with no
  // noun from the line and no metaphor is a picture of something else.
  metaphor?: string;
  // The size and lens the storyboard gave this scene, carried onto its first shot. The size has already decided the
  // framing above; the lens is said in the picture's own words.
  size?: Size; lens?: Lens;
};

export type Finding = { rule: string; at: number; says: string };

// --- what a picture may not be -----------------------------------------------------------------------------

// The shots a picture model reaches for when it has not been told anything. Every one of these has been on a film
// this studio made, and most of them were on all five frames of the same one. They are banned outright: a line
// that is really about a phone may still have a phone in it, which is why the check below lets the line's own
// nouns override the ban.
export const FILLER_SHOTS = [
  'hand holding a phone', 'holding a phone', 'person holding a phone', 'hand holding a smartphone',
  'filming a street', 'filming the street', 'pointing a phone', 'scrolling on a phone',
  'laptop on a desk', 'laptop on a table', 'open laptop', 'hands typing on a keyboard', 'typing on a laptop',
  'person at a laptop', 'person working on a laptop', 'man at a computer', 'woman at a computer',
  'business meeting', 'team meeting', 'people in a meeting room', 'group of people collaborating',
  'team collaborating', 'diverse team', 'business people shaking hands', 'handshake',
  'busy city street', 'city skyline at sunset', 'crowded street', 'people walking in a city',
  'abstract background', 'abstract shapes', 'gradient background', 'blurred background',
  'light bulb', 'lightbulb moment', 'rocket taking off', 'rocket launch', 'upward arrow',
  'growth chart going up', 'bar chart going up', 'stack of coins', 'piggy bank',
  'coffee cup on a desk', 'cup of coffee beside a notebook', 'sticky notes on a wall',
  'person looking at the camera', 'influencer talking to camera', 'young professional smiling',
];
const FILLER_RE = new RegExp(`(${FILLER_SHOTS.map((one) => one.replace(/\s+/g, '\\s+')).join('|')})`, 'i');
export const fillerShot = (subject: string): string | null => FILLER_RE.exec(subject ?? '')?.[1]?.toLowerCase() ?? null;

// A picture model cannot write. It has no negative prompt either — the local model is distilled and runs at a
// guidance of one, which throws the negative away, and Workers AI takes only a prompt — so "no text, no letters"
// is read as part of the same sentence and summons the very thing it asked to be spared. A real scene of type
// came back sitting on a picture of fake type reading "rogblellem / Solvic" that way.
//
// The only thing that works is never asking. So every noun that summons lettering is struck out of a subject
// before it is drawn, and a verb that asks for writing goes with it.
export const SUMMONS_TEXT = /\b(charts?|graphs?|dashboards?|decks?|slides?|metrics|checklists?|lists?|texts?|signs?|signage|screens?|displays?|interfaces?|ui|uis|apps?|websites?|web ?pages?|pages?|documents?|reports?|spreadsheets?|logos?|brands?|labels?|posters?|banners?|headlines?|newspapers?|magazines?|books?|whiteboards?|notebooks?|notes?|letters?|words?|writing|written|typography|captions?|subtitles?|numbers?|figures?|percentages?|slogans?|titles?|inscriptions?|lettering|typeface|font|question\s+marks?|exclamation\s+marks?|punctuation|symbols?|emoji|icons?|pictograms?|glyphs?)\b/gi;
// "a sign reading OPEN", "a mug that says Boss", "a door labelled Accounts" — the literal goes with the verb that
// introduced it, because the noun alone is not what summons the lettering: the quoted words are. A verb with no
// literal after it ("a founder reading a summary") is somebody doing something and is left where it is.
const ASKS_FOR_WRITING = /\b(?:reading|saying|says|inscribed(?:\s+with)?|captioned|titled|labell?ed|spelling\s+out)\b\s+["“']?[A-Z][^,.;]{0,40}/g;
// A global regular expression keeps its place between calls, so it is never asked a yes-or-no question: what came
// back is the match itself, which is also the word the founder is told about.
export const asksForWriting = (subject: string): string | null =>
  ((subject ?? '').match(SUMMONS_TEXT)?.[0] ?? (subject ?? '').match(ASKS_FOR_WRITING)?.[0] ?? null);

// The same subject with every word that summons lettering taken out of it. What is left is the picture that was
// really wanted: "a founder reading a one-page summary" rather than "a founder reading a pitch deck slide".
export function unlettered(subject: string): string {
  SUMMONS_TEXT.lastIndex = 0;
  return (subject ?? '')
    .replace(ASKS_FOR_WRITING, ' ')
    .replace(SUMMONS_TEXT, ' ')
    // The article whose noun has just gone with the rest of it: "a founder reading a , in an empty room".
    .replace(/\b(?:a|an|the|of|with)\s*(?=[,;.]|$)/gi, ' ')
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/^[\s,;.]+|[\s,;.]+$/g, '')
    .trim();
}

// Somebody in the frame. A film has one person in it at most, and this is how that is counted.
//
// The rule is not squeamishness, it is what a real render showed. A fifteen-second reel made with everything else
// in this file working came back with four different shots of the same dark-haired woman in the same office,
// because four different subjects all ended with "anybody in the picture is at work and turned away from the
// camera" and a picture model handed that draws a person — the same person, because the look is fixed and that is
// what a fixed look is for. Four shots of one stranger nobody introduced is the identity-drift fault from the
// other direction: not a person who keeps changing, a person who keeps coming back.
//
// So at most one picture in a film may have somebody in it. Everything else is a place, a thing or a detail, and
// the clause that invites a person is only written on the one that is allowed one.
const SOMEBODY = /\b(person|people|man|men|woman|women|boy|girl|child|founder|investor|partner|presenter|speaker|host|worker|customer|client|colleague|stranger|somebody|someone|crowd|team|face|portrait|hands?|figures?|silhouettes?|shoulders?)\b/gi;
export const somebodyIn = (subject: string): string | null => ((subject ?? '').match(SOMEBODY)?.[0] ?? null);
// The same subject with the people taken out of it, so what is left is the place or the thing it was set in.
export const nobodyIn = (subject: string): string =>
  (subject ?? '').replace(SOMEBODY, ' ')
    .replace(/\b(?:a|an|the|of|with|by|beside|near)\s*(?=[,;.]|$)/gi, ' ')
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/^[\s,;.]+|[\s,;.]+$/g, '').trim();

// What a picture is asked for the second time, when the first came back breaking a rule. Somebody staring down
// the lens is answered by taking the people out of the words altogether — asking the same model for the same
// person "turned away" is what was already asked — and either fault is answered by stepping back: a wide frame
// of a place has no room in it for a face, and lettering a long way off is a texture rather than writing.
export function redrawnFor(visual: Visual, found: { face: boolean }): Visual {
  return {
    ...visual,
    subject: found.face ? nobodyIn(visual.subject) : visual.subject,
    kind: visual.kind === 'wide' ? 'environment' : 'wide',
  };
}

// --- is this picture of what is being said? ------------------------------------------------------------------

// How much two subjects have in common, counted in the words that carry meaning. Two pictures that share most of
// their nouns are one picture drawn twice, whatever the grammar around them.
export function shares(a: string, b: string): number {
  const mine = new Set(content(a));
  const theirs = new Set(content(b));
  if (!mine.size || !theirs.size) return 0;
  let both = 0;
  for (const word of mine) if (theirs.has(word)) both += 1;
  return both / Math.min(mine.size, theirs.size);
}

// The one word a picture is of: the first thing in it that carries meaning. Two pictures with the same head noun
// are two pictures of the same thing, however far apart the rest of the words are.
export const headNoun = (subject: string): string => content(subject)[0] ?? '';

// The words of a line that can be photographed: its nouns, near enough. There is no parser here, so it is the line's
// meaningful words less the ones that are plainly not things — verbs a line does, words for nothing and everything,
// the ways of saying how — and less the ones a picture model cannot draw without lettering.
//
// It matters because a picture that shares a *word* with its line is not always of it. The site's hero film put
// "nothing leaves your computer that you did not wire" over a loading dock: the director's picture (a lock over a data
// diagram) had rightly been refused, and the picture built in its place was "computer and nothing and decide, on a
// loading bay at dusk" — three words of the line, one of them a thing, and a picture model drew the only thing in the
// sentence it could see, which was the loading bay.
const NOT_THINGS = new Set(['nothing', 'anything', 'everything', 'something', 'nobody', 'anybody', 'everybody', 'somebody',
  'decide', 'decides', 'leave', 'leaves', 'left', 'keep', 'keeps', 'make', 'makes', 'made', 'read', 'reads', 'write', 'writes',
  'follow', 'follows', 'edit', 'edits', 'wired', 'works', 'work', 'runs', 'run', 'take', 'takes', 'give', 'gives', 'want',
  'wants', 'need', 'needs', 'know', 'knows', 'see', 'sees', 'show', 'shows', 'get', 'gets', 'try', 'tries', 'use', 'uses',
  'own', 'only', 'small', 'big', 'new', 'good', 'great', 'real', 'whole', 'every', 'each', 'other', 'same', 'first', 'last',
  'never', 'always', 'still', 'even', 'also', 'again', 'beside', 'without', 'within', 'across', 'through', 'free',
  'private', 'local', 'automatically', 'did', 'does', 'done', 'going', 'said', 'says', 'able', 'less', 'much', 'many']);
const THING_STEM = (word: string) => word.replace(/(?:ing|ed|s)$/, '').replace(/e$/, '');
export function nounsOf(line: string): string[] {
  SUMMONS_TEXT.lastIndex = 0;
  return [...new Set(content(line ?? '').filter((word) => !NOT_THINGS.has(word) && !/(?:ly|ing|ed)$/.test(word)
    && !new RegExp(SUMMONS_TEXT.source, 'i').test(word)))];
}
const hasNoun = (text: string, nouns: string[]): boolean => {
  const mine = new Set(content(text ?? '').map(THING_STEM));
  return nouns.some((noun) => mine.has(THING_STEM(noun)));
};

// Whether a picture is of the line it sits under. It is, if it has one of the line's own things in it; or if it
// declares a stand-in for the line, and the stand-in says which of the line's words it stands for. A line with no
// thing in it at all ("you decide") may be met with any word of it, or a declared stand-in. Anything else is a
// picture of something else.
export const aboutTheLine = (visual: Visual): boolean => {
  const said = `${visual.line} ${visual.about ?? ''}`;
  const words = content(said);
  if (!words.length) return true;
  const nouns = nounsOf(said);
  const standsIn = !!visual.metaphor && content(visual.metaphor).length >= 2
    && content(visual.metaphor).map(THING_STEM).some((word) => words.map(THING_STEM).includes(word));
  if (nouns.length) return hasNoun(visual.subject, nouns) || standsIn;
  if (content(visual.subject).some((word) => words.includes(word))) return true;
  return !!visual.metaphor && content(visual.metaphor).length >= 2;
};

// A subject that is only a list of the line's words — "computer and nothing and decide, on a loading bay" — is not a
// picture of anything: a picture model reads it as a place with some words in front, and draws the place.
export const listSubject = (subject: string): boolean => /^(?:[\p{L}'-]+ and )+[\p{L}'-]+,/u.test((subject ?? '').trim());

// Whether a subject, written now or remembered from an earlier film, holds up as this shot's picture.
export const heldUp = (visual: Visual): boolean =>
  countWords(visual.subject) >= 4 && !listSubject(visual.subject) && aboutTheLine(visual);

// Whether a found photograph is of the line, by what its photographer said it is.
//
// Numbers, money and dates are not things a library holds pictures of: "Seven thousand two hundred euros" summoned a
// scan of fish captioned "seven" and a protest photograph tagged "Euro". So they do not count as the line's things,
// and a line left with no thing at all is met by the film's own topic ("a pottery class") or not by a photograph.
//
// The film's topic counts whole or not at all. A topic of two words ("farmers market") is met by a photograph that
// names both, not by one that shares one of them: "Kuay Makuach, farmer, Lankien, South Sudan" is not a farmers
// market. The line's own things still count one at a time. And a photograph whose title names a country, a region
// or a news event that neither the brief nor the line names is of that place or that day (`foreignIn`), and is refused.
//
// Given the film's world, a photograph is also of that world: a museum's object or catalogue entry the founder never
// named is refused, and a photograph that met the line on one of its things also names a thing of the world beside it
// ("a rotary phone" is a phone; "a phone at a dental reception" is this film's phone). A miss is drawn instead.
//
// A world with no concrete thing in it ("an explainer about our app", and nothing pinned) has nothing a photograph can
// be of, so every picture of that film is drawn.
export const photoOfTheLine = (what: string, visual: Pick<Visual, 'line' | 'about'>, topic: string[] = [], brief = '', world?: World): boolean => {
  const said = `${visual.line} ${visual.about ?? ''}`;
  if (foreignIn(what, `${brief} ${said} ${topic.join(' ')} ${world?.named ?? ''}`).length) return false;
  if (world && standInOf(what, `${world.named} ${said}`)) return false;
  if (world && !world.words.length) return false;
  if (world?.words.length) {
    const met = thingsOf(said).filter((word) => hasNoun(what, [word])).map(THING_STEM);
    const beside = world.words.filter((word) => !met.includes(THING_STEM(word)) && hasNoun(what, [word]));
    if (!beside.length) return false;
  }
  const things = thingsOf(said);
  const whole = topic.slice(0, 2);
  const nouns = [...new Set([...things, ...topic])];
  // A line that names nothing ("you decide") takes any photograph; one whose only things were numbers takes none.
  if (!nouns.length) return !nounsOf(said).length;
  // With a topic of two words, a line's thing counts beside one of them: "DJ Snake looking down to the crowd" shares
  // "crowd" with a line about avoiding crowds, and is still a concert rather than a farmers market.
  const topical = whole.some((word) => hasNoun(what, [word]));
  if (hasNoun(what, things) && (whole.length < 2 || topical)) return true;
  if (!whole.length) return false;
  return whole.every((word) => hasNoun(what, [word]));
};

// Words that are a quantity, a sum of money or a date rather than a thing: spelled numbers, currencies, metrics,
// months, weekdays, years.
const NUMBERISH = new Set(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty',
  'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'hundreds', 'thousand', 'thousands', 'million', 'millions',
  'billion', 'billions', 'dozen', 'dozens', 'half', 'percent', 'cent', 'cents', 'euro', 'euros', 'dollar', 'dollars', 'pound',
  'pounds', 'yen', 'mrr', 'arr', 'eur', 'usd', 'gbp', 'revenue', 'cash', 'runway', 'burn', 'budget', 'price', 'profit',
  'january', 'february', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'today', 'tomorrow', 'yesterday', 'year',
  'years', 'month', 'months', 'week', 'weeks', 'day', 'days', 'hour', 'hours', 'minute', 'minutes', 'second', 'seconds',
  'first', 'second', 'third', 'fourth', 'fifth', 'tenth', 'hundredth', 'thousandth']);
export const numberish = (word: string): boolean => NUMBERISH.has(word.toLowerCase()) || /\d/.test(word)
  || word.split('-').length > 1 && word.split('-').every((part) => NUMBERISH.has(part.toLowerCase()));

// The commonest words for how a thing is rather than what it is, which a title search reads as things.
const QUALITIES = new Set(['wet', 'dry', 'old', 'young', 'little', 'tiny', 'huge', 'large', 'empty', 'full', 'quiet', 'loud',
  'bright', 'dark', 'black', 'white', 'red', 'blue', 'green', 'yellow', 'brown', 'grey', 'gray', 'soft', 'hard', 'warm',
  'cold', 'slow', 'fast', 'long', 'short', 'high', 'low', 'rough', 'smooth', 'clean', 'dirty', 'fresh', 'raw', 'shape',
  'golden', 'natural', 'gentle', 'vibrant', 'busy', 'colourful', 'colorful', 'ripe', 'rustic']);

// What a product is as a kind of business rather than a thing anybody can photograph. Journey 15's explainer "about
// our marketplace" (renting idle 3D printers to local makers) was handed an old market square in Poznań, a Waikiki
// shopping mall and drawn ceramic tiles: "marketplace" had been read as a place. The film's world is the brief's
// concrete things (printers, makers, filament), and a word from here is never one of them.
export const PRODUCT_KINDS = new Set(['marketplace', 'marketplaces', 'platform', 'platforms', 'app', 'apps', 'application',
  'applications', 'service', 'services', 'network', 'networks', 'hub', 'hubs', 'solution', 'solutions', 'ecosystem',
  'software', 'saas', 'website', 'websites', 'portal', 'portals', 'startup', 'startups', 'company', 'companies',
  'business', 'businesses', 'product', 'products', 'community', 'communities', 'system', 'systems', 'brand', 'brands']);

// A line's photographable things: its nouns, less every number, sum and date, the words for a quality and the words
// for a kind of business.
export const thingsOf = (line: string): string[] => nounsOf(line).filter((word) => !numberish(word) && !QUALITIES.has(word) && !PRODUCT_KINDS.has(word));

// What the film is about, in its own nouns: the words after "about" (or "of", "on") in the brief, else the brief's
// things less the words for a film. "A 20 second documentary clip about a pottery class, with real photographs" is
// about ["pottery", "class"]. Every photograph in the film may be of the topic when its line names nothing.
const FILM_WORDS = new Set(['film', 'films', 'video', 'videos', 'clip', 'clips', 'reel', 'reels', 'documentary', 'short',
  'photographs', 'photograph', 'photos', 'photo', 'pictures', 'picture', 'footage', 'story', 'piece', 'trailer', 'teaser',
  'narration', 'voice', 'music', 'captions', 'vertical', 'wide', 'tall', 'square', 'cinematic', 'style', 'look', 'version']);
export function topicOf(brief: string): string[] {
  const after = /\b(?:about|of|on|showing|featuring)\s+(.+?)(?:[,.;:!?]|\s+(?:with|for|in which|that|using|set to|and make|told)\b|$)/i.exec(brief ?? '')?.[1] ?? '';
  const keep = (text: string) => thingsOf(text).filter((word) => !FILM_WORDS.has(word) && !ABSTRACT.has(word));
  const named = keep(after);
  return (named.length ? named : keep(brief ?? '')).slice(0, 3);
}

// Words a brief uses for how things feel rather than for a thing in the world: "voicemail chaos" is about voicemail.
// A picture of "chaos" is whatever a picture model or a museum's catalogue thinks chaos looks like.
const ABSTRACT = new Set(['after', 'before', 'while', 'within', 'during', 'until', 'since', 'upon', 'into', 'onto', 'miss', 'misses',
  'chaos', 'mess', 'problem', 'problems', 'pain', 'pains', 'stress', 'overload', 'frustration',
  'confusion', 'struggle', 'struggles', 'explainer', 'elsewhere', 'front', 'back', 'side', 'top', 'bottom', 'way', 'ways',
  'thing', 'things', 'stuff', 'lot', 'lots', 'kind', 'idea', 'ideas', 'point', 'part', 'fact', 'case', 'issue', 'issues',
  ...PRODUCT_KINDS]);

// --- the film's world ---------------------------------------------------------------------------------------------
//
// A picture has to be of the line AND of the film's world. A thirty-second explainer about voicemail chaos at a
// dental practice front desk came back with a brass paperweight, a brass bell, a vintage rotary telephone and a bronze
// anchor sculpture: each was a model's stand-in for an abstract line ("the weight of the backlog", "missed"), and each
// shared a word or two with the line, so nothing refused it. The world is the brief's own things (and, for a film
// about the company, the product's), and `setting` is where the brief put them ("at a dental practice front desk").
export type World = {
  // The things of the film's world, in the brief's and the product's own words.
  words: string[];
  // Everything the founder wrote: a museum piece they named themselves is theirs to have.
  named: string;
  // Where the brief set the film, as a phrase a picture can end on.
  setting?: string;
  // The kind the founder wrote a thing with, by the thing: "3D printers" is { printers: '3D' }. Drawn without it, the
  // film's 3D printers came back as a laser printer, an inkjet and an ink cartridge.
  kinds?: Record<string, string>;
};

// A kind a picture model reads the thing by: "3D", "2D". Written "3-D" or "3‑D" by a model, it is the same kind.
const KIND = /\b(\d)\s*[-‑–]?\s*(d)\b/gi;
const kindOf = (text: string): string[] => [...(text ?? '').matchAll(KIND)].map((hit) => `${hit[1]}${hit[2]}`.toUpperCase());
// A thing of the world as the founder wrote it, kind and all.
export const worldThing = (word: string, world?: World): string => {
  const kind = world?.kinds?.[THING_STEM(word)];
  return kind ? `${kind} ${word}` : word;
};

// The rough setting of a brief: the first "at ...", "in ..." or "inside ..." phrase that names a thing of the film.
export function settingOf(brief: string): string | undefined {
  for (const hit of (brief ?? '').matchAll(/\b(at|in|inside)\s+((?:an?|the|their|our|your)\s+)?([^,.;:!?]+)/gi)) {
    const words = hit[3].trim().split(/\s+/).slice(0, 6);
    const phrase = `${hit[1].toLowerCase()} ${(hit[2] ?? 'a ').toLowerCase()}${words.join(' ')}`.replace(/\s{2,}/g, ' ').trim();
    if (/\d/.test(phrase) || words.length < 2 || !thingsOf(words.join(' ')).filter((word) => !FILM_WORDS.has(word)).length) continue;
    if (/^(?:in|at)\s+(?:an?\s+)?(?:second|seconds|minute|minutes|style|look|time)\b/i.test(phrase)) continue;
    return phrase.replace(/^(at|in|inside) our /, '$1 a ').replace(/^(at|in|inside) your /, '$1 a ');
  }
  return undefined;
}

// People by what they are to a business: drawn, they are a stranger, which a film has one of at most.
const PEOPLE_WORDS = /^(?:patients?|callers?|dentists?|doctors?|nurses?|staff|receptionists?|users?|customers?|clients?|guests?|students?|owners?|buyers?|sellers?|visitors?|members?)$/i;

// Words a brief uses that no photograph can be of: anybody at all, a place relative to somebody, what is done.
// "Old marketplace with people" matched "people" from "people rent out their idle 3D printers".
const NOT_WORLD = new Set(['people', 'person', 'persons', 'everyone', 'anyone', 'nearby', 'idle', 'rent', 'rents', 'send',
  'sends', 'need', 'needs', 'get', 'gets', 'sit', 'sits', 'wait', 'waits', 'pay', 'pays']);

// The film's world out of the founder's ask and, for a film about the company, the product's own facts.
export function worldOf(ask: string, facts = ''): World {
  const keep = (text: string) => thingsOf(text).filter((word) => !FILM_WORDS.has(word) && !ABSTRACT.has(word) && !NOT_WORLD.has(word) && word.length > 2);
  const own = keep(ask);
  // The product's own name is not a thing anybody can photograph: "a callback, at the front desk".
  // A word the facts only ever write with a capital is a name.
  const lower = new Set((facts ?? '').match(/\b[a-z][a-z'-]+\b/g) ?? []);
  const names = new Set(((facts ?? '').match(/\b[A-Z][a-z][\w'-]*\b/g) ?? []).map((word) => word.toLowerCase()).filter((word) => !lower.has(word)));
  // And a word that takes an object straight after it is something the product does ("transcribes each voicemail",
  // "offers them a slot"), not a thing: drawn, it came back as "transcribes beside voicemails".
  const does = new Set([
    ...[...(facts ?? '').matchAll(/\b([a-z]+s)\s+(?:them|it|a|an|the|each|every|out|what|its|their|his|her|our|your)\b/g)].map((hit) => hit[1]),
    ...[...(facts ?? '').matchAll(/\b(?:it|nobody|somebody|someone|who|that|which|they|he|she)\s+([a-z]+s)\b/gi)].map((hit) => hit[1].toLowerCase()),
  ]);
  const product = keep(facts).filter((word) => !own.includes(word) && !names.has(word) && !does.has(word)).slice(0, 12);
  const words = [...new Set([...topicOf(ask), ...own, ...product])];
  const named = `${ask ?? ''} ${facts ?? ''}`;
  const kinds: Record<string, string> = {};
  for (const hit of named.matchAll(/\b(\d\s*[-‑–]?\s*d)\s+([a-z][a-z'-]+)/gi)) {
    const thing = THING_STEM(hit[2].toLowerCase());
    if (words.some((word) => THING_STEM(word) === thing)) kinds[thing] = kindOf(hit[1])[0];
  }
  return { words, named, setting: settingOf(ask), ...(Object.keys(kinds).length ? { kinds } : {}) };
}

// Objects that stand in for an idea rather than show the film's world, and the marks of a museum's or an archive's
// catalogue. A photograph titled "Bronze anchor, accession 1984.12.3, Maritime Museum Collection" is of the anchor in
// the museum, whatever its tags share with the line. None of them is refused when the founder named it.
const STAND_INS = /\b(paperweights?|bells?|anchors?|sculptures?|sculpted|statues?|statuettes?|figurines?|busts?|ornaments?|trophy|trophies|medals?|medallions?|coins?|specimens?|artefacts?|artifacts?|relics?|antiques?|antique|vintage|bronze|museums?|collections?|catalogues?|catalogs?|catalogued|exhibits?|exhibitions?|accession|hourglass(?:es)?|archives?|archival)\b/gi;
const CATALOGUE_NUMBER = /\b(?:inv|acc|accession|object|cat)\.?\s*(?:no\.?|number|#)\s*[\w.-]*\d|\b\d{2,4}\.\d{1,4}\.\d{1,4}\b/i;
export function standInOf(text: string, named = ''): string | null {
  const mine = new Set(content(named).map(THING_STEM));
  for (const hit of (text ?? '').matchAll(STAND_INS)) {
    const word = hit[0].toLowerCase();
    if (!mine.has(THING_STEM(word))) return word;
  }
  return CATALOGUE_NUMBER.test(text ?? '') ? 'a catalogue number' : null;
}

// Whether a drawn picture has one of the film's own things in it. "Nine small ceramic tiles" under "Already nine
// printers are listed" declared itself a stand-in for the listing and drew something no 3D printer marketplace has. A
// film with no world, or a world with no things, asks nothing of it.
//
// A thing the founder wrote with its kind counts only with it: a laser printer is not one of the film's 3D printers.
export function ofTheWorld(subject: string, world?: World): boolean {
  if (!world?.words.length) return true;
  const kinds = kindOf(subject);
  return world.words.some((word) => {
    if (!hasNoun(subject, [word])) return false;
    const kind = world.kinds?.[THING_STEM(word)];
    return !kind || kinds.includes(kind);
  });
}

// How well a picture or a photograph sits in the film's world: a stand-in is below zero, and anything else counts
// the world's things it has in it.
export function worldScore(text: string, world?: World): number {
  if (!world) return 1;
  if (standInOf(text, world.named)) return -1;
  // The setting a rebuilt picture ends on is said of every one of them, and is no sign of a good one.
  const own = world.setting ? text.replace(world.setting, ' ') : text;
  return world.words.filter((word) => hasNoun(own, [word])).length;
}

// The picture a film closes on. A shot at the close that shares the shot before's picture, or one off the film's
// world, or the weakest of three or more, takes the best picture of the film's world instead. The journey's film
// held a bronze anchor for its last eight seconds because the close was handed the picture nearest it.
// `scores` is each drawable shot that has a picture, by its place in `owners`, with its `worldScore`.
export function closeHolds(owners: number[], scores: Map<number, number>): number[] {
  const last = owners.length - 1;
  if (last < 0 || !scores.size) return owners;
  const own = owners[last];
  const mine = scores.get(own);
  const all = [...scores.values()];
  const weakest = scores.size >= 3 && mine !== undefined && mine <= 0 && mine === Math.min(...all) && mine < Math.max(...all);
  if (own === last && mine !== undefined && mine >= 0 && !weakest) return owners;
  const before = last > 0 ? owners[last - 1] : -1;
  const best = [...scores].filter(([, score]) => score > 0 && (mine === undefined || score > mine || own !== last))
    .sort(([a, one], [b, other]) => other - one || Number(a === before) - Number(b === before) || b - a)[0];
  if (!best) return owners;
  return owners.map((one, at) => (at === last ? best[0] : one));
}

// What a photo library is asked for one shot, in order of hope: the shot's own things beside the film's topic, then
// the topic alone. Two tries, after which the picture is drawn. A subject's words count only when they are the
// line's or the topic's: "an eighty beside a seven, on a linen cloth" is the director's word salad for a number.
//
// A film whose ask names no thing ("an explainer about our marketplace") has no topic, and its lines name the product
// and anybody at all: Journey 15 searched "printnear people" and "already printers". Given its world, such a film asks
// for the line's own things that are of the world, and then for the world's first thing.
export function stockQueries(visual: Pick<Visual, 'line' | 'about' | 'subject'>, topic: string[] = [], world?: World): string[] {
  if (!topic.length && world?.words.length) return worldQueries(visual, world);
  // "documentary" and "photograph" are what the shot is, not what it is of.
  const line = thingsOf(`${visual.line} ${visual.about ?? ''}`).filter((word) => !FILM_WORDS.has(word));
  const subject = thingsOf(visual.subject ?? '').filter((word) => !FILM_WORDS.has(word));
  const backed = subject.filter((word) => line.includes(word) || topic.includes(word));
  const lead = [...backed, ...line].filter((word, index, all) => all.indexOf(word) === index);
  const second = topic.slice(0, 2).join(' ');
  if (!lead.length) return second ? [second] : [];
  const first = [...lead.slice(0, 1), ...topic.slice(0, 1), ...lead.slice(1, 2)].filter((word, index, all) => all.indexOf(word) === index).slice(0, 2).join(' ');
  return [first, second].filter((query, index, all) => query && all.indexOf(query) === index);
}

function worldQueries(visual: Pick<Visual, 'line' | 'about' | 'subject'>, world: World): string[] {
  const things = world.words.filter((word) => !PEOPLE_WORDS.test(word));
  const said = [...thingsOf(visual.subject ?? ''), ...thingsOf(`${visual.line} ${visual.about ?? ''}`)];
  const mine = [...new Set(said.flatMap((word) => world.words.filter((one) => THING_STEM(one) === THING_STEM(word))))];
  const first = mine.slice(0, 2).join(' ');
  const second = things.slice(0, 1).join(' ');
  return [first, second].filter((query, index, all) => query && all.indexOf(query) === index);
}

// --- the reading ------------------------------------------------------------------------------------------

// How much two subjects may share before they are the same picture. Half is generous: "a founder at a table" and
// "a founder at a desk" share two of three and are the same photograph.
export const SAME = 0.5;

export function criticiseVisuals(visuals: Visual[], world?: World): Finding[] {
  const found: Finding[] = [];
  const say = (rule: string, at: number, says: string) => found.push({ rule, at, says });
  const heads = new Map<string, number>();
  visuals.forEach((visual, index) => {
    const where = `picture ${index + 1}`;
    if (countWords(visual.subject) < 4) {
      say('thin', index, `${where} is "${visual.subject}" — a picture names a subject, what it is doing and where it is`);
    }
    const filler = fillerShot(visual.subject);
    // A line that really is about a phone may have a phone in it; a line about anything else may not.
    if (filler && !content(visual.line).some((word) => filler.includes(word))) {
      say('filler', index, `${where} is "${filler}", which could illustrate any sentence in any film`);
    }
    if (asksForWriting(visual.subject)) {
      say('lettering', index, `${where} asks a picture model to write "${asksForWriting(visual.subject)}", and a picture model cannot write`);
    }
    if (listSubject(visual.subject)) {
      say('thin', index, `${where} is a list of words, "${trimTo(visual.subject, 8)}", and a picture model draws the place after them`);
    }
    if (!aboutTheLine(visual)) {
      say('unrelated', index, `${where} shares no word with "${trimTo(visual.line, 9)}" and names no stand-in for it`);
    }
    const standIn = world ? standInOf(visual.subject, `${world.named} ${visual.line}`) : null;
    if (standIn) say('standin', index, `${where} is ${standIn === 'a catalogue number' ? 'a museum piece' : `a ${standIn}`}, a stand-in nobody asked for — show a real thing from the film's world (${world!.words.slice(0, 6).join(', ')})`);
    else if (!ofTheWorld(visual.subject, world)) say('offworld', index, `${where} is "${trimTo(visual.subject, 8)}", which has none of the film's own things in it — show one of them (${world!.words.slice(0, 6).join(', ')})`);
    const head = headNoun(visual.subject);
    if (head) {
      const before = heads.get(head);
      if (before !== undefined) say('repeat', index, `${where} is another picture of ${head}, and so was picture ${before + 1}`);
      else heads.set(head, index);
    }
    for (let other = 0; other < index; other += 1) {
      if (shares(visual.subject, visuals[other].subject) >= SAME) {
        say('same', index, `${where} and picture ${other + 1} are the same picture in different words`);
        break;
      }
    }
  });
  // A film has one person in it. The second one is a stranger nobody introduced, and in a fixed look it is the
  // same stranger, which is worse.
  const peopled = visuals.map((one, index) => (somebodyIn(one.subject) ? index : -1)).filter((one) => one >= 0);
  for (const index of peopled.slice(1)) {
    say('crowd', index, `picture ${index + 1} has somebody in it and so does picture ${peopled[0] + 1} — a film has one person in it`);
  }
  // A film framed the same way throughout is a slideshow however varied its subjects are.
  const kinds = new Set(visuals.map((one) => one.kind));
  if (visuals.length >= 4 && kinds.size < 3) {
    say('framing', 0, `every picture in the film is a ${[...kinds].join(' and ')} shot — a film cuts between wide, medium and detail`);
  }
  return found;
}

// --- putting it right without asking anybody ------------------------------------------------------------------

// The places a picture can be, one per shot, so two shots drawn from the same line are still two pictures. These
// are deliberately plain: a place is where a thing happens, and the drama is meant to come from the subject.
//
// A place is also never bigger than the thing on it. "On a loading bay at dusk" is a subject of its own, and a picture
// model handed a thin subject and a loading bay draws the loading bay — which is how the hero film's promise ended
// up over one. Every place here is a surface the thing rests on, so the thing stays the picture.
const PLACES = [
  'resting on a bare wooden table in first light', 'on a plain desk against a painted wall', 'on a windowsill on a grey afternoon',
  'on a workbench under one lamp', 'on a linen cloth in soft window light', 'on a stone step in open shade',
  'on a kitchen counter at the end of the day', 'on a shelf in a quiet room', 'on a slate surface under raked light',
  'on a folded blanket beside a window', 'on a painted floor in morning light', 'on a low table in an empty room',
];
// Things that take no article: "research", not "a research".
const MASS = new Set(['research', 'work', 'data', 'time', 'money', 'light', 'water', 'privacy', 'access', 'software',
  'information', 'advice', 'feedback', 'progress', 'context', 'music', 'paper', 'mail', 'code']);
const withArticle = (noun: string): string =>
  (MASS.has(noun) || (/s$/.test(noun) && !/ss$/.test(noun)) ? noun : `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`);
// What the camera is doing, per kind. This is the half of a picture nobody writes down and every generated still
// is missing: a frame has a distance and a lens, and six frames at the same distance read as one frame.
// One of these describes a person and the rest describe a place or a thing, and that is the whole point. A
// picture model told "the subject to one side of the frame" draws a person, because to a picture model a subject
// is a person — so a film where four slots were framed that way came back with three strangers in it even after
// the one-person rule had struck every person out of the words. The framing is where a person really gets in, so
// only `medium` lets one in, and `slotsFor` hands `medium` out exactly once a film.
const FRAMING: Record<Kind, string> = {
  wide: 'a wide establishing frame of an empty place, a great deal of air above, nothing in the middle of the frame',
  medium: 'a medium shot at eye level of one person at work, seen in profile or from behind, to one side of the frame',
  detail: 'a tight detail filling the frame, very shallow focus, the background fallen away',
  object: 'one object alone on a plain surface, raked side light, the rest of the frame empty',
  environment: 'a room with nobody in it, the light falling across the floor, seen from the doorway',
  data: 'a flat overhead of a plain surface, one object placed on it, even light, nothing else in frame',
};
// Where the hole for the type goes. A picture that fills the frame under a headline is a picture with a headline
// across its subject, which is how a real reel put its hook over somebody's face.
const ROOM: Record<Room, string> = {
  foot: 'the lower third of the frame is empty and in shadow, the subject kept in the upper half',
  top: 'the upper third of the frame is empty and in shadow, the subject kept in the lower half',
  none: 'the subject centred, filling the frame',
};

// The words of a line worth building a picture out of: what it is about, longest first, with anything already
// used elsewhere in the film skipped. This is the floor under the whole pass — a picture built from these is
// never brilliant and is always of the right thing, which is the trade the founder actually wants.
export function subjectWords(line: string, used: Set<string>, most = 3): string[] {
  const words = content(line).filter((word) => !used.has(word));
  const ranked = [...new Set(words)].sort((a, b) => b.length - a.length);
  return ranked.slice(0, most);
}

// A picture built out of a line and nothing else. Deterministic: the same line at the same place in the same film
// gives the same picture every time it is rendered.
//
// It is the subject only — no framing and no hole for the type. Those are the same handful of words on every
// picture in a film, and baking them into the subject made two perfectly different pictures look, to the rule
// that counts shared words, like the same picture twice.
//
// The line's own things come first, set as things ("a computer beside a wire"), with nobody in them where the line
// has a thing that is not a person. Only a line with no thing in it at all falls back to its other words.
//
// Given the film's world, the world's things go first and the picture is set where the brief set the film, so a
// picture rebuilt from "the weight of every unanswered call" is a phone at the dental practice's front desk rather than
// a phone on a windowsill. A line with nothing of its own left takes one of the world's things.
export function visualFrom(line: string, at: number, used: Set<string>, world?: World): string {
  const inWorld = (word: string) => !!world && hasNoun(word, world.words);
  // With a world, only the line's things that are of it: the rest of a line's words ("returns", "instead", "costs")
  // are what a sentence does, and a picture of them is a picture of nothing.
  const things = nounsOf(line).filter((word) => !used.has(word) && (!world?.words.length || (inWorld(word) && !ABSTRACT.has(word))));
  const still = things.filter((word) => !somebodyIn(word) && !PEOPLE_WORDS.test(word));
  const picked = (still.length || world?.words.length ? still : things).sort((a, b) => Number(inWorld(b)) - Number(inWorld(a)) || b.length - a.length).slice(0, 2);
  const place = world?.setting ?? PLACES[at % PLACES.length];
  if (picked.length) {
    for (const word of picked) used.add(word);
    return `${picked.map((word) => withArticle(worldThing(word, world))).join(' beside ')}, ${place}`;
  }
  const spare = world?.words.find((word) => !used.has(word) && !somebodyIn(word) && !PEOPLE_WORDS.test(word) && !(world.setting ?? '').includes(word));
  if (spare) {
    used.add(spare);
    return `${withArticle(worldThing(spare, world))}, ${place}`;
  }
  const words = subjectWords(line, used, 3);
  for (const word of words) used.add(word);
  const about = words.length ? `an object that stands for ${words.join(', ')}` : trimTo(line, 4) || 'a pair of hands at rest';
  return `${about}, ${PLACES[at % PLACES.length]}`;
}

// Everything the critic found, done to the pictures rather than said about them. Nothing here asks anybody
// anything and it always terminates: each pass either replaces one picture with one built from its own line or
// leaves it alone.
export function repairVisuals(visuals: Visual[], world?: World): { visuals: Visual[]; notes: string[] } {
  const notes: string[] = [];
  const note = (line: string) => { if (!notes.includes(line)) notes.push(line); };
  const used = new Set<string>();
  const made: Visual[] = [];
  // Whether somebody has already been put on screen in this film.
  let peopled = false;
  for (const [index, visual] of visuals.entries()) {
    let one: Visual = { ...visual, subject: unlettered(visual.subject) };
    if (one.subject !== visual.subject) note('a picture was asked to have writing in it, and a picture model cannot write, so the writing came out');
    const apart = (subject: string) => (world?.setting ? subject.replace(world.setting, ' ') : subject);
    const wrong = () => {
      if (world && standInOf(one.subject, `${world.named} ${one.line}`)) return 'standin';
      if (!ofTheWorld(apart(one.subject), world)) return 'offworld';
      const filler = fillerShot(one.subject);
      if (filler && !content(one.line).some((word) => filler.includes(word))) return 'generic';
      if (countWords(one.subject) < 4 || listSubject(one.subject)) return 'thin';
      if (!aboutTheLine(one)) return 'unrelated';
      // The film's setting, which a rebuilt picture ends on, is where every picture is and not what it is of: two
      // pictures sharing it are not the same picture.
      if (made.some((other) => shares(apart(one.subject), apart(other.subject)) >= SAME)) return 'repeated';
      const head = headNoun(one.subject);
      if (head && made.some((other) => headNoun(other.subject) === head)) return 'repeated';
      return null;
    };
    const fault = wrong();
    if (fault) {
      note(fault === 'generic' ? 'a picture that could have illustrated any sentence was drawn from the line it sits under instead'
        : fault === 'repeated' ? 'two pictures in the film were the same picture, so the second is drawn from its own line'
          : fault === 'standin' ? "a picture was a stand-in object rather than a thing of the film's world, so it is drawn from its line where the film is set"
          : fault === 'offworld' ? "a picture had none of the film's own things in it, so it is drawn from the brief's things where the film is set"
          : 'a picture was of something the line never mentions, so it is drawn from the line instead');
      one = { ...one, subject: visualFrom(content(one.line).length >= 2 ? one.line : (one.about ?? one.line), index, used, world), metaphor: undefined };
    } else {
      for (const word of content(one.subject).slice(0, 3)) used.add(word);
    }
    // One person in a film. The first picture that has somebody in it keeps them; every one after it is the same
    // place or the same thing with nobody in it, which is what it should have been.
    if (somebodyIn(one.subject)) {
      if (peopled) {
        const alone = nobodyIn(one.subject);
        note('a second picture had somebody in it, and a film has one person in it, so that shot is of the place instead');
        one = { ...one, subject: countWords(alone) >= 3 ? alone : visualFrom(one.line, index, used, world), kind: one.kind === 'medium' ? 'environment' : one.kind };
      } else peopled = true;
    }
    made.push(one);
  }
  // Framing, last, because a repair may have changed what a picture is of but never how it is framed. A film with
  // fewer than three kinds of frame in it has the middle of its pictures re-framed until it has.
  const kinds = new Set(made.map((one) => one.kind));
  if (made.length >= 4 && kinds.size < 3) {
    const wheel: Kind[] = ['wide', 'medium', 'detail', 'object', 'environment'];
    made.forEach((one, index) => {
      if (kinds.size >= 3 || index === 0) return;
      const next = wheel[index % wheel.length];
      if (next === one.kind) return;
      made[index] = { ...one, kind: next };
      kinds.add(next);
    });
    note('the whole film was framed the same way, so the middle of it cuts between a wide, a medium and a detail');
  }
  return { visuals: made, notes };
}

// --- asking the model -------------------------------------------------------------------------------------

// What every shot in the film is, laid out for the model as a numbered list with the phrase spoken under it and
// the frame it has to be shot in. The frame is assigned rather than asked for, because a model asked to vary its
// own framing does not.
export function visualsPrompt(slots: Visual[], bible: string, angle: string, world?: World): string {
  return [
    'You are the director of photography on a short film. For each numbered moment below, write the one picture that',
    'is on screen while that line is spoken. Answer with one JSON object and nothing else.',
    '',
    '{"pictures": [{"at": the number, "subject": "who or what, doing what, where — one sentence", "metaphor": "leave this out unless the line is an abstraction, in which case say in a few words what the picture stands for"}]}',
    '',
    `The film argues: ${angle}`,
    `Every picture is shot the same way: ${bible}`,
    '',
    'The rules these pictures are checked against before anything is drawn:',
    '- A picture names a subject, what that subject is doing, and where. "Investors" is not a picture. "A partner sliding a single sheet of paper back across a table" is.',
    '- It comes out of the line spoken under it. Use one of that line\'s own words, or say what the picture stands for in "metaphor".',
    ...(world ? [worldRule(world)] : []),
    '- No two pictures in this film may be of the same thing. Not the same subject, not the same place, not the same action.',
    '- Never a hand holding a phone, a laptop on a desk, hands on a keyboard, a meeting room, a city street, an abstract background, a lightbulb or a rocket, unless the line itself is about one.',
    '- A picture model cannot write. Nothing in a picture may be a screen, a chart, a sign, a document, a logo or any other surface with words on it.',
    '- At most ONE picture in the whole film may have a person in it. Every other picture is a place, an object or a detail with nobody in it.',
    '- Nobody looks at the camera. Anybody in that one picture is at work and turned away.',
    '- The framing of each picture is already decided and is written beside it. Keep it.',
    '',
    'The moments:',
    ...slots.map((slot) => `${slot.at + 1}. [${slot.kind} shot; ${ROOM[slot.room]}] said over it: "${slot.line || '(nothing is said)'}"`
      + (slot.about && slot.about !== slot.line ? `  (out of: "${slot.about}")` : '')),
  ].join('\n');
}

// The film's world, said to the model the way the critic will read it.
export const worldRule = (world: World): string =>
  `- Every picture is a real thing from the film's world${world.setting ? `, ${world.setting}` : ''}: ${world.words.slice(0, 10).map((word) => worldThing(word, world)).join(', ')}. `
  + 'Never a stand-in object for an idea: no paperweight, bell, anchor, sculpture, trophy, medal, coin, hourglass, antique or museum piece.';

// What came back, read as loosely as it can honestly be read, with everything missing left for the repair.
export function visualsOf(raw: unknown, slots: Visual[]): Visual[] {
  const said = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(said.pictures) ? said.pictures : Array.isArray(said) ? said : [];
  const byAt = new Map<number, Record<string, unknown>>();
  list.forEach((one, order) => {
    const item = (one ?? {}) as Record<string, unknown>;
    const at = Number(item.at);
    byAt.set(Number.isFinite(at) ? Math.round(at) - 1 : order, item);
  });
  return slots.map((slot) => {
    const said = byAt.get(slot.at);
    const subject = typeof said?.subject === 'string' ? said.subject.trim().slice(0, 240) : '';
    const metaphor = typeof said?.metaphor === 'string' && said.metaphor.trim() ? said.metaphor.trim().slice(0, 120) : undefined;
    return subject ? { ...slot, subject, metaphor } : slot;
  });
}

// --- the shot list, before anything has been drawn --------------------------------------------------------

// A scene whose frame is already full of words wants something quiet behind them rather than a competing picture:
// a texture, framed as a texture, with nothing in it to read.
export const TYPE_HEAVY = new Set<Layout>(['checklist', 'bullets', 'steps', 'compare', 'stat', 'quote', 'title', 'cta', 'outro']);

// Which way a shot is framed, decided before the model sees it. The wheel turns with the shot's place in the
// film, so no two neighbours are framed alike and a six-shot film has at least four framings in it.
const WHEEL: Kind[] = ['medium', 'environment', 'detail', 'wide', 'object', 'detail', 'medium', 'wide'];
export const kindFor = (at: number, layout: Layout): Kind =>
  (TYPE_HEAVY.has(layout) ? (at % 2 ? 'detail' : 'environment') : WHEEL[at % WHEEL.length]);

// Where the words are on this frame, and so where the picture must leave a hole. A picture scene with no caption
// of its own is the only one that gets the whole frame.
export function roomFor(scene: Scene, captions: boolean): Room {
  const writes = [scene.heading, scene.text, ...(scene.bullets ?? [])].some((one) => one?.trim());
  // Nothing is going to be written on this frame and nothing is being said under it, so the picture is the whole
  // scene and may fill the frame. It is the only one that may.
  if (!writes && !captions) return 'none';
  // A picture scene in a captioned film moves its own caption to the head of the frame, because the foot is
  // already spoken for by the caption band — so the hole in the picture moves with it.
  if (captions && scene.layout === 'picture') return 'top';
  // Everywhere else the words a viewer reads end up in the lower half: the caption band in a captioned film, the
  // block of type over a photograph in one without.
  return 'foot';
}

// One slot per shot, empty, ready for the model to fill or the rules to fill for it. `line` is the phrase really
// spoken under that shot rather than the whole scene's narration: a three-second shot in the middle of a long
// sentence gets the words that land on it.
export type Slot = { scene: number; take: number; line: string; layout: Layout };
// The framings a film may use for the shots that are not its one person: a place, a thing, a detail, a wide.
const WITHOUT: Kind[] = ['environment', 'detail', 'object', 'wide'];
export function slotsFor(slots: Slot[], captions: boolean, scenes: Scene[]): Visual[] {
  const made = slots.map((slot, at): Visual => {
    const scene = scenes[slot.scene];
    const dealt = kindFor(at, slot.layout);
    // A size the storyboard chose is kept on the scene's first shot: a framing of the same family as the one dealt
    // stays as dealt, and one of another family takes the size's own. The later shots of that scene keep the deal,
    // so a scene cut in two still cuts between sizes.
    const size = slot.take === 0 ? scene?.shot : undefined;
    const kind: Kind = size && !SIZES_OF[dealt].includes(size) ? framingOf(size) : dealt;
    return {
      at, scene: slot.scene, take: slot.take, line: slot.line,
      about: (scene?.say ?? '').trim() || undefined,
      subject: '', kind, room: roomFor(scene ?? { layout: slot.layout }, captions),
      ...(size ? { size } : {}), ...(slot.take === 0 && scene?.lens ? { lens: scene.lens } : {}),
    };
  });
  // Exactly one shot in a film is framed as a person. The first one the wheel offers keeps it; the rest take a
  // place or a thing, by rotation, so the film still cuts between distances.
  let person = false;
  return made.map((one, at) => {
    if (one.kind !== 'medium') return one;
    if (!person) { person = true; return one; }
    return { ...one, kind: WITHOUT[at % WITHOUT.length] };
  });
}

// --- the words a picture model is finally handed -----------------------------------------------------------

// Everything above, turned into the one line a picture model reads: the film's own look first so six frames are
// six frames of one film, then the framing, then the subject, then the hole the type sits in. Nothing in it asks
// for lettering, nobody in it faces the camera, and nothing in it is drawn when the rest of the film is shot.
export function drawnAs(visual: Visual, bible: string): string {
  const subject = unlettered(noFace(photographic(bible) ? inStyle(visual.subject, bible) : visual.subject));
  const body = subject || visualFrom(visual.line, visual.at, new Set());
  // The clause that invites a person is written on the one picture that is allowed one and nowhere else. It used
  // to be on all of them, and a picture model handed it draws a person every time — the same person, because the
  // look is fixed. Four shots of one stranger is what that cost on a real reel.
  const who = somebodyIn(body) ? ', anybody in the picture is at work and turned away from the camera' : '';
  // How big and through what, where the storyboard said: a phrase about focus and distance, never anybody's name.
  // A shot the rules have since re-framed (a second person taken out, a face stepped back from) has left the size it
  // was given behind, and a close-up's long lens on what is now a wide is two instructions that disagree.
  const holds = !visual.size || SIZES_OF[visual.kind].includes(visual.size);
  const lens = holds ? [visual.size ? SIZE_PHRASE[visual.size] : '', lensPhrase(visual.lens)].filter(Boolean).join(', ') : '';
  return `${bible}. ${FRAMING[visual.kind]}${lens ? `, ${lens}` : ''}: ${body}, ${ROOM[visual.room]}${who}`
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1');
}

// How many pictures a film can afford to draw, in minutes rather than in principle. Away from this machine a
// picture is four seconds and a free account covers hundreds a day, so a film draws one a shot. Here it is nearly
// a minute each, and eleven minutes of waiting for a fifteen-second reel is not a trade a founder would make.
// The arithmetic lives in `shared/film-time.ts`, because the card says the same minutes before Make is pressed.
export { afforded, SECONDS_AWAY, SECONDS_HERE } from '../../shared/film-time.ts';

// Which shots get a picture of their own when there is not one for every shot: the opening, the close, and then
// the longest, because a long shot is where a repeat is seen. The rest share the picture nearest them, at their
// own crop — which is the old behaviour, kept honest by being the exception rather than the rule.
//
// `have` is the shots whose picture is already drawn or being drawn. They were started while the narration was
// still being listened back to, from a cut that was guessed; the measured cut may rank its shots a little
// differently, and a picture already paid for is never thrown away to draw its neighbour instead.
export function shareOut(lengths: number[], many: number, have: ReadonlySet<number> = new Set()): number[] {
  if (many >= lengths.length) return lengths.map((_one, at) => at);
  const order = lengths.map((seconds, at) => ({ seconds, at }))
    .sort((a, b) => (a.at === 0 ? -1 : b.at === 0 ? 1 : b.seconds - a.seconds || a.at - b.at));
  const kept = [...have].filter((at) => at >= 0 && at < lengths.length);
  const drawn = new Set([...kept, ...order.map((one) => one.at).filter((at) => !have.has(at))].slice(0, Math.max(many, kept.length)));
  const owners: number[] = [];
  let last = -1;
  for (let at = 0; at < lengths.length; at += 1) {
    if (drawn.has(at)) last = at;
    owners.push(last);
  }
  // A shot before the first drawn one takes the first drawn one.
  const first = owners.find((one) => one >= 0) ?? 0;
  return owners.map((one) => (one >= 0 ? one : first));
}

// A shot's name across two cuts of the same film: which scene it is in and which take of that scene it is. The
// guessed cut and the measured one disagree by a few frames about *when*, and almost never about *which*.
export const shotKey = (one: { scene: number; take: number }): string => `${one.scene}:${one.take}`;

// The line a scene stands for when nothing is heard under it: what is said, or in a film nobody narrates, the words
// written on the screen. A silent film's shots were handed an empty line, so their pictures were built from "a pair
// of hands at rest" and any photograph at all passed as one of the line — a pottery class came back as hand washing.
export const sceneLine = (scene: { say?: string; heading?: string; text?: string } | undefined): string =>
  (scene?.say ?? '').trim() || [scene?.heading, scene?.text].map((one) => (one ?? '').trim()).filter(Boolean).join('. ');

// The words really spoken under one shot, out of the film's measured word timings. A shot is given the words
// whose middle falls inside it, so a picture is of the phrase on the screen rather than of the scene in general.
export function lineUnder(words: { word: string; at: number; seconds: number }[], from: number, to: number, fallback: string): string {
  const said = words.filter((one) => one.at + one.seconds / 2 >= from && one.at + one.seconds / 2 < to).map((one) => one.word);
  // Two words is not a phrase. A shot that lands in a gap takes the scene's own line rather than a stray preposition.
  return said.filter((one) => !STOP.has(one.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''))).length >= 2 ? said.join(' ') : fallback;
}
