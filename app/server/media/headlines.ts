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
const DIRECTION = /\b(?:film|video|reel|clip|seconds?|marketing|website|web ?site|sound|music|captions?|scenes?|shots?|brief|calm|confident|punchy|show|end|close|open|top of|made to|understood|look|style|voice|narrat\w*|call[- ]to[- ]action|cta)\b/i;
// Two tiers, the brief's first: a phrase out of the material is used only when no phrase of the brief will do.
export type Phrases = { brief: string[]; lines: string[] };
export function phrasesOf(brief: string, lines: string[] = []): Phrases {
  const clauses = (body: string) => body.split(/[.;:!?,—–()\n]+|\s-\s/)
    .map((one) => one.trim().replace(/^(?:and|so|but|or|then|because)\s+/i, '').replace(/["“”']/g, '').trim())
    .filter((one) => countWords(one) >= 2 && countWords(one) <= HEADING_WORDS && content(one).length >= 1
      && !DIRECTION.test(one) && !CODEY.test(one) && !/\breadme\b/i.test(one) && /^[\p{L}]/u.test(one));
  const fromBrief = [...new Set(clauses(brief))];
  return { brief: fromBrief, lines: [...new Set(lines.flatMap(clauses))].filter((one) => !fromBrief.includes(one)) };
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
      .filter((one) => !used.has(one.toLowerCase()) && echoesStem(one, say) < 0.6 && about(one, say) > 0)
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
  const made = scenes.map((scene) => {
    const field = repeatsCaptions(scene, captions);
    if (!field) return scene;
    const fresh = phraseFor(scene.say ?? '', phrases, used);
    if (fresh) {
      used.add(fresh.toLowerCase());
      notes.push(`scene headline "${scene[field]}" repeated its own captions, so it says "${fresh}", from your brief, instead`);
      return { ...scene, [field]: fresh, ...(field === 'text' ? { emphasis: undefined } : {}) };
    }
    const other = field === 'text' ? scene.heading : scene.text;
    if (MUST_WRITE.has(scene.layout) && !other?.trim() && countWords(scene.say) <= HEADING_WORDS) {
      notes.push('a headline repeated its own captions, so the whole line is set large and the captions stay quiet under it');
      return { ...scene, [field]: scene.say!.trim().replace(/[.!]+$/, ''), emphasis: undefined };
    }
    notes.push('a headline repeated its own captions, so it came off and the captions carry the line');
    return { ...scene, [field]: undefined, ...(field === 'text' ? { emphasis: undefined } : {}) };
  });
  return { scenes: made, notes };
}
