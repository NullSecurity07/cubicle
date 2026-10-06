import type { Material } from './director.ts';
import { clausesOf, flat, saysIt, type Sources } from './grounding.ts';
import { content, countWords, HEADING_WORDS, type Scene } from './spec.ts';
import { headlineOf } from './wording.ts';
import { phrasesOf, stem, type Phrases } from './headlines.ts';

// What a film ends on.
//
// The site's own hero film closed on "Try it this week". Nobody asked for that line: the director's own close named a
// website that does not exist, the truth pass threw it out, and the one fallback the critic had was a sentence that
// fits every product and so says nothing about this one. A close is the one line a viewer is left holding, so it is
// decided here, in order, out of what the founder actually gave:
//
//   1. the call to action the founder wrote into the brief, or one a wired document names as its call to action;
//   2. failing that, the product's own positioning line, the sentence it uses to say what it is;
//   3. failing that, the film's first headline, said again, so the film ends where it began.
//
// The director is told the line before it writes a beat, and the critic holds the storyboard to it afterwards.

// "call to action: "Get it free"", "close on 'See it work'", "end with “Book a call”". Only a quoted line counts:
// "end on the promise" is direction about the film, not the words it should end on.
const ASKED = /\b(?:call[- ]to[- ]action|cta|close (?:on|with)|end (?:on|with)|sign off with)\b[^"“'‘\n]{0,24}["“'‘]([^"”'’\n]{3,80})["”'’]/i;
// A wired document that says what its call to action is, on a line of its own.
const WRITTEN = /^\s*(?:[-*]\s*)?(?:call[- ]to[- ]action|cta)\s*[:\-–—]\s*["“']?([^"”'\n]{3,80}?)["”']?\s*\.?\s*$/im;

const tidy = (line: string): string => line.trim().replace(/[.!\s]+$/, '');

export function ctaInBrief(brief: string): string | undefined {
  const found = ASKED.exec(brief ?? '')?.[1];
  return found && countWords(found) <= 10 ? tidy(found) : undefined;
}

export function ctaInMaterial(material: Pick<Material, 'lines'>): string | undefined {
  for (const body of material.lines) {
    const found = WRITTEN.exec(body)?.[1];
    if (found && countWords(found) <= 10) return tidy(found);
  }
  return undefined;
}

// The line a film closes on when the founder named none: what the product says it is, cut to a headline.
export function positioningOf(material: Pick<Material, 'pitch'>): string | undefined {
  const pitch = material.pitch?.trim();
  if (!pitch) return undefined;
  const first = pitch.split(/(?<=[.!?])\s+/)[0] ?? pitch;
  const line = countWords(first) <= HEADING_WORDS ? tidy(first) : headlineOf(first, HEADING_WORDS);
  return line && countWords(line) >= 2 ? line : undefined;
}

// "End on the promise", "close on how little it costs", "finish with: nothing leaves the machine". Direction about
// what the film's last word is, which the founder may give without quoting a line. It is read here and resolved to
// one of the brief's own clauses, so the storyboard can be held to it: the line is said last, or last before the
// call to action when there is one. A quoted line is a call to action and is `ctaInBrief`'s.
const END_ON = /\b(?:end|close|finish|sign off)\s+(?:on|with)\s*:?\s+(?!(?:the|a|your)\s+(?:call[- ]to[- ]action|cta)\b)([^,.;:"“”\n]{3,60}?)\s*(?=[,.;:\n]|\s+then\b|$)/i;
// Words that point at a line rather than say it: "the promise" is a line somewhere else in the brief.
const POINTER = /^(?:the|a|your|its|our)?\s*(?:promise|point|message|claim|idea|pitch|vision|mission|benefit|payoff|punchline|line|takeaway)$/i;
// What makes a clause a promise rather than a description: it says what always or never happens.
const PROMISE = /\b(?:nothing|never|always|every|only|no|none|free|own|private|yours|guarantee[ds]?)\b/i;
const STYLE = /\b(?:calm|confident|bold|warm|punchy|upbeat|quiet|playful|serious|friendly)\b/i;

export function endOnOf(brief: string): string | undefined {
  const found = END_ON.exec(brief ?? '')?.[1]?.trim();
  if (!found) return undefined;
  // The clauses that describe the product, not the film: no direction in them, no style, not the instruction itself.
  const said = clausesOf(brief).filter((one) => !END_ON.test(one) && !STYLE.test(one) && !/\b(?:film|video|reel|seconds?|made to|understood)\b/i.test(one));
  const cap = (line: string) => line.charAt(0).toUpperCase() + line.slice(1).replace(/[.!\s]+$/, '');
  if (!POINTER.test(found)) {
    // It says the line itself, or names what the line is about: the clause of the brief that says the most of it.
    const wanted = new Set(content(found).map(stem));
    const best = said.map((one) => ({ one, hits: content(one).map(stem).filter((word) => wanted.has(word)).length }))
      .filter((one) => one.hits > 0).sort((a, b) => b.hits - a.hits)[0];
    return cap(best?.one ?? found);
  }
  // "The promise": the last thing the brief promises about the product, else the last thing it says about it.
  const promised = [...said].reverse().find((one) => PROMISE.test(one)) ?? said.at(-1);
  return promised ? cap(promised) : undefined;
}

// The close a film owes the founder, before the storyboard exists: the brief's or a document's call to action, then
// the positioning line. `asked` says whether it is a call to action the founder named, which is always used as
// written; a positioning line only replaces a close that names nothing from the brief.
export type Close = { line: string; asked: boolean };
export function closeLineOf(brief: string, material: Pick<Material, 'lines' | 'pitch'>): Close | undefined {
  const asked = ctaInBrief(brief) ?? ctaInMaterial(material);
  if (asked) return { line: asked, asked: true };
  // "End on the promise" with no call to action: the promise is the close, as the brief put it.
  const pinned = endOnOf(brief);
  if (pinned && countWords(pinned) <= 10) return { line: pinned, asked: true };
  const positioning = positioningOf(material);
  return positioning ? { line: positioning, asked: false } : undefined;
}

// Whether a closing scene names anything the founder wrote: one word of the brief that carries meaning, in any form,
// or a quotation behind it out of the brief or a wired document (a door the founder really named). A reel may close
// on what its platform offers, which is a real thing to do. "Try it this week" is none of these, and is the close
// this rule exists for.
const PLATFORM = /\b(?:follow|subscribe|save this|share this|comment)\b/i;
export function namesTheBrief(scene: Scene, sources: Sources, reel = false): boolean {
  const brief = new Set(content(sources.brief).map(stem));
  const said = content([scene.heading, scene.text, scene.say].filter(Boolean).join(' '));
  if (said.some((word) => brief.has(stem(word)))) return true;
  if (reel && PLATFORM.test(`${scene.text ?? ''} ${scene.say ?? ''}`)) return true;
  const quoted = flat(scene.source ?? '');
  return quoted.length >= 6 && saysIt(quoted, sources);
}

// The close as a scene: the line set as the close and said as written, nothing else on it.
export function closeScene(scene: Scene, line: string): Scene {
  return { ...scene, layout: scene.layout === 'outro' ? 'outro' : 'cta', text: line, say: `${line}.`, heading: undefined, bullets: undefined, image_prompt: undefined, source: line, emphasis: undefined };
}

// The headings the critic writes itself when a recast needs one. They are furniture, not the film's first headline.
const STOCK = new Set(['what you get', 'what matters', 'keep watching', 'watch this', 'follow for more', 'watch it again']);

// The film's first headline, for a close with nothing else to say.
export function firstHeadline(scenes: Scene[]): string | undefined {
  for (const scene of scenes.slice(0, -1)) {
    for (const line of [scene.text?.trim(), scene.heading?.trim()]) {
      if (line && !STOCK.has(tidy(line).toLowerCase()) && countWords(line) >= 2 && countWords(line) <= HEADING_WORDS) return tidy(line);
    }
  }
  return undefined;
}

// Whether the brief asks for real moving footage in the film ("with real footage clips of the stalls"). A film that
// is itself called a clip ("a documentary clip about a pottery class") is not asking for one inside it.
export const FOOTAGE_ASKED = /\b(?:footage|b-?roll|video clips|clips of|moving (?:shots|pictures|images))\b/i;

// Everything a critic needs out of the brief and the material beyond the truth: the close, the founder's phrases, and
// whether moving footage was asked for.
export function briefWants(material: Pick<Material, 'lines' | 'pitch'>, brief: string): { close?: Close; phrases: Phrases; endOn?: string; footage?: boolean } {
  const endOn = endOnOf(brief);
  return {
    close: closeLineOf(brief, material), phrases: phrasesOf(brief, [material.pitch ?? '', ...material.lines].filter(Boolean)),
    ...(endOn ? { endOn } : {}), ...(FOOTAGE_ASKED.test(brief ?? '') ? { footage: true } : {}),
  };
}
