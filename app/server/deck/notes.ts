import { SHAPE_NAMES, SLIDE_SHAPES, type Slide, type SlideShape } from '../../shared/deck.ts';

// Notes on a deck, read the way the film editor reads notes on a film: the plain ones without asking anybody, and a
// note that asks for new words on one slide handed on as a rewrite of that slide alone. Slide numbers are the
// numbers on the version the notes were written against; each one is turned into that slide's id before anything
// moves, so "merge 2 and 3, drop 5" means the slides the founder was looking at, whatever the merge did to the count.
export type DeckEdit =
  | { kind: 'merge'; into: string; from: string }
  | { kind: 'drop'; id: string }
  | { kind: 'move'; id: string; to: number }
  | { kind: 'swap'; a: string; b: string }
  | { kind: 'headline'; id: string; text: string }
  | { kind: 'rewrite'; id: string; ask: string };
export type ReadNotes = { edits: DeckEdit[]; unread: string[] };

const VERB = '(?:merge|combine|join|drop|remove|delete|cut|move|swap|slide|the|make|add|rewrite|change|use|fix|shorten|tighten|put|give|say)';
export const splitNotes = (notes: string): string[] =>
  notes.split(new RegExp(`[.;\\n]+(?=\\s|$)|,\\s*(?=(?:and\\s+)?${VERB}\\b)|\\s+and\\s+(?=(?:merge|combine|drop|remove|delete|cut|move|swap)\\b)`, 'i'))
    .map((one) => one.trim()).filter(Boolean);

const shapeWord = new RegExp(`\\bthe\\s+(${[...SLIDE_SHAPES, 'ask'].join('|')})\\s+slide\\b`, 'i');

export function readNotes(notes: string, slides: Slide[]): ReadNotes {
  const edits: DeckEdit[] = [];
  const unread: string[] = [];
  const idAt = (number: string) => slides[Number(number) - 1]?.id;
  const byShape = (word: string) => slides.find((slide) => slide.shape === (word.toLowerCase() as SlideShape))?.id;

  for (const note of splitNotes(notes)) {
    const text = note.replace(/^(?:and|then|also|please)\s+/i, '');
    let match: RegExpExecArray | null;
    const need = (...ids: (string | undefined)[]) => { if (ids.every(Boolean)) return true; unread.push(`${note} (there is no slide by that number)`); return false; };
    if ((match = /^(?:merge|combine|join)\s+(?:slides?\s+)?(\d+)\s*(?:and|&|\+|with|into)\s*(?:slide\s+)?(\d+)/i.exec(text))) {
      const [a, b] = [idAt(match[1]), idAt(match[2])];
      if (need(a, b) && a !== b) edits.push({ kind: 'merge', into: Number(match[1]) < Number(match[2]) ? a! : b!, from: Number(match[1]) < Number(match[2]) ? b! : a! });
    } else if ((match = /^(?:drop|remove|delete|cut)\s+(?:slides?\s+)?(\d+(?:\s*(?:,|and|&)\s*\d+)*)\s*$/i.exec(text))) {
      const ids = (match[1].match(/\d+/g) ?? []).map(idAt);
      if (need(...ids)) for (const id of ids) edits.push({ kind: 'drop', id: id! });
    } else if ((match = new RegExp(`^(?:drop|remove|delete|cut)\\s+${shapeWord.source}`, 'i').exec(text))) {
      const id = byShape(match[1]);
      if (id) edits.push({ kind: 'drop', id }); else unread.push(`${note} (there is no ${match[1]} slide)`);
    } else if ((match = /^move\s+(?:slide\s+)?(\d+)\s+(to|before|after)\s+(?:slide\s+|position\s+)?(\d+)/i.exec(text))) {
      const id = idAt(match[1]);
      const to = Number(match[3]) + (match[2].toLowerCase() === 'after' ? 1 : 0);
      if (need(id)) edits.push({ kind: 'move', id: id!, to });
    } else if ((match = /^swap\s+(?:slides?\s+)?(\d+)\s*(?:and|&|with)\s*(?:slide\s+)?(\d+)/i.exec(text))) {
      const [a, b] = [idAt(match[1]), idAt(match[2])];
      if (need(a, b)) edits.push({ kind: 'swap', a: a!, b: b! });
    } else if ((match = new RegExp(`^(?:slide\\s+(\\d+)|${shapeWord.source})\\s*[:,]?\\s*(?:new\\s+)?(?:headline|title)\\s*(?:to|should be|:|=)?\\s*["“']?(.+?)["”']?$`, 'i').exec(text))) {
      const id = match[1] ? idAt(match[1]) : byShape(match[2]);
      if (id) edits.push({ kind: 'headline', id, text: match[3].trim() }); else unread.push(`${note} (there is no such slide)`);
    } else if ((match = new RegExp(`(?:\\bslide\\s+(\\d+)\\b|${shapeWord.source})`, 'i').exec(text))) {
      // Anything else about one slide is new words for that slide, and only that slide.
      const id = match[1] ? idAt(match[1]) : byShape(match[2]);
      if (id) edits.push({ kind: 'rewrite', id, ask: text }); else unread.push(`${note} (there is no such slide)`);
    } else unread.push(note);
  }
  return { edits, unread };
}

// The plain edits, done. A rewrite is left for the caller, which asks a model about that one slide. `touched` is every
// slide that changed, by id, so the caller knows which ones to check again and which to keep as they were.
export function applyEdits(slides: Slide[], edits: DeckEdit[]): { slides: Slide[]; touched: Set<string>; said: string[] } {
  let out = slides.map((slide) => ({ ...slide, lines: [...slide.lines] }));
  const touched = new Set<string>();
  const said: string[] = [];
  const number = (id: string) => slides.findIndex((slide) => slide.id === id) + 1;
  for (const edit of edits) {
    if (edit.kind === 'merge') {
      const into = out.find((slide) => slide.id === edit.into);
      const from = out.find((slide) => slide.id === edit.from);
      if (!into || !from) continue;
      into.lines = [...into.lines, ...(from.headline && from.headline !== into.headline ? [from.headline] : []), ...from.lines]
        .filter((line, index, all) => all.findIndex((other) => other.toLowerCase() === line.toLowerCase()) === index);
      if (!into.figure && from.figure) into.figure = from.figure;
      into.notes = [into.notes, from.notes].filter(Boolean).join('\n') || undefined;
      if (!into.notes) delete into.notes;
      out = out.filter((slide) => slide.id !== from.id);
      touched.add(into.id);
      said.push(`merged slides ${number(edit.into)} and ${number(edit.from)}`);
    } else if (edit.kind === 'drop') {
      if (!out.some((slide) => slide.id === edit.id)) continue;
      out = out.filter((slide) => slide.id !== edit.id);
      said.push(`dropped slide ${number(edit.id)}`);
    } else if (edit.kind === 'move') {
      const at = out.findIndex((slide) => slide.id === edit.id);
      if (at < 0) continue;
      const [slide] = out.splice(at, 1);
      out.splice(Math.max(0, Math.min(out.length, edit.to - 1)), 0, slide);
      said.push(`moved slide ${number(edit.id)} to ${Math.max(1, Math.min(out.length, edit.to))}`);
    } else if (edit.kind === 'swap') {
      const a = out.findIndex((slide) => slide.id === edit.a);
      const b = out.findIndex((slide) => slide.id === edit.b);
      if (a < 0 || b < 0) continue;
      [out[a], out[b]] = [out[b], out[a]];
      said.push(`swapped slides ${number(edit.a)} and ${number(edit.b)}`);
    } else if (edit.kind === 'headline') {
      const slide = out.find((one) => one.id === edit.id);
      if (!slide) continue;
      slide.headline = edit.text;
      touched.add(slide.id);
      said.push(`new headline on slide ${number(edit.id)}`);
    }
  }
  return { slides: out, touched, said };
}

export const slideLabel = (slide: Slide, index: number) => `${index + 1} · ${SHAPE_NAMES[slide.shape]}`;
