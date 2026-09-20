// Captions, word by word, under the line being said.
//
// Two things changed here, and both came out of a real film.
//
// The first is where the times come from. The voice model hands back one piece of sound a sentence, so a sentence's
// length is known and the words inside it were spread across it by how long each takes to say. That is still the net
// — `wordTimes` below — but it is a guess, and a caption a tenth of a second off the word it belongs to is what
// makes an automatic edit look automatic. `media/timings.ts` measures them instead, and hands the measurement here.
//
// The second is how many words are on screen at once. A caption line is read, not watched: one to three words at a
// time for a reel, four at the outside, one of them the word the line turns on set in the accent colour. That is
// the single highest-leverage graphic in short-form video and it was being set as subtitles.

// One piece of narration as the voice studio recorded it: the words, and how long that piece plays.
export type Part = { text: string; seconds: number };
export type Word = { word: string; at: number; seconds: number };
export type CapLine = { words: Word[]; at: number; seconds: number; pop?: number };

// Punctuation is written, not said, so it carries no time; the constant is the beat every word costs whatever its
// length, which is what keeps "a" from flashing past unreadably.
const WEIGHT = 1.9;
const spoken = (word: string) => word.replace(/[^\p{L}\p{N}]+/gu, '').length;

// How long a caption line may stay on screen, and how little. Under a fifth of a second nothing is read at all;
// seventeen characters a second is the ceiling a general audience reads at, twenty is the hard limit.
export const CAP_LEAST = 0.2;
export const CAP_CPS = 17;

export function wordTimes(parts: Part[], from = 0): Word[] {
  const found: Word[] = [];
  let at = from;
  for (const part of parts) {
    const words = part.text.trim().split(/\s+/).filter(Boolean);
    const span = Math.max(0, part.seconds);
    if (!words.length) { at += span; continue; }
    // The end of a sentence is a breath, not a word: leave it out of what the words are spread across.
    const rest = Math.min(0.32, span * 0.12);
    const room = Math.max(0.05, span - rest);
    const weights = words.map((word) => spoken(word) + WEIGHT);
    const whole = weights.reduce((sum, one) => sum + one, 0);
    let cursor = at;
    words.forEach((word, index) => {
      const seconds = Math.round((room * weights[index]) / whole * 1000) / 1000;
      found.push({ word, at: Math.round(cursor * 1000) / 1000, seconds });
      cursor += seconds;
    });
    at += span;
  }
  return found;
}

// Words are shown a handful at a time: one to three for a reel, two to four for a quieter film, and never more.
// The break is by count first and by width second — a line of three long words wraps by itself and leaves one of
// them stranded underneath at the dimness of a word not yet said, which looks like a fault rather than a caption.
// A line also ends wherever the speaker stops for a beat, and at the end of a sentence.
//
// One word in each line is the one it turns on, and it takes the accent colour. It is the longest word that
// carries meaning, or the one the director named — never "the", never "is".
const STOPPISH = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'so', 'if', 'is', 'are', 'was', 'were', 'be', 'to', 'of',
  'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'it', 'its', 'you', 'your', 'we', 'our', 'they', 'their',
  'i', 'my', 'me', 'he', 'she', 'his', 'her', 'them', 'us', 'that', 'this', 'not', 'no', 'do', 'does', 'did']);
const bare = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function capLines(words: Word[], perLine: number, mostWords = 3, keywords: string[] = []): CapLine[] {
  const lines: CapLine[] = [];
  const wanted = new Set(keywords.map(bare).filter(Boolean));
  let held: Word[] = [];
  let wide = 0;
  const close = () => {
    if (!held.length) return;
    const last = held.at(-1)!;
    lines.push({ words: held, at: held[0].at, seconds: Math.round((last.at + last.seconds - held[0].at) * 1000) / 1000, pop: popIn(held, wanted) });
    held = [];
    wide = 0;
  };
  for (const word of words) {
    const last = held.at(-1);
    if (last && (word.at - (last.at + last.seconds) > 0.34 || held.length >= mostWords || wide + word.word.length + 1 > perLine)) close();
    held.push(word);
    wide += word.word.length + 1;
    if (/[.!?]$/.test(word.word)) close();
  }
  close();
  return lines;
}

// Which word in a line is set in the accent colour: the one the director marked if it is here, otherwise the
// longest word that carries any meaning. A line of nothing but small words highlights none of them.
function popIn(words: Word[], wanted: Set<string>): number | undefined {
  const marked = words.findIndex((one) => wanted.has(bare(one.word)));
  if (marked >= 0) return marked;
  let best = -1;
  let longest = 3;
  words.forEach((one, at) => {
    const word = bare(one.word);
    if (word.length > longest && !STOPPISH.has(word)) { longest = word.length; best = at; }
  });
  return best >= 0 ? best : undefined;
}

const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The film's one band of captions, and the steps that run it: a line arrives, each of its words lights as it is
// said, and the line goes when the next one comes. It sits outside every scene, because a caption belongs to the
// frame rather than to the shot under it and must not be whipped off the screen by a cut.
// How wide a capital of the display face really is against its own size. Measured off the rendered frames rather
// than assumed: a condensed shouting face is narrow and a serif is not, and the difference decides whether a long
// word fits between the margins or has both its ends cut off by them.
export const CAP_WIDTH = 0.58;

// `room` is how many pixels the caption band actually has between the margins, and `size` the height the format
// wants its captions at. A line wider than the room it has is set smaller — never wrapped, because a caption that
// wraps leaves one word stranded underneath at the dimness of a word not yet said, and never clipped, which is
// what a real reel did: a nine-letter word centred in the band with its first and last letters cut off by the
// frame. Type that shrinks to fit is what every caption tool does and nobody notices.
export function capHtml(lines: CapLine[], fit?: { size: number; room: number }): string {
  if (!lines.length) return '';
  const sized = (line: CapLine): string => {
    if (!fit) return '';
    const letters = line.words.reduce((sum, one) => sum + one.word.length, 0) + Math.max(0, line.words.length - 1);
    const fits = fit.room / Math.max(1, letters * CAP_WIDTH);
    // Never under two thirds: past that it stops being a caption and becomes a subtitle.
    return fits >= fit.size ? '' : ` style="font-size: ${Math.max(fit.size * 0.66, fits).toFixed(1)}px"`;
  };
  const said = lines.map((line, at) => `<div class="capline" id="c${at}"${sized(line)}>`
    + line.words.map((word, order) => `<span class="capword${line.pop === order ? ' pop' : ''}" id="c${at}-${order}">${html(word.word)}</span>`).join('')
    + '</div>').join('');
  return `<div class="caps" aria-hidden="true">${said}</div>`;
}

export function capSteps(lines: CapLine[], until: number): string[] {
  const steps: string[] = [];
  const time = (value: number) => value.toFixed(3);
  const FADE = 0.12;
  lines.forEach((line, at) => {
    // Every line sits in the same place, so the one going has to be gone before the one coming arrives — overlap
    // them by even a tenth of a second and the two read as one word on top of another.
    const next = lines[at + 1]?.at;
    // A line is held long enough to be read: a fifth of a second at the very least, and never faster than a
    // general audience reads.
    const letters = line.words.reduce((sum, one) => sum + one.word.length + 1, 0);
    const readable = Math.max(CAP_LEAST, letters / CAP_CPS);
    const wants = Math.max(line.seconds, readable);
    const gone = Math.max(line.at + CAP_LEAST, next !== undefined ? next - FADE - 0.02 : Math.min(until, line.at + wants + 0.35));
    // Nothing arrives linearly: the entrance is the bold ease-out every other element in the film uses.
    steps.push(`tl.fromTo("#c${at}", { opacity: 0, y: 16, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.16, ease: "power3.out" }, ${time(line.at)});`);
    // A word that has not been said yet is still a word a viewer can read. It used to start at a quarter opacity
    // and rise as it was spoken, which is the karaoke idea taken too literally: at a quarter the black stroke is
    // at a quarter too, and a dimmed stroke over a bright photograph is a dull olive smear. A real reel came back
    // with two of its six caption frames unreadable that way. So the line arrives at full strength and the word
    // being said snaps up in size — the size is the emphasis, and the one keyword keeps the accent colour.
    line.words.forEach((word, order) => {
      steps.push(`tl.fromTo("#c${at}-${order}", { scale: 0.9 }, { scale: 1, duration: 0.13, ease: "back.out(1.7)" }, ${time(word.at)});`);
    });
    steps.push(`tl.to("#c${at}", { opacity: 0, duration: ${Math.min(FADE, Math.max(0.04, (next ?? gone + FADE) - gone)).toFixed(3)}, ease: "power2.in" }, ${time(gone)});`);
  });
  return steps;
}
