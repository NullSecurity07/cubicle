import { isShape, SHAPE_NAMES, type Slide } from '../../shared/deck.ts';
import { unbackedClaims, unbackedEnds } from '../tools/evidence.ts';

// What a deck may be made of: the founder's brief, the documents, notes and project wired to the card, and where
// traction is read from: a wired Metrics card's block, else the Company brief's Numbers (`metrics`, named for which it
// is). A number on a slide is kept only when one of these says it, and the slide then names which one. Nothing is
// looked up anywhere else, so a deck never carries a figure nobody on this stage wrote.
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
const tractionFrom = (material: Material) => material.metrics?.name ?? 'the Metrics card';
// The traction source's own rows, as slide lines: "Paying offices: 3". Journey 13: the traction slide said "No
// numbers yet." while slide 8 listed the brief's numbers; with a source there, traction says what it says.
export function tractionLines(material: Material): string[] {
  if (!material.metrics) return [];
  return material.metrics.text.split('\n').map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[*_`]/g, '').trim())
    .filter((line) => /\d/.test(line) && !/^#/.test(line)).map((line) => words(line).slice(0, LINE_WORDS).join(' ')).slice(0, MOST_LINES);
}

// A claim of evidence on a slide or in its notes that nothing in the material backs, each as written: the doc guard's
// claims ("customers love it", "early pilot results suggest they do"), held to the brief, the wired documents and
// the traction source. Journey 14: slide 8's notes answered the brief's own open question with a pilot nobody ran.
const recordOf = (material: Material) => [material.brief, ...material.sources.map((source) => source.text), ...(material.metrics ? [material.metrics.text] : [])];
export const claimsIn = (text: string, material: Material): string[] => unbackedClaims(text, recordOf(material));

// What a slide may not say unless the material does. Journey 15: the PrintNear deck said "thousands of printers sit
// unused nearby", "Trust built via local reviews and collection" (no such feature), "Solo founder with sales and
// product background" and "Four completed jobs prove makers will use local hosts", none of it in the brief.
// - a count, as the doc guard holds one: the number with the word for what it counts beside it in something read;
// - a count in words ("thousands", "hundreds", "dozens") the material does not say;
// - a product feature (reviews, insurance, pickup…) the material never names;
// - a founder's background ("ex-", "former", "years at", "PhD") with no line of the material's Team section or a
//   read sentence of background that shares a name with it;
// - an empty field ("no dominant player") the material does not claim, and a proof ("prove", "proves") of what is
//   still an open question.
const VAGUE = /\b(?:thousands|hundreds|dozens|millions|billions|countless|tens of thousands)\b/gi;
const FEATURE = /\b(?:reviews?|ratings?|insurance|insured|escrow|deposits?|verification|verified|ID checks?|background checks?|messaging|chat|tracking|notifications?|delivery|deliveries|pickup|pick-up|collection|courier|booking|scheduling|calendar|dashboard|analytics|AI|machine learning|API|integrations?|subscriptions?|loyalty|referrals?|guarantees?|refunds?|warranty|leaderboards?|badges|matching|same[- ]day)\b/gi;
const BIO = /(?:\bex-\p{L}+|\b(?:former(?:ly)?|previously|years? (?:at|in|with|of)|PhD|MBA|background|veteran|alumn\w*|serial (?:founder|entrepreneur)|exited|worked (?:at|for)|built and sold)\b)/iu;
const RIVALS = /\b(?:no\s+(?:\w+\s+){0,2}(?:competitors?|players?|rivals?|competition|alternatives?)|first (?:mover|to market)|no one (?:else )?(?:does|offers))\b/i;
const PROOF = /\b(?:prove[sn]?|proof that)\b/i;
const NOT_YET = /\b(?:to|must|need|needs|will|can|could|should|yet|if|whether|not)\s+(?:\w+\s+)?$/i;
const BIO_PLAIN = new Set('founder founders cofounder co-founder solo team background experience years year former formerly previously with and the'.split(' '));
const lower = (text: string) => text.toLowerCase();
const named = (word: string, record: string) => new RegExp(`\\b${word.replace(/[-\s]+/g, '[-\\s]?').replace(/(?:s|es)$/, '')}(?:s|es|ed|ing)?\\b`, 'i').test(record);
export function inventedIn(text: string, material: Material): string[] {
  const read = recordOf(material);
  const record = read.join('\n');
  const found: string[] = [];
  for (const end of unbackedEnds(text, read)) {
    const number = /[\d,]+\+?$/.exec(text.slice(0, end))?.[0];
    if (number) found.push(`${number}${text.slice(end).match(/^\s*[\p{L}'-]+/u)?.[0] ?? ''}`.trim());
  }
  for (const hit of text.matchAll(VAGUE)) if (!new RegExp(`\\b${hit[0]}\\b`, 'i').test(record)) found.push(hit[0]);
  for (const hit of text.matchAll(FEATURE)) if (!named(lower(hit[0]), record)) found.push(hit[0]);
  const bio = BIO.exec(text);
  if (bio) {
    // The material's background lines: its Team section, and any sentence that itself gives a background.
    const team = read.flatMap((one) => one.split(/\n(?=#{1,6}\s)/)).filter((part) => /^#{1,6}\s.*\b(?:team|founders?|about)\b/i.test(part));
    const lines = [...team, ...read.flatMap((one) => one.split(/\n|(?<=[.!?])\s+/)).filter((one) => BIO.test(one))].join('\n').toLowerCase();
    // Every name it gives ("Google", "Ultimaker") and at least one other word of it must be there.
    const words = (text.match(/[\p{L}][\p{L}'-]{3,}/gu) ?? []).map((word) => word.replace(/^ex-/i, '')).filter((word) => !BIO_PLAIN.has(lower(word)) && !BIO.test(word));
    const names = (text.slice(1).match(/(?<![.:!?]\s)(?<=\s|-)\p{Lu}[\p{L}'-]+/gu) ?? []).filter((word) => !BIO.test(word));
    if (!lines || !words.some((word) => lines.includes(lower(word))) || !names.every((word) => lines.includes(lower(word)))) found.push(bio[0]);
  }
  const rivals = RIVALS.exec(text);
  if (rivals && !RIVALS.test(record)) found.push(rivals[0]);
  const proof = PROOF.exec(text);
  if (proof && !NOT_YET.test(text.slice(0, proof.index))) found.push(proof[0]);
  return [...new Set(found)];
}
const invented = (text: string, material: Material) => [...claimsIn(text, material), ...inventedIn(text, material)];

// The mend's own lines in the notes, which quote what it took out: never read again as the model's words.
const ASIDE = /^(?:Headline had a number with no source|Needs a source:|Cut for one idea a slide:|Name an amount|Asked:|Took out )/;
const noteSentences = (notes: string) => notes.split('\n').flatMap((line) => (ASIDE.test(line.trim()) ? [] : line.split(/(?<=[.!?])\s+/))).map((one) => one.trim()).filter(Boolean);
const unsourcedIn = (text: string, material: Material) => numbersIn(text).filter((number) => !sourceOf(number, material));
const short = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text);

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
      if (!sourceOf(number, material, only)) found.push(`${at}: ${number} is not in the material${only ? ` (a traction number must come from ${tractionFrom(material)})` : ''}; use only numbers the material states, or none`);
    }
    for (const text of [slide.headline, ...slide.lines]) {
      for (const hit of invented(text, material)) found.push(`${at}: "${short(hit)}" is not on record in the material; take it out or put it as an open question`);
    }
    for (const sentence of noteSentences(slide.notes ?? '')) {
      for (const hit of invented(sentence, material)) found.push(`${at}: the speaker notes say "${short(hit)}", which nothing in the material says; take it out or put it as an open question`);
      for (const number of unsourcedIn(sentence, material)) found.push(`${at}: the speaker notes give ${number}, which is not in the material; use only numbers the material states`);
    }
    if (slide.shape === 'traction' && !material.metrics && !saysNoNumbers(slide)) found.push(`${at}: there is no Metrics card and no Numbers in the Company brief, so the traction slide says "${NO_NUMBERS}"`);
    if (slide.shape === 'traction' && material.metrics && (saysNoNumbers(slide) || !numbersIn(textOf(slide)).length)) found.push(`${at}: ${tractionFrom(material)} has numbers, so the traction slide states them rather than none`);
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
    if (invented(slide.headline, material).length) {
      aside.push('Took out a headline that claimed what nothing on record says.');
      slide.headline = SHAPE_NAMES[slide.shape];
      said.push(`${at}: took a claim nothing on record backs out of the headline`);
    }
    // The speaker notes are held to the same record: a sentence with a claim or a number nothing backs goes.
    if (slide.notes) {
      let cut = 0;
      const notes = slide.notes.split('\n').map((line) => {
        if (ASIDE.test(line.trim())) return line;
        const kept = line.split(/(?<=[.!?])\s+/).filter((sentence) => {
          const bad = !!invented(sentence, material).length || !!unsourcedIn(sentence, material).length;
          if (bad) cut += 1;
          return !bad;
        });
        return kept.join(' ');
      }).filter((line, index, all) => line.trim() || (index > 0 && all[index - 1].trim()));
      if (cut) {
        const text = notes.join('\n').trim();
        if (text) slide.notes = text;
        else delete slide.notes;
        said.push(`${at}: took ${cut === 1 ? 'a sentence' : `${cut} sentences`} nothing on record backs out of the speaker notes`);
      }
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
      if (invented(line, material).length) { aside.push('Took out a line that claimed what nothing on record says.'); said.push(`${at}: dropped a line with a claim nothing on record backs`); continue; }
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
      said.push(`${at}: no Metrics card is wired and the Company brief has no Numbers, so it says "${NO_NUMBERS}"`);
    }
    // A traction slide with no number while its source has some: the source's own rows, so no two slides disagree.
    if (slide.shape === 'traction' && material.metrics && (saysNoNumbers(slide) || !numbersIn(textOf(slide)).length)) {
      const rows = tractionLines(material);
      if (rows.length) {
        slide.lines = rows;
        said.push(`${at}: traction said no numbers, so it now reads them from ${tractionFrom(material)}`);
      }
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
