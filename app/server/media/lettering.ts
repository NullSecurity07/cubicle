import type { Maker } from './jobs.ts';
// Sharp is loaded on first use, the way the Hugging Face client is: putting words on a picture is a nicety, and a
// nicety must never be the reason the server will not start.
const sharpOf = () => import('sharp');

// A picture model cannot spell. Ask FLUX for a title and it draws something with the shape of writing and none of the
// meaning — "Indnatre Wenture Caqrt" where "India Venture Capital" was asked for — and a founder cannot put that in
// front of anybody. There is no prompt that fixes it, because the letters are being drawn rather than typed.
//
// So the work is split in two. The model draws a picture with no writing anywhere in it, and the real words are set
// over that picture afterwards, in a real typeface, exactly as they were written. `wordless` is the first half and
// `typeset` is the second; `lettered` is both of them wrapped round whatever does the drawing.

// The sentence every prompt ends with. Said as a description of the picture rather than as a list of things to avoid,
// because a picture model has no negative prompt: "no text" on its own is read as part of the scene and summons the
// very thing it asked to be spared. Naming what the surfaces *are* — clean and empty — is what actually works.
const NO_WORDS = 'The picture is purely visual, every surface clean and empty: no text, no letters, no numbers, no logos, no watermark anywhere.';
// What is drawn when a prompt turns out to have been nothing but a request for writing.
const NOTHING_LEFT = 'a clean editorial illustration, simple shapes, generous empty space, soft even light';

// Words in quotes are the ones a model tries hardest to spell, so they go first. The single-quote form is deliberately
// fussy: an apostrophe in "India's founders" must not be read as the start of a quotation.
const QUOTED = /"[^"]*"|[“][^”]*[”]|[«][^»]*[»]|(?:^|[\s(])'[^']{1,80}'(?=[\s,.;:)]|$)|(?:^|[\s(])[‘][^’]{1,80}[’](?=[\s,.;:)]|$)/g;
// The clause that asks for writing — "with the title …", "and a caption reading …", "labelled …" — up to wherever the
// sentence turns to something else, which is the next comma, semicolon or full stop.
const ASKS_FOR_WORDS = /(?:^|[\s,;])(?:(?:with|featuring|including|containing|bearing|showing|displaying|and|plus)\s+)?(?:the|a|an|its)?\s*(?:titles?|headlines?|headings?|subtitles?|captions?|texts?|words?|labels?|labell?ed|lettering|slogans?|taglines?|wordmarks?)\b(?:\s*(?:that\s+says?|that\s+reads?|which\s+says?|which\s+reads?|saying|reading|says?|reads?|of|is|are))?\s*:?\s*[^,.;]*/gi;
// Nouns that are made of lettering as much as of picture: ask for one and the model fills the frame with writing.
// Each is swapped for the nearest thing that is only a picture. A short list on purpose — every entry is one the
// founder has actually been handed gibberish for.
const SWAPS: [RegExp, string][] = [
  [/\binfographics?\b/gi, 'editorial illustration'],
  [/\bposters?\b/gi, 'illustration'],
  [/\bbanners?\b/gi, 'illustration'],
  [/\bflyers?\b/gi, 'illustration'],
  [/\bbillboards?\b/gi, 'illustration'],
];

// Whatever taking things out left behind: floating commas, doubled spaces, a word said twice where two nouns were
// swapped for the same one.
const tidied = (said: string) => said
  .replace(/\b(\w+)\s+style\s+\1\b/gi, '$1')
  .replace(/\b(\w+)\s+\1\b/gi, '$1')
  .replace(/\s+/g, ' ')
  .replace(/\s+([,.;:])/g, '$1')
  .replace(/([,;])(\s*[,;])+/g, '$1')
  .replace(/^[\s,;.]+|[\s,;]+$/g, '')
  .trim();

// A prompt with everything in it that makes a model letter taken out, and one firm sentence put on the end. Running
// it twice changes nothing, because the sentence is lifted off before the work starts and put back after it.
export function wordless(prompt: string): string {
  const body = String(prompt ?? '').replace(NO_WORDS, ' ');
  let said = body.replace(QUOTED, ' ').replace(ASKS_FOR_WORDS, ' ');
  for (const [noun, instead] of SWAPS) said = said.replace(noun, instead);
  said = tidied(said);
  if (said.replace(/[^a-z0-9]/gi, '').length < 4) said = NOTHING_LEFT;
  return `${said}${/[.!?]$/.test(said) ? '' : '.'} ${NO_WORDS}`;
}

// The words that go on a picture: a headline, and a list under it.
export type Words = { headline?: string; lines?: string[] };

// Inter first because the app ships it; the rest are what a Linux box actually has, and librsvg finds them through
// fontconfig. Liberation Sans and DejaVu Sans are the two that are always there.
const FONTS = "Inter, 'SF Pro Display', 'Helvetica Neue', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif";
const INK = '#ffffff';
const ACCENT = '#f2b23c';
const SHADE = '#05070c';
// About how wide a character is, as a fraction of its size. Near enough to wrap by, and wrapping by guesswork beats
// measuring, which would mean loading a font library to put six words on a picture.
const BOLD_EM = 0.56;
const PLAIN_EM = 0.5;
const HEAD_LINES = 3;
const LIST_LINES = 6;
const LIST_CHARS = 64;

const escaped = (said: string) => said
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// What a model hands over is written for a chat window: emoji, asterisks round the bold bits, a dash at the front of
// every list item. None of that belongs in set type — the bullet is drawn here, and an emoji is a hole in the line.
const plainly = (said: string) => String(said ?? '')
  .replace(/[\u{1f000}-\u{1faff}\u{fe00}-\u{fe0f}\u{2600}-\u{27bf}\u{2b00}-\u{2bff}]/gu, '')
  .replace(/[*_`~]/g, '')
  .replace(/^\s*#{1,6}\s*/, '')
  .replace(/^\s*(?:[-–—•·▪●]|\d{1,2}[.)])\s+/, '')
  // The apostrophe a model types is the typewriter one. Set type has a real one, and "India's founders" set with a
  // straight quote is the sort of thing a founder notices and nobody can name.
  .replace(/(\w)'(\w)/g, '$1’$2')
  .replace(/\s+/g, ' ')
  .trim();

// Greedy wrapping by the guessed width of a character, with a word longer than the whole line broken rather than left
// to run off the edge.
function wrap(said: string, room: number, per: number): string[] {
  const fits = Math.max(8, Math.floor(room / per));
  const out: string[] = [];
  let line = '';
  for (const raw of said.split(' ')) {
    let word = raw;
    while (word.length > fits) {
      if (line) { out.push(line); line = ''; }
      out.push(word.slice(0, fits));
      word = word.slice(fits);
    }
    if (!word) continue;
    const next = line ? `${line} ${word}` : word;
    if (next.length <= fits) line = next;
    else { if (line) out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

const shorten = (said: string, most: number) => (said.length > most ? `${said.slice(0, most - 1).trimEnd()}…` : said);

// Real words over the picture, set in real type. A soft dark scrim rises behind them so they read whatever the model
// drew underneath; a small accent rule sits over the headline; the list is a clean column under it with generous
// margins. The type shrinks in steps until the block fits the frame, so a long headline is smaller rather than off
// the edge, and anything still too long is cut with an ellipsis.
export async function typeset(bytes: Buffer, words: Words): Promise<Buffer> {
  const headline = plainly(words.headline ?? '');
  const lines = (words.lines ?? []).map(plainly).filter(Boolean).slice(0, LIST_LINES).map((one) => shorten(one, LIST_CHARS));
  if (!headline && !lines.length) return bytes;

  const { default: sharp } = await sharpOf();
  const meta = await sharp(bytes).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error('the picture has no size to set words on');

  const short = Math.min(width, height);
  const margin = Math.round(short * 0.07);
  const room = width - margin * 2;
  const ruleH = Math.max(3, Math.round(short * 0.006));
  const ruleW = Math.round(short * 0.1);

  // Big first, then smaller, until the whole block sits inside its share of the frame. The last step is taken
  // whatever it measures, so there is always an answer. The block is measured to the last line's descender rather
  // than to the bottom of its leading, so the words sit a true margin off the floor instead of a margin and a gap.
  const steps = [0.082, 0.074, 0.066, 0.058, 0.05, 0.044, 0.038, 0.033];
  let laid = null as null | { head: string[]; headSize: number; lineSize: number; block: number };
  for (const [index, step] of steps.entries()) {
    const headSize = Math.round(short * step);
    const lineSize = Math.max(Math.round(short * 0.024), Math.round(headSize * (headline ? 0.46 : 0.62)));
    const head = headline ? wrap(headline, room, headSize * BOLD_EM) : [];
    const last = index === steps.length - 1;
    if (head.length > HEAD_LINES && !last) continue;
    const kept = head.slice(0, HEAD_LINES);
    if (head.length > HEAD_LINES) kept[HEAD_LINES - 1] = shorten(kept[HEAD_LINES - 1], Math.max(8, kept[HEAD_LINES - 1].length - 1));
    const block = ruleH + Math.round(headSize * 0.55)
      + (kept.length ? (kept.length - 1) * Math.round(headSize * 1.1) + Math.round(headSize * 1.06) : 0)
      + (kept.length && lines.length ? Math.round(headSize * 0.5) : 0)
      + (lines.length ? (lines.length - 1) * Math.round(lineSize * 1.8) + Math.round(lineSize * 1.06) : 0);
    laid = { head: kept, headSize, lineSize, block };
    if (block + margin * 2 <= height * 0.66 || last) break;
  }
  const { head, headSize, lineSize, block } = laid!;

  // Where the block sits: on the floor of the picture, a margin up, with the scrim reaching above it so the top line
  // is never the first thing the dark touches.
  const top = height - margin - block;
  const scrim = Math.max(0, Math.round(top - short * 0.14));
  const parts: string[] = [];
  let y = top;
  parts.push(`<rect x="${margin}" y="${y}" width="${ruleW}" height="${ruleH}" rx="${(ruleH / 2).toFixed(1)}" fill="${ACCENT}"/>`);
  y += ruleH + Math.round(headSize * 0.55);
  const headStep = Math.round(headSize * 1.1);
  const headBase = Math.round(y + headSize * 0.8);
  head.forEach((line, index) => {
    parts.push(`<text x="${margin}" y="${headBase + index * headStep}" font-size="${headSize}" font-weight="700" letter-spacing="${-(headSize * 0.018).toFixed(2)}" fill="${INK}">${escaped(line)}</text>`);
  });
  if (head.length) y += (head.length - 1) * headStep + Math.round(headSize * 1.06) + (lines.length ? Math.round(headSize * 0.5) : 0);
  const lineStep = Math.round(lineSize * 1.8);
  const lineBase = Math.round(y + lineSize * 0.8);
  const dot = Math.max(2, Math.round(lineSize * 0.16));
  const indent = margin + Math.round(lineSize * 1.15);
  lines.forEach((line, index) => {
    const base = lineBase + index * lineStep;
    parts.push(`<circle cx="${margin + dot}" cy="${base - Math.round(lineSize * 0.26)}" r="${dot}" fill="${ACCENT}" fill-opacity="0.95"/>`);
    parts.push(`<text x="${indent}" y="${base}" font-size="${lineSize}" font-weight="500" letter-spacing="${(lineSize * 0.004).toFixed(2)}" fill="${INK}" fill-opacity="0.94">${escaped(shorten(wrap(line, room - (indent - margin), lineSize * PLAIN_EM)[0] ?? '', LIST_CHARS))}</text>`);
  });

  // The scrim carries most of the legibility; a soft shadow under the whole block carries the rest, so white type
  // still reads where the picture happens to be pale. Built out of the oldest filter primitives there are, because
  // the words disappearing is the one failure a scrim cannot rescue.
  const blur = Math.max(2, Math.round(short * 0.008));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${SHADE}" stop-opacity="0"/>`
    + `<stop offset="0.28" stop-color="${SHADE}" stop-opacity="0.46"/>`
    + `<stop offset="0.6" stop-color="${SHADE}" stop-opacity="0.82"/>`
    + `<stop offset="1" stop-color="${SHADE}" stop-opacity="0.94"/>`
    + `</linearGradient>`
    + `<filter id="lift" x="-10%" y="-10%" width="120%" height="120%">`
    + `<feGaussianBlur in="SourceAlpha" stdDeviation="${blur}"/><feOffset dy="${Math.round(blur / 2)}"/>`
    + `<feComponentTransfer><feFuncA type="linear" slope="0.85"/></feComponentTransfer>`
    + `<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`
    + `<rect x="0" y="${scrim}" width="${width}" height="${height - scrim}" fill="url(#scrim)"/>`
    + `<g filter="url(#lift)" font-family="${FONTS}">${parts.join('')}</g>`
    + `</svg>`;
  return await sharp(bytes).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
}

// Drawing and lettering as one maker, in the shape `cachedImages` has: whatever is inside is asked for a picture with
// no writing in it, and the words — when there are any — are set over what comes back. Words that cannot be set are
// never allowed to cost the founder the picture: it comes back plain, and the card says why in a line.
export function lettered(maker: Maker): Maker {
  return {
    name: maker.name,
    ready: maker.ready,
    async make(ask, help) {
      const piece = await maker.make({ ...ask, prompt: wordless(String(ask.prompt ?? '')) }, help);
      const headline = typeof ask.headline === 'string' ? ask.headline : '';
      const lines = (Array.isArray(ask.lines) ? ask.lines : []).map((one) => String(one ?? ''));
      if (!headline.trim() && !lines.some((one) => one.trim())) return piece;
      help.report('setting the words in real type…');
      try {
        return { ...piece, ext: 'png', bytes: await typeset(piece.bytes, { headline, lines }) };
      } catch {
        help.report('the picture is drawn, but the words could not be set on it, so it comes back without them');
        return piece;
      }
    },
  };
}
