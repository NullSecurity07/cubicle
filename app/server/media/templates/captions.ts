// Captions, word by word, under the line being said. The voice model hands back one piece of sound a sentence, so a
// sentence's length is known exactly and only the words inside it have to be guessed at — which is done by how long
// each word takes to say, not by how many there are: "strategically" is not "a".

// One piece of narration as the voice studio recorded it: the words, and how long that piece plays.
export type Part = { text: string; seconds: number };
export type Word = { word: string; at: number; seconds: number };
export type CapLine = { words: Word[]; at: number; seconds: number };

// Punctuation is written, not said, so it carries no time; the constant is the beat every word costs whatever its
// length, which is what keeps "a" from flashing past unreadably.
const WEIGHT = 1.9;
const spoken = (word: string) => word.replace(/[^\p{L}\p{N}]+/gu, '').length;

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

// Words are shown a handful at a time: a phone caption that runs to the edge of the frame is read instead of watched.
// The break is by width, not by count — a line of three long words wraps by itself and leaves one of them stranded
// underneath at the dimness of a word not yet said, which looks like a fault rather than a caption. A line also ends
// wherever the speaker stops for a beat, and at the end of a sentence.
export function capLines(words: Word[], perLine: number): CapLine[] {
  const lines: CapLine[] = [];
  let held: Word[] = [];
  let wide = 0;
  const close = () => {
    if (!held.length) return;
    lines.push({ words: held, at: held[0].at, seconds: Math.round((held.at(-1)!.at + held.at(-1)!.seconds - held[0].at) * 1000) / 1000 });
    held = [];
    wide = 0;
  };
  for (const word of words) {
    const last = held.at(-1);
    if (last && (word.at - (last.at + last.seconds) > 0.34 || wide + word.word.length + 1 > perLine)) close();
    held.push(word);
    wide += word.word.length + 1;
    if (/[.!?]$/.test(word.word)) close();
  }
  close();
  return lines;
}

const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The band of captions for one scene, and the steps that run it: a line arrives, each of its words lights as it is
// said, and the line goes when the next one comes. Nothing here moves the scene under it.
export function capHtml(lines: CapLine[], index: number): string {
  if (!lines.length) return '';
  const said = lines.map((line, at) => `<div class="capline" id="c${index}-${at}">`
    + line.words.map((word, order) => `<span class="capword" id="c${index}-${at}-${order}">${html(word.word)}</span>`).join('')
    + '</div>').join('');
  return `<div class="caps" aria-hidden="true">${said}</div>`;
}

export function capSteps(lines: CapLine[], index: number, until: number): string[] {
  const steps: string[] = [];
  const time = (value: number) => value.toFixed(3);
  const FADE = 0.15;
  lines.forEach((line, at) => {
    // Every line sits in the same place, so the one going has to be gone before the one coming arrives — overlap them
    // by even a tenth of a second and the two read as one word on top of another.
    const next = lines[at + 1]?.at;
    // The line going has to be gone before the line coming arrives — and two lines that all but touch used to skip
    // the fade altogether, which left the first one on screen under the second for the rest of the scene.
    const gone = Math.max(line.at + 0.06, next !== undefined ? next - FADE - 0.02 : Math.min(until, line.at + line.seconds + 0.5));
    steps.push(`tl.fromTo("#c${index}-${at}", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" }, ${time(line.at)});`);
    line.words.forEach((word, order) => {
      steps.push(`tl.fromTo("#c${index}-${at}-${order}", { opacity: 0.26, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.14, ease: "power2.out" }, ${time(word.at)});`);
    });
    steps.push(`tl.to("#c${index}-${at}", { opacity: 0, duration: ${Math.min(FADE, Math.max(0.04, (next ?? gone + FADE) - gone)).toFixed(3)}, ease: "power2.in" }, ${time(gone)});`);
  });
  return steps;
}
