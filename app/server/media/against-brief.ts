import { content, type Scene } from './spec.ts';
import { trimTo } from './wording.ts';
import type { Sources } from './grounding.ts';

// The sentences a film is held to: what the product is and does, then everything else the material says.
export const factsIn = (sources: Sources): string[] => [...new Set([...(sources.facts ?? []), ...sources.lines])];

// Whether a line of a film says the product works the way the brief says it does not.
//
// Journey 14's film for Callback, whose brief says it "offers them a slot in the practice calendar by text message"
// and "answers every voicemail with a booking offer by text within minutes", said "Staff members send instant text
// message replies directly from the main dashboard" over a steps card reading "Tap quick reply button / Send instant
// text message". Every word of it was plausible and the founder could not show it: the product's whole point is that
// nobody at the desk replies.
//
// Reading two sentences for contradiction in general takes a model. This one shape does not, and it is the shape a
// model reaches for whenever it describes software it has not seen: the brief has the product do the answering, and
// the line hands the answering to a person. The facts are the material's sentences; the product is the name the brief
// opens its sentences with (or "it").

// Answering the caller: every way a brief or a film says the product (or somebody) gets back to them.
const ANSWERS = /\b(?:repl(?:y|ies|ied|ying)|respond(?:s|ed|ing)?|answer(?:s|ed|ing)?|text(?:s|ed|ing)?\s+(?:back|them|the|patients?|callers?|customers?)|sends?|sent|sending|offers?|offered|offering|books?|booked|booking|call(?:s|ed|ing)?\s+back|follow(?:s|ed|ing)?\s+up|schedul\w+|confirm\w*)\b/i;
// A person at the business doing it.
const BY_HAND = /\b(?:staff(?:\s+members?)?|receptionists?|front[- ]desk\s+(?:staff|team|person|workers?)|employees?|(?:your|the)\s+team|assistants?|someone|somebody|you|yourself|by hand|manually|tap|taps|tapping|click|clicks|clicking|press|presses)\b/i;
const OPENERS = new Set(['it', 'the', 'we', 'our', 'this', 'a', 'an', 'and', 'but', 'so', 'what', 'everyone', 'small', 'one', 'goal', 'stage', 'how', 'price', 'cash']);

// The product's name: a capitalised word that opens at least two of the facts' sentences.
export function productName(facts: string[]): string | null {
  const counts = new Map<string, number>();
  for (const one of facts) {
    const first = /^\s*(?:[-*]\s*)?(?:what the company does:\s*)?([A-Z][A-Za-z0-9]+)\b/i.exec(one)?.[1];
    if (!first || OPENERS.has(first.toLowerCase()) || first[0] !== first[0].toUpperCase()) continue;
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : null;
}

// The facts in which the product itself does the answering.
export function answersItself(facts: string[]): string[] {
  const name = productName(facts);
  return facts.filter((one) => {
    const hit = ANSWERS.exec(one);
    if (!hit) return false;
    const before = one.slice(0, hit.index).replace(/^\s*(?:[-*]\s*)?(?:what the company does:\s*)?/i, '');
    const actor = before.trim().split(/\s+/)[0] ?? '';
    return (name !== null && actor === name) || /^(?:it|the\s+(?:app|product|platform|tool|service|system))$/i.test(actor)
      || (name !== null && new RegExp(`^${name}\\b`).test(before.trim()) && !BY_HAND.test(before));
  });
}

export type Contradiction = { line: string; fact: string };

// Whether a line hands to a person what the facts have the product do. A list's line may be an order to the viewer
// ("Send instant text message"), which is a person doing it too.
export function handsItToSomebody(line: string, list = false): boolean {
  const hit = ANSWERS.exec(line ?? '');
  if (!hit) return false;
  const before = line.slice(0, hit.index);
  if (BY_HAND.test(before)) return true;
  if (/\b(?:by hand|manually)\b/i.test(line)) return true;
  if (/\b(?:tap|click|press)\w*\b.*\b(?:repl\w*|send\w*|respond\w*)\b/i.test(line)) return true;
  // An order to the viewer: the verb as it is given, first in the line ("Send instant text message"), not as it is
  // reported ("Offers them a slot", which is the product doing it).
  return list && !before.trim() && /^(?:reply|respond|answer|text|send|offer|book|call|follow|schedule|confirm)$/i.test(hit[0].split(/\s+/)[0]);
}

// Every line of a scene that contradicts the facts, with the fact it contradicts (the one sharing the most words).
export function contradictions(scene: Scene, facts: string[]): Contradiction[] {
  const own = answersItself(facts);
  if (!own.length) return [];
  // A list's bare orders are somebody's steps only when the list is plainly a person's: one of its steps has a person
  // or a finger in it, or so does the line said over it. "Transcribe voicemail / Offer open slots" is the product's.
  const steps = scene.bullets ?? [];
  const persons = steps.some((one) => handsItToSomebody(one) || /^(?:tap|click|press|review|open|check|read|log in|type)\b/i.test(one.trim()))
    || (!!scene.say && handsItToSomebody(scene.say));
  const listed = ['steps', 'checklist', 'bullets'].includes(scene.layout) && persons;
  const lines = [
    ...[scene.say, scene.text, scene.heading].filter((one): one is string => !!one?.trim()).map((one) => ({ one, list: false })),
    ...(scene.bullets ?? []).map((one) => ({ one, list: listed })),
  ];
  return lines.filter(({ one, list }) => handsItToSomebody(one, list)).map(({ one }) => ({ line: one, fact: nearest(one, own) }));
}

const nearest = (line: string, facts: string[]): string => {
  const mine = new Set(content(line));
  return [...facts].sort((a, b) => content(b).filter((word) => mine.has(word)).length - content(a).filter((word) => mine.has(word)).length)[0];
};

// The fact as a line to say: the product named where the brief wrote "it", without the brief's own label.
export function factLine(fact: string, facts: string[]): string {
  const name = productName(facts);
  return fact.replace(/^\s*(?:[-*]\s*)?(?:what the company does:\s*)?/i, '').replace(/^It\b/, name ?? 'It').trim();
}

// The fact as two to four short steps: its clauses, each cut where it starts saying when or how.
export function factSteps(fact: string, facts: string[]): string[] {
  const name = productName(facts);
  return factLine(fact, facts).replace(/[.!?]+$/, '').split(/,\s*(?:and\s+)?|\s+and\s+/)
    .map((one) => one.replace(new RegExp(`^(?:${name ?? 'It'}|It)\\s+`), '').split(/\s+(?:after|while|or|within|from|for|in the)\s+/)[0].trim())
    .filter((one) => one.split(/\s+/).length >= 2)
    .map((one) => trimTo(one.charAt(0).toUpperCase() + one.slice(1), 6))
    .slice(0, 4);
}
