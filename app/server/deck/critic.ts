import { isShape, SHAPE_NAMES, type Slide } from '../../shared/deck.ts';

// What a deck may be made of: the founder's brief, the documents, notes and project wired to the card, and a Metrics
// card's block when one is wired. A number on a slide is kept only when one of these says it, and the slide then
// names which one. Nothing is looked up anywhere else, so a deck never carries a figure nobody on this stage wrote.
export type Material = { brief: string; sources: { name: string; text: string }[]; metrics?: { name: string; text: string } };

export const HEADLINE_WORDS = 8;
export const MOST_LINES = 4;
export const LINE_WORDS = 16;
export const NO_NUMBERS = 'No numbers yet.';

// A number as a claim: money, a share, a multiple, a count with a unit. A year and a small bare count ("three
// founders", "step 2") are not claims anybody has to source.
const NUMBER = /[$€£]?\s?\d[\d,.]*(?:\s?(?:%|x\b|k\b|m\b|bn\b|b\b|million\b|billion\b|thousand\b))?/gi;
const MONEY = /[$€£]\s?\d[\d,.]*(?:\s?(?:k|m|bn|b|million|billion|thousand)\b)?|\d[\d,.]*\s?(?:k|m|bn|million|billion|thousand)\b/gi;
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);

export function normal(token: string): string {
  return token.toLowerCase().replace(/[$€£,\s]/g, '').replace(/\.$/, '')
    .replace(/million$/, 'm').replace(/billion$/, 'bn').replace(/thousand$/, 'k').replace(/(\d)b$/, '$1bn');
}
const claim = (token: string) => {
  const clean = normal(token);
  if (!/\d/.test(clean)) return false;
  if (/^(19|20)\d\d$/.test(clean)) return false;
  if (/^\d+$/.test(clean) && Number(clean) <= 10) return false;
  return true;
};
export const numbersIn = (text: string): string[] => [...text.matchAll(NUMBER)].map((hit) => hit[0].trim()).filter(claim);
export const moneyIn = (text: string): string[] => [...text.matchAll(MONEY)].map((hit) => hit[0].trim()).filter(claim);

// Where a number came from, or nothing: the first piece of material that says the same number.
export function sourceOf(token: string, material: Material, only?: 'metrics' | 'brief'): string | null {
  const want = normal(token);
  const has = (text: string) => numbersIn(text).some((one) => normal(one) === want);
  if (only !== 'brief' && material.metrics && has(material.metrics.text)) return material.metrics.name;
  if (only === 'metrics') return null;
  if (has(material.brief)) return 'your brief';
  if (only === 'brief') return null;
  for (const source of material.sources) if (has(source.text)) return source.name;
  return null;
}

const textOf = (slide: Slide) => [slide.headline, ...slide.lines, slide.figure ? `${slide.figure.value} ${slide.figure.label}` : ''].join('\n');
const saysNoNumbers = (slide: Slide) => slide.lines.some((line) => /no numbers yet/i.test(line));

// What is wrong with a deck, slide by slide, in words a model can act on. Empty is a deck that passes.
export function faults(slides: Slide[], material: Material): string[] {
  const found: string[] = [];
  slides.forEach((slide, index) => {
    const at = `slide ${index + 1} (${slide.shape})`;
    const count = words(slide.headline).length;
    if (!count) found.push(`${at} has no headline`);
    if (count > HEADLINE_WORDS) found.push(`${at}: the headline has ${count} words; keep it under 9`);
    if (slide.lines.length > MOST_LINES) found.push(`${at}: one idea a slide, so at most ${MOST_LINES} lines, not ${slide.lines.length}`);
    for (const line of slide.lines) if (words(line).length > LINE_WORDS) found.push(`${at}: "${line.slice(0, 40)}…" is longer than ${LINE_WORDS} words`);
    const only = slide.shape === 'traction' ? 'metrics' : undefined;
    for (const number of numbersIn(textOf(slide))) {
      if (!sourceOf(number, material, only)) found.push(`${at}: ${number} is not in the material${only ? ' (a traction number must come from the Metrics card)' : ''}; use only numbers the material states, or none`);
    }
    if (slide.shape === 'traction' && !material.metrics && !saysNoNumbers(slide)) found.push(`${at}: there is no Metrics card, so the traction slide says "${NO_NUMBERS}"`);
    if (slide.shape === 'ask') for (const amount of moneyIn(textOf(slide))) {
      if (!sourceOf(amount, material, 'brief')) found.push(`${at}: the founder did not name ${amount}; the ask names an amount only when the brief does`);
    }
  });
  return found;
}

// The rules, applied rather than asked for: what a model left wrong after its own two goes is put right here, and the
// card is told each thing that was changed. It changes nothing on a slide that already passes, so running it over a
// kept slide keeps it exactly as it was.
export function mend(slides: Slide[], material: Material): { slides: Slide[]; said: string[] } {
  const said: string[] = [];
  const out = slides.map((original, index) => {
    const slide: Slide = { ...original, lines: [...original.lines], ...(original.figure ? { figure: { ...original.figure } } : {}) };
    const at = `slide ${index + 1}`;
    const aside: string[] = [];
    const only = slide.shape === 'traction' ? 'metrics' as const : undefined;
    const sourced = (text: string) => numbersIn(text).every((number) => !!sourceOf(number, material, only))
      && (slide.shape !== 'ask' || moneyIn(text).every((amount) => !!sourceOf(amount, material, 'brief')));

    if (!sourced(slide.headline)) {
      const kept = words(slide.headline.replace(NUMBER, (hit) => (claim(hit) ? ' ' : hit))).join(' ').replace(/^[^\p{L}\d]+|[\s,;:–-]+$/gu, '');
      aside.push(`Headline had a number with no source: "${slide.headline}"`);
      slide.headline = words(kept).length >= 2 ? kept : SHAPE_NAMES[slide.shape];
      said.push(`${at}: took a number with no source out of the headline`);
    }
    if (words(slide.headline).length > HEADLINE_WORDS) {
      slide.headline = words(slide.headline).slice(0, HEADLINE_WORDS).join(' ').replace(/[,;:–-]+$/, '');
      said.push(`${at}: cut the headline to ${HEADLINE_WORDS} words`);
    }
    if (!slide.headline.trim()) slide.headline = SHAPE_NAMES[slide.shape];
    if (slide.figure && !sourced(`${slide.figure.value} ${slide.figure.label}`)) {
      aside.push(`Needs a source: ${slide.figure.value} ${slide.figure.label}`);
      delete slide.figure;
      said.push(`${at}: dropped a figure with no source`);
    }
    const lines: string[] = [];
    for (const line of slide.lines) {
      if (!sourced(line)) { aside.push(`Needs a source: ${line}`); said.push(`${at}: dropped a line with a number and no source`); continue; }
      lines.push(words(line).length > LINE_WORDS ? `${words(line).slice(0, LINE_WORDS).join(' ')}…` : line);
    }
    if (lines.length > MOST_LINES) {
      aside.push(...lines.slice(MOST_LINES).map((line) => `Cut for one idea a slide: ${line}`));
      said.push(`${at}: kept ${MOST_LINES} of ${lines.length} lines, one idea a slide`);
      lines.length = MOST_LINES;
    }
    slide.lines = lines;
    if (slide.shape === 'traction' && !material.metrics && !saysNoNumbers(slide)) {
      slide.lines = [NO_NUMBERS, ...slide.lines].slice(0, MOST_LINES);
      said.push(`${at}: no Metrics card is wired, so it says "${NO_NUMBERS}"`);
    }
    if (slide.shape === 'ask' && !moneyIn(textOf(slide)).length && moneyIn(textOf(original)).length) aside.push('Name an amount in the brief when you have one.');
    // Where this slide's numbers came from, worked out rather than taken on the model's word.
    const from = [...new Set(numbersIn(textOf(slide)).map((number) => sourceOf(number, material, only)).filter((one): one is string => !!one))];
    if (from.length) slide.source = from.join(', ');
    else delete slide.source;
    if (aside.length) slide.notes = [slide.notes, ...aside].filter(Boolean).join('\n');
    return slide;
  });
  return { slides: out, said };
}

// A storyboard as a model wrote it, made into slides or refused with the reason. Only the shape is checked here; the
// rules are `faults`' and `mend`'s.
export function parseStoryboard(value: unknown, ids: () => string): { title: string; slides: Slide[] } {
  if (!value || typeof value !== 'object') throw new Error('the storyboard is not an object');
  const raw = value as { title?: unknown; slides?: unknown };
  if (!Array.isArray(raw.slides) || raw.slides.length < 3) throw new Error('"slides" must be a list of at least 3 slides');
  if (raw.slides.length > 20) throw new Error('a deck has at most 20 slides');
  const slides = raw.slides.map((one, index) => parseSlide(one, index, ids()));
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 80) : slides[0].headline;
  return { title, slides };
}

// One slide as a model wrote it, or the reason it is not one.
export function parseSlide(one: unknown, index: number, id: string): Slide {
  const slide = one as Record<string, unknown>;
  if (!slide || typeof slide !== 'object') throw new Error(`slide ${index + 1} is not an object`);
  if (!isShape(slide.shape)) throw new Error(`slide ${index + 1}: "shape" must be one of ${Object.keys(SHAPE_NAMES).join(', ')}`);
  if (typeof slide.headline !== 'string' || !slide.headline.trim()) throw new Error(`slide ${index + 1}: "headline" is required`);
  const lines = Array.isArray(slide.lines) ? slide.lines.filter((line): line is string => typeof line === 'string' && !!line.trim()).map((line) => line.trim()) : [];
  const figure = slide.figure as { value?: unknown; label?: unknown } | undefined;
  return {
    id, shape: slide.shape, headline: slide.headline.trim().replace(/\s+/g, ' '), lines,
    ...(figure && typeof figure.value === 'string' && figure.value.trim() ? { figure: { value: figure.value.trim(), label: typeof figure.label === 'string' ? figure.label.trim() : '' } } : {}),
    ...(typeof slide.notes === 'string' && slide.notes.trim() ? { notes: slide.notes.trim() } : {}),
  };
}
