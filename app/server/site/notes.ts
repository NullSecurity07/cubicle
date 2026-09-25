import { SECTION_NAMES, type Section, type SectionKind } from '../../shared/site.ts';

// Notes on a page, read the way the deck reads notes on slides: the plain ones without asking anybody, and a note that
// asks for new words in one section handed on as a rewrite of that section alone. Sections are named by what they
// are ("the hero", "pricing", "how it works"), because that is how a founder looks at a page.
export type SiteEdit =
  | { kind: 'drop'; id: string }
  | { kind: 'move'; id: string; before?: string; after?: string; to?: 'top' | 'end' }
  | { kind: 'swap'; a: string; b: string }
  | { kind: 'headline'; id: string; text: string }
  | { kind: 'button'; text: string }
  | { kind: 'rewrite'; id: string; ask: string };
export type ReadNotes = { edits: SiteEdit[]; unread: string[] };

// What a founder calls each section. "how it works" before "how", so the longer name wins.
const NAMES: [RegExp, SectionKind][] = [
  [/\bhero\b|\bheader\b|\btop section\b/i, 'hero'],
  [/\bproblem\b|\bpain\b/i, 'problem'],
  [/\bhow it works\b|\bhow\b|\bsteps\b/i, 'how'],
  [/\bproof\b|\btestimonials?\b|\bsocial proof\b/i, 'proof'],
  [/\bpricing\b|\bprices?\b|\bplans?\b/i, 'pricing'],
  [/\bfaqs?\b|\bquestions\b/i, 'faq'],
  [/\bcta\b|\bcall to action\b|\bclosing\b|\bending\b|\blast section\b/i, 'cta'],
];
const NAME = '(hero|header|problem|pain|how it works|how|steps|proof|testimonials?|pricing|prices?|plans?|faqs?|questions|cta|call to action|closing|ending)';
// The section named first in the note: "pricing: say how much" is about pricing, not about how it works.
export function kindOf(text: string): SectionKind | null {
  let best: { at: number; kind: SectionKind } | null = null;
  for (const [pattern, kind] of NAMES) {
    const at = pattern.exec(text)?.index;
    if (at !== undefined && (!best || at < best.at)) best = { at, kind };
  }
  return best?.kind ?? null;
}

export const splitNotes = (notes: string): string[] =>
  notes.split(/[.;\n]+(?=\s|$)|,\s*(?=(?:and\s+)?(?:drop|remove|cut|move|swap|make|rewrite|change|add|put|give|say|use|the|button|shorter|longer|hero|problem|proof|pricing|faqs?|cta)\b)|\s+and\s+(?=(?:drop|remove|cut|move|swap)\b)/i)
    .map((one) => one.trim()).filter(Boolean);

export function readNotes(notes: string, sections: Section[]): ReadNotes {
  const edits: SiteEdit[] = [];
  const unread: string[] = [];
  const idOf = (text: string) => { const kind = kindOf(text); return kind ? sections.find((section) => section.kind === kind)?.id : undefined; };
  const missing = (note: string, text: string) => unread.push(`${note} (there is no ${kindOf(text) ? SECTION_NAMES[kindOf(text)!].toLowerCase() : 'such'} section)`);

  for (const note of splitNotes(notes)) {
    const text = note.replace(/^(?:and|then|also|please)\s+/i, '').replace(/^the\s+/i, '');
    let match: RegExpExecArray | null;
    if ((match = new RegExp(`^(?:drop|remove|delete|cut)\\s+(?:the\\s+)?${NAME}(?:\\s+section)?\\s*$`, 'i').exec(text))) {
      const id = idOf(match[1]);
      if (id) edits.push({ kind: 'drop', id }); else missing(note, match[1]);
    } else if ((match = new RegExp(`^move\\s+(?:the\\s+)?${NAME}(?:\\s+section)?\\s+(?:to\\s+the\\s+)?(top|end|bottom|before|after|above|below)(?:\\s+(?:the\\s+)?${NAME})?`, 'i').exec(text))) {
      const id = idOf(match[1]);
      const where = match[2].toLowerCase();
      const other = match[3] ? idOf(match[3]) : undefined;
      if (!id) missing(note, match[1]);
      else if (where === 'top') edits.push({ kind: 'move', id, to: 'top' });
      else if (where === 'end' || where === 'bottom') edits.push({ kind: 'move', id, to: 'end' });
      else if (!other) missing(note, match[3] ?? '');
      else edits.push({ kind: 'move', id, ...(where === 'before' || where === 'above' ? { before: other } : { after: other }) });
    } else if ((match = new RegExp(`^swap\\s+(?:the\\s+)?${NAME}\\s+(?:and|with)\\s+(?:the\\s+)?${NAME}`, 'i').exec(text))) {
      const [a, b] = [idOf(match[1]), idOf(match[2])];
      if (a && b) edits.push({ kind: 'swap', a, b }); else unread.push(`${note} (there is no such section)`);
    } else if ((match = /^(?:the\s+)?(?:button|cta button)\s*(?:text\s*)?(?:to|should say|says|:|=)\s*["“']?(.+?)["”']?$/i.exec(text))) {
      edits.push({ kind: 'button', text: match[1].trim() });
    } else if ((match = new RegExp(`^(?:the\\s+)?${NAME}(?:\\s+section)?\\s*[:,]?\\s*(?:new\\s+)?(?:headline|title)\\s*(?:to|should be|:|=)\\s*["“']?(.+?)["”']?$`, 'i').exec(text))) {
      const id = idOf(match[1]);
      if (id) edits.push({ kind: 'headline', id, text: match[2].trim() }); else missing(note, match[1]);
    } else if (kindOf(text)) {
      // Anything else about one section is new words for that section, and only that one.
      const id = idOf(text);
      if (id) edits.push({ kind: 'rewrite', id, ask: text }); else missing(note, text);
    } else unread.push(note);
  }
  return { edits, unread };
}

// The plain edits, done. A rewrite is left for the caller. `touched` is every section whose words changed, by id.
export function applyEdits(sections: Section[], edits: SiteEdit[]): { sections: Section[]; touched: Set<string>; said: string[] } {
  let out = sections.map((section) => ({ ...section, lines: [...section.lines] }));
  const touched = new Set<string>();
  const said: string[] = [];
  const name = (id: string) => { const kind = sections.find((section) => section.id === id)?.kind; return kind ? SECTION_NAMES[kind].toLowerCase() : 'section'; };
  for (const edit of edits) {
    if (edit.kind === 'drop') {
      if (!out.some((section) => section.id === edit.id)) continue;
      out = out.filter((section) => section.id !== edit.id);
      said.push(`dropped the ${name(edit.id)}`);
    } else if (edit.kind === 'move') {
      const at = out.findIndex((section) => section.id === edit.id);
      if (at < 0) continue;
      const [section] = out.splice(at, 1);
      const anchor = out.findIndex((one) => one.id === (edit.before ?? edit.after));
      const to = edit.to === 'top' ? 0 : edit.to === 'end' ? out.length : anchor < 0 ? at : edit.before ? anchor : anchor + 1;
      out.splice(to, 0, section);
      said.push(`moved the ${name(edit.id)}${edit.to ? ` to the ${edit.to}` : ` ${edit.before ? 'before' : 'after'} the ${name((edit.before ?? edit.after)!)}`}`);
    } else if (edit.kind === 'swap') {
      const a = out.findIndex((section) => section.id === edit.a);
      const b = out.findIndex((section) => section.id === edit.b);
      if (a < 0 || b < 0) continue;
      [out[a], out[b]] = [out[b], out[a]];
      said.push(`swapped the ${name(edit.a)} and the ${name(edit.b)}`);
    } else if (edit.kind === 'headline') {
      const section = out.find((one) => one.id === edit.id);
      if (!section) continue;
      section.headline = edit.text;
      touched.add(section.id);
      said.push(`new headline on the ${name(edit.id)}`);
    } else if (edit.kind === 'button') {
      for (const section of out) if (section.button !== undefined) { section.button = edit.text; touched.add(section.id); }
      said.push(`the button now says "${edit.text}"`);
    }
  }
  return { sections: out, touched, said };
}
