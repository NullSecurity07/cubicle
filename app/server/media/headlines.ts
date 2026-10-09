import { content, countWords, echoes, HEADING_WORDS, saysWhatItShows, type Scene } from './spec.ts';
import { CODEY } from './wording.ts';

// A headline is never the captions again.
//
// The site's hero film opened on "Wire them to what they may read" set large, with "Wire them to what they may read,
// and they draft, research." captioned word by word under it: the same words twice on one frame, a beat apart. The
// old echo rule asked only whether the screen wrote out *most of the line*, and a headline cut from the opening of a
// long line never does — so the captions stayed on, under a headline made of their own first words.
//
// The test is the other way round: how much of the *headline* is words the captions are about to say. Most of it,
// and the frame says one thing twice. Unless the captions are hushed for that scene (its words already are the whole
// line, which is a hook or a close set large), the headline is put right: another phrase of the founder's own, out of
// the brief first and then the material, that is about the same thing without being the same words; or, when there is
// none, no headline at all, because the captions carry the line.

// The layouts whose words are not a headline over the line: a figure, a quotation, a wordmark, somebody speaking.
const NOT_A_HEADLINE = new Set(['stat', 'quote', 'logo', 'presenter', 'chart']);

// Whether a scene's heading or text repeats the caption words spoken under it. Names which field does.
export function repeatsCaptions(scene: Scene, captions: boolean): 'text' | 'heading' | null {
  if (!captions || !scene.say?.trim() || NOT_A_HEADLINE.has(scene.layout)) return null;
  // The captions are hushed where the scene already writes out the whole line, so nothing is said twice there.
  if (saysWhatItShows(scene)) return null;
  for (const field of ['text', 'heading'] as const) {
    const line = scene[field]?.trim();
    if (line && content(line).length && Math.max(echoes(line, scene.say), echoesStem(line, scene.say)) >= 0.6) return field;
  }
  return null;
}

// Phrases the founder wrote that could stand as a headline: the clauses of the brief, then of the material, of two to
// seven words, leaving out the brief's directions to the film itself ("show the product itself", "calm and confident").
const DIRECTION = /\b(?:film|video|reel|clip|seconds?|explain\w*|introduc\w*|describe|present|promo|teaser|trailer|demo|marketing|website|web ?site|sound|music|captions?|scenes?|shots?|brief|calm|confident|punchy|show|end|close|open|top of|made to|understood|look|style|voice|narrat\w*|call[- ]to[- ]action|cta)\b/i;
// Two tiers, the brief's first: a phrase out of the material is used only when no phrase of the brief will do.
export type Phrases = { brief: string[]; lines: string[] };
export function phrasesOf(brief: string, lines: string[] = []): Phrases {
  const clauses = (body: string) => body.split(/[.;:!?,—–()\n]+|\s-\s/)
    .map((one) => one.trim().replace(/^(?:and|so|but|or|then|because)\s+/i, '').replace(/["“”']/g, '').trim())
    .filter((one) => countWords(one) >= 2 && countWords(one) <= HEADING_WORDS && content(one).length >= 1
      && !DIRECTION.test(one) && !CODEY.test(one) && !/\breadme\b/i.test(one) && /^[\p{L}]/u.test(one)
      && !bossy(one) && !nameAlone(one));
  const fromBrief = [...new Set(clauses(brief))];
  return { brief: fromBrief, lines: [...new Set(lines.flatMap(clauses))].filter((one) => !fromBrief.includes(one)) };
}

// A headline that tells the viewer to do something nobody in the film says. Journey 20 set "Visit a repair café
// every week" over "Visitors book a repair slot online": the team's own habit, out of the brief's "How we work",
// read as an order to the viewer and a claim the film never made. And "Explain FixSlot", the ask's own words, was
// set as a headline. A clause that opens on a bare verb before its object is an order, not a line of the film.
const ORDERS = new Set(['explain', 'visit', 'meet', 'discover', 'try', 'see', 'watch', 'learn', 'ship', 'join', 'start',
  'get', 'make', 'find', 'book', 'call', 'order', 'sign', 'download', 'buy', 'stop', 'imagine', 'think', 'let', 'take',
  'give', 'use', 'keep', 'bring', 'come', 'go', 'ask', 'check', 'choose', 'pick', 'save', 'skip', 'forget', 'tell',
  'show', 'say', 'introduce', 'describe', 'present', 'write', 'build', 'grab', 'claim', 'reserve', 'schedule', 'fix']);
const OBJECT_NEXT = new Set(['a', 'an', 'the', 'your', 'our', 'their', 'my', 'his', 'her', 'every', 'each', 'this', 'these',
  'those', 'it', 'them', 'us', 'me', 'more', 'less', 'up', 'out']);
const NOT_A_VERB = new Set(['a', 'an', 'the', 'every', 'each', 'all', 'some', 'no', 'one', 'two', 'three', 'everyone', 'nobody',
  'somebody', 'someone', 'it', 'they', 'we', 'you', 'i', 'he', 'she', 'this', 'that', 'these', 'those', 'today', 'now', 'then',
  'here', 'there', 'most', 'many', 'few', 'only', 'just', 'even', 'also', 'never', 'always']);
export function bossy(line: string): boolean {
  const [first, next] = line.trim().toLowerCase().replace(/[^\p{L}\s'-]/gu, ' ').split(/\s+/);
  if (!first) return false;
  if (ORDERS.has(first)) return true;
  // A plural ("volunteers fix", "cafés get") or a name is somebody doing it, not an order.
  if (!next || NOT_A_VERB.has(first) || /(?:s|ing|ed|ly)$/.test(first)) return false;
  return OBJECT_NEXT.has(next) && !/\p{Lu}/u.test(line.trim().split(/\s+/)[0].slice(1));
}
// The product's name and nothing else to say: "FixSlot", "FixSlot Explainer".
const MADE_NAME = /^\p{Lu}[\p{L}\p{N}]*\p{Lu}[\p{L}\p{N}]*$/u;
export const nameAlone = (line: string): boolean =>
  !content(line).filter((word) => !line.split(/\s+/).some((one) => MADE_NAME.test(one.replace(/[^\p{L}\p{N}]/gu, '')) && one.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === word)).length;
// A headline off the script: an order the scene's own line does not give ("Visit a repair café every week" over
// "Visitors book a repair slot online"), the brief's direction to the film ("Explain FixSlot"), or the product's name
// alone. A headline is a line of the film, so the words being said under it are what it may order.
export function offScript(headline: string, say = ''): boolean {
  const line = headline.trim();
  if (!line) return false;
  if (nameAlone(line) || /^(?:explain\w*|introduc\w*|describe|present)\b/i.test(line)) return true;
  if (!bossy(line)) return false;
  const verb = stem(line.toLowerCase().split(/\s+/)[0].replace(/[^\p{L}]/gu, ''));
  return !content(say).map(stem).includes(verb);
}

// One form of a word: "wires", "wire", "wired" and "wiring" are one word to a viewer reading a frame.
export const stem = (word: string): string => word.replace(/(?:ing|ed|s)$/, '').replace(/e$/, '');
// How much a phrase is about the line, in shared stems: "wires are access" is about "wire them to what they may read".
const about = (phrase: string, line: string): number => {
  const theirs = new Set(content(line).map(stem));
  return content(phrase).map(stem).filter((word) => theirs.has(word)).length;
};
// How much of a headline is the line's own words, in any of their forms: "They draft" over "…beside me, drafting" is
// the caption again.
export const echoesStem = (headline: string, line: string): number => {
  const mine = content(headline).map(stem);
  return mine.length ? about(headline, line) / mine.length : 0;
};

const capital = (line: string) => line.charAt(0).toUpperCase() + line.slice(1);

// A headline for a scene out of the founder's phrases: about the same thing as the line, not the line's own words,
// and not a headline another scene already carries. Nothing when no phrase will do.
export function phraseFor(say: string, phrases: Phrases, used: Set<string>): string | null {
  for (const tier of [phrases.brief, phrases.lines]) {
    const ranked = tier
      .filter((one) => !used.has(one.toLowerCase()) && echoesStem(one, say) < 0.6 && about(one, say) > 0 && !bossy(one) && !nameAlone(one))
      .map((one, order) => ({ one, score: about(one, say), order }))
      .sort((a, b) => b.score - a.score || a.order - b.order);
    if (ranked[0]) return capital(ranked[0].one);
  }
  return null;
}

// Every scene put right, with a note for the card when anything changed. A layout that cannot stand without words (a
// hook, a statement) keeps the line itself set large when it is short enough to be a headline — then the captions are
// hushed under it, and the frame still says it once.
const MUST_WRITE = new Set(['hook', 'statement', 'outro', 'cta']);
export function freshHeadlines(scenes: Scene[], captions: boolean, phrases: Phrases): { scenes: Scene[]; notes: string[] } {
  const notes: string[] = [];
  const used = new Set(scenes.flatMap((one) => [one.text, one.heading]).filter((one): one is string => !!one).map((one) => one.toLowerCase()));
  const made = scenes.map((scene, index) => {
    // The close is the founder's call to action or the product's line (`close.ts`), and an order is what a close is.
    const closing = index === scenes.length - 1 && index > 0 && (scene.layout === 'cta' || scene.layout === 'outro');
    const off = closing || NOT_A_HEADLINE.has(scene.layout) ? null : (['text', 'heading'] as const).find((one) => offScript(scene[one] ?? '', scene.say));
    const field = off ?? repeatsCaptions(scene, captions);
    if (!field) return scene;
    const was = off ? `scene headline "${scene[field]}" was not a line of the film` : `scene headline "${scene[field]}" repeated its own captions`;
    const fresh = phraseFor(scene.say ?? '', phrases, used);
    if (fresh) {
      used.add(fresh.toLowerCase());
      notes.push(`${was}, so it says "${fresh}", from your brief, instead`);
      return { ...scene, [field]: fresh, ...(field === 'text' ? { emphasis: undefined } : {}) };
    }
    const other = field === 'text' ? scene.heading : scene.text;
    if (MUST_WRITE.has(scene.layout) && !other?.trim() && countWords(scene.say) <= HEADING_WORDS) {
      notes.push(`${was}, so the whole line is set large and the captions stay quiet under it`);
      return { ...scene, [field]: scene.say!.trim().replace(/[.!]+$/, ''), emphasis: undefined };
    }
    notes.push(`${was}, so it came off and the captions carry the line`);
    return { ...scene, [field]: undefined, ...(field === 'text' ? { emphasis: undefined } : {}) };
  });
  return { scenes: made, notes };
}
