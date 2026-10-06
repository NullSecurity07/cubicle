import type { Material } from './director.ts';
import { countWords, type Scene } from './spec.ts';

// Whether a film is telling the truth.
//
// A launch film made from this repository said the product had "live cursor tracking", "zero email clutter",
// "instant visual updates" and made a team "10x" more productive. None of that is in the source. A film that lies
// about a product is worse than a plain one: the founder cannot publish it, and everything else in it is suspect.
//
// The fix is not a better prompt. It is that every specific claim has to *point at* something — the director hands
// back, with each beat, a short quotation from the material it rests on, and this module checks, without asking
// anybody, that the quotation is really in the material. What cannot be pointed at is taken out and said out loud
// on the card. Where there is no material at all, general knowledge is fine and invented specifics are not: no
// precise statistics, no brand names nobody mentioned.

// The corpus a film's claims are checked against: everything the founder wired, dropped or typed.
export type Sources = {
  // Every word of the material, normalised: lower case, punctuation flattened, one space between words.
  corpus: string;
  // The brief itself, normalised. A name in the brief is the founder's, not the film's invention.
  brief: string;
  // Whether there is any material at all. With none, the rules change: general truths are fine, specifics are not.
  has: boolean;
  // Real sentences out of the material, for putting back what had to be taken out.
  lines: string[];
  // The brief's own sentences and clauses, as the founder wrote them. A line of theirs is never swapped for another.
  said?: string[];
  // What the product is and does, sentence by sentence, as the material says it (`productFacts`). A line that says
  // it works otherwise is a contradiction (`against-brief.ts`).
  facts?: string[];
};

// What the product is and does, out of a company brief: the "What the company does" line and the first paragraph
// under an Idea, Product or Customer heading, else the brief's first real paragraph. These are the facts a film about
// the company is held to, and the things of its world.
export function productFacts(text: string): string {
  const body = (text ?? '').replace(/\r/g, '');
  const facts: string[] = [];
  const does = /^\s*what (?:the company|we|it) does:\s*(.+)$/im.exec(body)?.[1];
  if (does) facts.push(does.trim());
  for (const hit of body.matchAll(/^#{1,4}\s*(?:idea|product|the product|customer|customers|what it does)\s*$\n+([^#\n][^\n]*)/gim)) facts.push(hit[1].trim());
  if (!facts.length) {
    const first = body.split(/\n\s*\n/).map((one) => one.trim()).find((one) => !one.startsWith('#') && one.split(/\s+/).length >= 8);
    if (first) facts.push(first.replace(/\s+/g, ' '));
  }
  return facts.join('\n');
}

export const flat = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}%$£€.]+/gu, ' ').replace(/\s{2,}/g, ' ').trim();

export function sourcesOf(material: Material, brief: string): Sources {
  const parts = [
    // What the product says it is counts as much as anything it says about itself: a close may be that line.
    material.pitch ?? '',
    ...material.lines,
    ...material.assets.map((one) => `${one.name} ${one.what}`),
    material.brand?.name ?? '',
  ].filter(Boolean);
  const body = parts.join('\n');
  const facts = [material.pitch ?? '', productFacts(material.lines.join('\n\n'))].join('\n')
    .split(/\n+|(?<=[.!?])\s+/).map((one) => one.trim()).filter((one) => one.split(/\s+/).length >= 4);
  return { corpus: flat(body), brief: flat(brief), has: material.lines.length > 0, lines: sentencesIn(body).slice(0, 40), said: clausesOf(brief), facts: [...new Set(facts)] };
}

// The brief cut where the founder paused: sentences, and the clauses a semicolon or a colon sets apart. A clause
// needs two words that carry meaning to count as something they said.
export function clausesOf(brief: string): string[] {
  return [...new Set((brief ?? '').split(/[.!?;:\n]+(?=\s|$)|[;:\n]/)
    .map((one) => one.replace(/["“”]/g, '').trim().replace(/^(?:and|so|but|then)\s+/i, ''))
    .filter((one) => meaningOf(one).length >= 2))];
}

// Whole sentences out of the material, for putting back what had to be taken out. A README wraps a sentence over
// two lines and lists its features one to a line, so a plain split on the newline hands back "The founder stays the"
// — which is not a sentence and cannot be said over a scene. A line that carries on is joined to the one after it;
// a bullet or a heading starts a new one; and nothing that ends mid-thought survives the filter.
const BULLET = /^\s*(?:[-*+>|#]|\d+[.)])/;
export function sentencesIn(body: string): string[] {
  const joined = body.split('\n').reduce<string[]>((lines, raw) => {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) { lines.push(''); return lines; }
    const last = lines.at(-1);
    // A heading is a short line with nothing after it and a capital on the line below; the sentence under it is its
    // own, not a continuation of the title.
    const heading = !!last && countWords(last) <= 6 && /^[\p{Lu}]/u.test(line);
    const carries = last && !heading && !BULLET.test(line) && !BULLET.test(last) && !/[.!?:]$/.test(last);
    if (carries) lines[lines.length - 1] = `${last} ${line}`;
    else lines.push(line);
    return lines;
  }, []);
  const said = joined.flatMap((one) => one.replace(BULLET, '').trim().split(/(?<=[.!?])\s+/))
    .map((one) => one.replace(/\s+/g, ' ').trim())
    .filter((one) => {
      if (countWords(one) < 4 || countWords(one) > 26 || !/[a-z]{3}/.test(one)) return false;
      if (!/^[\p{L}\p{N}]/u.test(one)) return false;
      if (/^(readme|copy from|what it says it is|a note on the stage)\b/i.test(one)) return false;
      // A sentence that reached its full stop is whole, whatever word it got there on. One that did not has to
      // end on a word that carries something, or it is a thought that stopped in the middle of itself.
      if (/[.!?]$/.test(one)) return true;
      if (/[,:;]$/.test(one)) return false;
      const end = one.split(' ').at(-1)?.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') ?? '';
      return !STOP.has(end);
    });
  // A sentence that closes on a full stop is a sentence; the rest is prose that ran out of line. Both may be used,
  // but a film is given the whole ones first.
  const whole = [...new Set(said)];
  return [...whole.filter((one) => /[.!?]$/.test(one)), ...whole.filter((one) => !/[.!?]$/.test(one))];
}

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'so', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from',
  'by', 'as', 'is', 'are', 'was', 'were', 'be', 'it', 'its', 'you', 'your', 'we', 'our', 'they', 'their', 'this',
  'that', 'these', 'those', 'all', 'any', 'no', 'not', 'one', 'more', 'most', 'into', 'out', 'up', 'down', 'over']);

// Whether a quotation really occurs in the material. A film that reads its source out word for word is grep with a
// soundtrack, so what is asked for is the substance rather than the wording: either the line is there as written,
// or most of the words that carry its meaning are. Two in three is the line — below that a sentence can share a
// noun with the material and mean something else entirely.
//
// The founder's brief counts as much as anything they wired. A promise the founder wrote into the brief is theirs to
// make: the site's own hero film was asked to "end on the promise" that nothing leaves the machine, and threw that
// line out as "nowhere in your material" because the README it was wired to had been cut before it said so. Each of
// the two is asked on its own, so a line is never grounded by a word from one and a word from the other.
export const ENOUGH_OF_IT = 0.6;
export function saysIt(quote: string, sources: Sources): boolean {
  const said = flat(quote ?? '');
  if (said.length < 6) return false;
  return [sources.corpus, sources.brief].some((body) => !!body && saidIn(said, body));
}
function saidIn(said: string, body: string): boolean {
  if (body.includes(said)) return true;
  const words = said.split(' ').filter((one) => one.length > 2 && !STOP.has(one));
  if (words.length < 2) return false;
  const found = words.filter((one) => body.includes(one.length > 5 ? one.slice(0, -1) : one));
  return found.length / words.length >= ENOUGH_OF_IT;
}

// A figure that is a claim rather than a count. "Three questions" is a way of speaking; "74%", "$12k", "10x" and
// "1,200" are measurements, and a measurement nobody measured is a lie with a decimal point in it.
const FIGURE = /([$£€]\s?\d[\d,.]*\s*(?:%|x\b|k\b|m\b|bn\b)?|\d[\d,.]*\s*(?:%|x\b|k\b|m\b|bn\b)|\d{1,3}(?:,\d{3})+|\b\d+(?:\.\d+)?\b)/gi;
export function preciseFigures(text?: string): string[] {
  const found = [...(text ?? '').matchAll(FIGURE)].map((hit) => hit[1].trim());
  return found.filter((one) => {
    if (/[%$£€]|\b\d+\s*[xkm]\b|bn/i.test(one)) return true;
    const plain = Number(one.replace(/,/g, ''));
    // A small whole number is a count — three steps, two founders — and everybody may say one.
    return !Number.isFinite(plain) || plain > 10;
  });
}

// A figure on screen and the same figure in the founder's own prose are the same fact: "12%" is what the material
// meant when it wrote "twelve per cent". A number is looked for both ways round before it is called invented.
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
export function spellOut(value: number): string[] {
  if (!Number.isInteger(value) || value < 0 || value > 999) return [];
  if (value < 20) return [ONES[value]];
  if (value < 100) { const ten = TENS[Math.floor(value / 10)]; const one = value % 10; return one ? [`${ten}-${ONES[one]}`, `${ten} ${ONES[one]}`] : [ten]; }
  const hundreds = `${ONES[Math.floor(value / 100)]} hundred`;
  return value % 100 ? [`${hundreds} and ${spellOut(value % 100)[0]}`, `${hundreds} ${spellOut(value % 100)[0]}`] : [hundreds];
}

// Every way the material might have written this figure.
export function figureSaid(figure: string, sources: Sources): boolean {
  if (saysIt(figure, sources)) return true;
  const digits = figure.replace(/[^\d.]/g, '');
  const value = Number(digits);
  if (!Number.isFinite(value) || !digits) return false;
  const words = spellOut(value);
  if (!words.length) return false;
  const percent = /%/.test(figure);
  const forms = words.flatMap((word) => (percent ? [`${word} per cent`, `${word} percent`] : [word]));
  return forms.some((form) => sources.corpus.includes(form));
}

// The words a marketing model reaches for when it has nothing to say. Every one of these was in a film made from
// this repository, and not one of them was in the repository.
export const FILLER = ['synergy', 'synergies', 'seamless', 'seamlessly', 'unlock', 'unlocks', 'unlocking',
  'revolutionize', 'revolutionise', 'revolutionary', 'streamline', 'streamlines', 'streamlining', 'game-changing',
  'game changer', 'cutting-edge', 'next-generation', 'next-gen', 'best-in-class', 'world-class', 'turnkey',
  'frictionless', 'effortless', 'supercharge', 'supercharges', 'leverage', 'leveraging', 'empower', 'empowers',
  'empowering', 'holistic', 'robust', 'paradigm', 'disrupt', 'disruptive', 'elevate your', 'take it to the next level',
  '10x', 'end-to-end solution', 'one-stop', 'cutting edge'];
const FILLER_RE = new RegExp(`\\b(${FILLER.map((one) => one.replace(/[-\s]/g, '[-\\s]')).join('|')})\\b`, 'gi');
export const fillerIn = (text?: string): string[] => [...new Set([...(text ?? '').matchAll(FILLER_RE)].map((hit) => hit[0].toLowerCase()))];
// The filler taken back out. An adjective that meant nothing leaves nothing behind it.
export const unfill = (text: string): string =>
  // A comma with a space on both sides of it belonged to the word that has just gone.
  text.replace(FILLER_RE, ' ').replace(/\s+,\s*/g, ' ').replace(/,\s*(?=[,.!?]|$)/g, '')
    .replace(/\s+([,.!?])/g, '$1').replace(/^[\s,.-]+/, '').replace(/\s{2,}/g, ' ').trim();

// A name the film has given something: a capitalised word in the middle of a line, which is where products, people
// and places live. The first word of a line is capitalised because it is the first word.
const COMMON = new Set(['i', 'the', 'a', 'an', 'you', 'your', 'we', 'our', 'it', 'they', 'monday', 'tuesday',
  'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december', 'ai', 'ceo', 'cto', 'vc', 'us', 'uk', 'eu']);
// A capital letter is not evidence of anything: a model writes its headings in Title Case, so "Instant Launch Film"
// is three capitals and no names in it, and the first word of every sentence has one too. What a made-up product is
// called, on the other hand, is almost always two words pushed together — TractionCheck, CardCanvas, WireCanvas —
// and that shape belongs to nothing else in English.
const MADE_NAME = /^\p{Lu}\p{Ll}+\p{Lu}\p{L}*$/u;
export function namesIn(text?: string): string[] {
  return [...new Set((text ?? '').split(/\s+/)
    .map((one) => one.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((one) => MADE_NAME.test(one) && !COMMON.has(one.toLowerCase())))];
}

// The names a film has given things that nobody wired to it gave them. A product with a README is allowed its own
// name and the founder's brief is allowed the names in it; everything else is a company the film made up, and a
// wordmark is exactly where one goes.
export function madeUpNames(scene: Scene, sources: Sources): string[] {
  const known = (name: string) => {
    const word = name.toLowerCase();
    return sources.corpus.includes(word) || sources.brief.includes(word);
  };
  return [...new Set(claimsOf(scene).flatMap((one) => namesIn(one)))].filter((one) => !known(one));
}

// Everything on one scene that a viewer would take as a statement of fact.
export const claimsOf = (scene: Scene): string[] =>
  [scene.heading, scene.text, ...(scene.bullets ?? []), scene.say].filter((one): one is string => !!one?.trim());

// The everyday words of the language, which say nothing in particular about anybody. "Investors want a real problem
// and a team that ships" is made of these; "live cursor tracking" is not. This is the line between a film saying
// something general, which it may, and a film saying something specific, which it has to be able to point at.
const PLAIN = new Set(['about', 'add', 'adds', 'after', 'again', 'against', 'ago', 'ahead', 'all', 'almost', 'already',
  'also', 'always', 'another', 'answer', 'answers', 'any', 'anybody', 'anyone', 'anything', 'apart', 'around', 'ask',
  'asked', 'asks', 'away', 'back', 'bad', 'become', 'becomes', 'been', 'before', 'begin', 'behind', 'being', 'below',
  'best', 'better', 'between', 'big', 'bigger', 'both', 'bring', 'brings', 'build', 'builds', 'built', 'business',
  'busy', 'buy', 'buys', 'call', 'called', 'calls', 'came', 'cannot', 'care', 'carry', 'case', 'cases', 'catch',
  'caught', 'change', 'changed', 'changes', 'cheap', 'check', 'checked', 'checks', 'choice', 'choose', 'clear',
  'close', 'closes', 'come', 'comes', 'coming', 'company', 'companies', 'cost', 'costs', 'could', 'customer',
  'customers', 'cut', 'cuts', 'day', 'days', 'deal', 'deals', 'decide', 'decides', 'decision', 'decisions', 'did',
  'difference', 'different', 'does', 'doing', 'done', 'door', 'down', 'each', 'early', 'easier', 'easy', 'else',
  'end', 'ends', 'enough', 'even', 'ever', 'every', 'everybody', 'everyone', 'everything', 'exactly', 'eye', 'eyes',
  'face', 'fact', 'fail', 'fails', 'fair', 'fall', 'far', 'fast', 'faster', 'feel', 'feels', 'few', 'find', 'finds',
  'first', 'fit', 'fits', 'follow', 'follows', 'forget', 'found', 'founder', 'founders', 'free', 'friend', 'from',
  'front', 'full', 'game', 'gave', 'get', 'gets', 'getting', 'give', 'gives', 'goes', 'going', 'gone', 'good',
  'great', 'group', 'grow', 'grows', 'growth', 'had', 'half', 'hand', 'hands', 'happen', 'happens', 'hard',
  'harder', 'has', 'have', 'having',
  'head', 'hear', 'heard', 'help', 'helps', 'high', 'hold', 'holds', 'home', 'hour', 'hours', 'idea', 'ideas',
  'idle', 'important', 'inside', 'instead', 'into', 'investor', 'investors', 'job', 'jobs', 'keep', 'keeps', 'kind',
  'knew', 'know', 'knows',
  'large', 'last', 'late', 'later', 'lead', 'leads', 'learn', 'least', 'leave', 'leaves', 'left', 'less', 'let',
  'life', 'light', 'like', 'line', 'lines', 'list', 'lists', 'little', 'live', 'lives', 'long', 'longer', 'look',
  'looks', 'lose', 'loses', 'lost', 'lot', 'love', 'low', 'made', 'make', 'makes', 'making', 'man', 'many', 'market',
  'matter', 'matters', 'maybe', 'mean', 'means', 'meet', 'meeting', 'meetings', 'meets', 'might', 'mind', 'minute',
  'minutes', 'miss', 'moment', 'money', 'month', 'months', 'more', 'morning', 'most', 'move', 'moves', 'much',
  'must', 'name', 'names', 'near', 'need', 'needs', 'never', 'new', 'news', 'next', 'nice', 'night', 'nobody',
  'none', 'nothing', 'now', 'number', 'numbers', 'off', 'offer', 'offers', 'often', 'old', 'once', 'one', 'only',
  'open', 'opens', 'order', 'other', 'others', 'over', 'own', 'owns', 'part', 'parts', 'pay', 'pays', 'people',
  'person', 'pick', 'picks', 'place', 'plan', 'plans', 'play', 'point', 'points', 'poor', 'price', 'prices',
  'probably', 'problem', 'problems', 'product', 'products', 'put', 'puts', 'question', 'questions', 'quick',
  'quickly', 'quite', 'rather', 'reach', 'read', 'reads', 'ready', 'real', 'really', 'reason', 'reasons', 'rest',
  'result', 'results', 'right', 'room', 'rooms', 'run', 'runs', 'said', 'same', 'save', 'saves', 'saw', 'say',
  'says', 'second', 'seconds', 'see', 'seen', 'sell', 'sells', 'send', 'sends', 'sent', 'set', 'sets', 'shall',
  'ship', 'ships', 'short', 'should', 'show', 'shows', 'side', 'simple', 'since', 'sit', 'sits', 'slow', 'small',
  'staff', 'startup', 'startups', 'traction', 'revenue', 'funding', 'pitch', 'deck', 'sales', 'office', 'brand',
  'email', 'phone', 'user', 'users', 'client', 'clients',
  'smart', 'some', 'somebody', 'someone', 'something', 'sometimes', 'soon', 'sort', 'sound', 'sounds', 'speak',
  'spend', 'spends', 'spent', 'stand', 'start', 'started', 'starts', 'stay', 'step', 'steps', 'still', 'stop',
  'stops', 'story', 'stories', 'strong', 'such', 'sure', 'take', 'taken', 'takes', 'talk', 'talks', 'team', 'teams',
  'tell', 'tells', 'than', 'thing', 'things', 'think', 'thinks', 'though', 'thought', 'three', 'through', 'time',
  'times', 'today', 'together', 'told', 'too', 'took', 'top', 'toward', 'true', 'try', 'tries', 'turn', 'turns',
  'twice', 'two', 'under', 'until', 'upon', 'use', 'used', 'uses', 'using', 'wait', 'walk', 'want', 'wanted',
  'wants', 'watch', 'water', 'way', 'ways', 'week', 'weeks', 'well', 'went', 'were', 'what', 'whatever', 'when',
  'where', 'whether', 'which', 'while', 'who', 'whole', 'whose', 'why', 'will', 'wins', 'win', 'wish', 'with',
  'within', 'without', 'woman', 'wonder', 'word', 'words', 'work', 'worked', 'works', 'world', 'worse', 'worst',
  'worth', 'would', 'write', 'writes', 'wrong', 'year', 'years', 'yet', 'your', 'yours']);

// The words in a line that are nobody's but this film's: not everyday English, not in the material, not in the
// brief. One of these is what makes a line a specific claim — "cursor", "clutter", "synergy" — and a specific claim
// is the kind that has to be able to point at where it came from.
export function ownWords(text: string, sources: Sources): string[] {
  // `flat` keeps the full stop, because "3.5" needs it; a word at the end of a sentence does not.
  const said = flat(text ?? '').split(' ').map((one) => one.replace(/^\.+|\.+$/g, ''))
    .filter((one) => one.length > 2 && !/[\d%$£€]/.test(one) && !STOP.has(one) && !PLAIN.has(one) && !PLAIN.has(one.replace(/s$/, '')));
  const known = (word: string) => {
    const stem = word.length > 5 ? word.slice(0, -1) : word;
    return sources.corpus.includes(stem) || sources.brief.includes(stem);
  };
  return [...new Set(said.filter((one) => !known(one)))];
}

// A wordmark is the product's name and a title card is the film's own; what those may say is settled by whether the
// film has a product behind it at all. Everything else has to trace — including the close, because "Download now,
// Cubicle Site" is a website and a download that do not exist, and asking somebody to go somewhere that is not
// there is the one lie a founder cannot afford. A line made of everyday words is a line about the world and the
// film may say it; a line with this film's own vocabulary in it is a claim.
const NO_CLAIM = new Set(['logo', 'title']);
export function ungrounded(scene: Scene, sources: Sources): string | null {
  if (!sources.has) return null;
  if (NO_CLAIM.has(scene.layout)) return null;
  const onScreen = [scene.heading, scene.text, ...(scene.bullets ?? [])].filter(Boolean).join('. ');
  if (!onScreen.trim() && !scene.say?.trim()) return null;
  if (saysIt(scene.source ?? '', sources)) return null;
  // Each line on its own, because a list of three is three claims and one of them being real is not enough.
  const lines = [scene.heading, scene.text, ...(scene.bullets ?? []), scene.say]
    .filter((one): one is string => !!one?.trim());
  for (const line of lines) {
    if (!ownWords(line, sources).length) continue;
    if (saysIt(line, sources)) continue;
    return line;
  }
  return null;
}


// The words a scene puts on screen that neither the film's own narration nor the brief or material says. Journey 15's
// film set "Same day local pickup available" over a script that never mentions pickup: the scene pointed at a real
// sentence of the brief (`source`), and that was enough for `ungrounded` to let the whole scene through. A caption is
// the script's own line, or a phrase of the brief's, and nothing else; a wordmark is the product's name and is exempt.
// What a list or a card calls itself ("The checklist", "How it works") is a label rather than a claim.
const LABELS = 'checklist steps step list recap summary overview agenda how work works before after today options follow more';
export function unscripted(scene: Scene, script: string, sources: Sources): string[] {
  if (scene.layout === 'logo') return [];
  const heard: Sources = { ...sources, corpus: `${sources.corpus} ${flat(script ?? '')} ${LABELS}` };
  return [scene.heading, scene.text, ...(scene.bullets ?? [])]
    .filter((one): one is string => !!one?.trim())
    .filter((line) => !line.trim().startsWith('@') && !fromBrief(line, sources) && (
      ownWords(line, heard).some((word) => !heard.corpus.includes(root(word)) && !heard.brief.includes(root(word)))
      // Everyday words are claims too when most of a caption is made of them: "printed next door in hours" is a
      // promise about speed nobody made.
      || meaningOf(line).filter((word) => heard.corpus.includes(word) || heard.brief.includes(word)).length < ENOUGH_OF_IT * meaningOf(line).length));
}

// --- the founder's own lines, and what may stand in for a line that was not ---------------------------------------
//
// The site's hero film was asked to "end on the promise". The director wrote the promise, with a word or two of its own
// in it; the truth pass could not point at those words, and put in its place the first unused sentence of the README,
// which was about something else entirely. The film lost the one line the founder had asked it to end on.
//
// Two rules came out of that. A line that is the founder's — in the brief as written, or most of it one sentence of
// the brief said again — is theirs, and nothing replaces it. And a line that does have to go is replaced only by a
// sentence of the material about the same thing: one that shares a thing with it (a noun, not a word like "make"),
// out of the part of the material the scene pointed at when it has a quotation behind it.

// The words of a line that carry its meaning, in one form each: "leaves" and "leave" are the same word.
const meaningOf = (text: string): string[] => flat(text ?? '').split(' ').map((one) => one.replace(/^\.+|\.+$/g, ''))
  .filter((one) => one.length > 2 && !STOP.has(one) && !/\d/.test(one)).map(root);
const root = (word: string): string => word.replace(/(?:ing|ed|es|s)$/, '').replace(/e$/, '');

// Whether a line is the founder's: written in the brief as it stands, or made of the brief — most of the words that
// carry its meaning (60%) are the words of one of its sentences.
export function fromBrief(line: string, sources: Pick<Sources, 'brief' | 'said'>): boolean {
  const said = flat(line ?? '').replace(/[.]+$/, '');
  if (said.length >= 6 && sources.brief.includes(said)) return true;
  const mine = [...new Set(meaningOf(line))];
  if (mine.length < 2) return false;
  return (sources.said ?? []).some((sentence) => {
    const theirs = new Set(meaningOf(sentence));
    return mine.filter((word) => theirs.has(word)).length / mine.length >= ENOUGH_OF_IT;
  });
}

// Whether a line says most of another: at least 60% of the other's meaning-carrying words are in it. It is how a line
// the founder pinned ("end on: nothing leaves the machine") is found in a storyboard that said it its own way.
export function saysMostOf(line: string, of: string): boolean {
  const wanted = [...new Set(meaningOf(of))];
  if (!wanted.length) return false;
  const mine = new Set(meaningOf(line));
  return wanted.filter((word) => mine.has(word)).length / wanted.length >= ENOUGH_OF_IT;
}

// The things a line is about: the words that carry meaning and are not everyday verbs, adverbs or the plain words
// every sentence has. "approve every output, and nothing leaves your computer" is about an output and a computer.
export function thingsIn(text: string): string[] {
  return [...new Set(flat(text ?? '').split(' ').map((one) => one.replace(/^\.+|\.+$/g, ''))
    .filter((one) => one.length > 2 && !STOP.has(one) && !PLAIN.has(one) && !PLAIN.has(one.replace(/s$/, ''))
      && !/\d/.test(one) && !/(?:ly|ing|ed)$/.test(one))
    .map(root))];
}

// A real sentence out of the material, to put where an invented one was. Each is used once, so a film that loses
// three claims does not get the same line back three times — and it has to be about what the dropped line was about.
// With a line to replace, only a sentence that shares a thing with it will do, the ones nearest the scene's own
// quotation first; with none that does, there is no replacement, and the scene is the critic's to drop or keep.
export function realLine(sources: Sources, used: Set<string>, dropped?: { line: string; source?: string }): string | null {
  if (!dropped) {
    for (const line of sources.lines) {
      if (used.has(line)) continue;
      used.add(line);
      return line;
    }
    return null;
  }
  const things = new Set(thingsIn(dropped.line));
  const near = new Set(meaningOf(dropped.source ?? ''));
  const ranked = sources.lines
    .map((line, order) => {
      const theirs = meaningOf(line);
      const shared = thingsIn(line).filter((word) => things.has(word)).length;
      return { line, order, shared, near: theirs.filter((word) => near.has(word)).length };
    })
    .filter((one) => !used.has(one.line) && one.shared > 0)
    .sort((a, b) => b.near - a.near || b.shared - a.shared || a.order - b.order);
  const best = ranked[0]?.line;
  if (!best) return null;
  used.add(best);
  return best;
}
