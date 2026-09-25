import type { Take } from './editor.ts';
import type { Word } from './timings.ts';
import { countWords, saidWords, WORDS_A_SECOND, type Spec } from './spec.ts';
import type { Pace } from './templates/looks.ts';

// How long a film really runs.
//
// It used to be the length the founder asked for, whatever was said. A reading that came to fifteen seconds in a film
// asked for twenty was stretched to twenty: every scene was handed a share of the missing five, and the caption track,
// which follows the voice, had nothing left to say — so the last line sat on screen through all of it. The site's
// own hero film ended on eight seconds of the word "research." That is a film silently made worse to hit a number.
//
// So a narrated film follows its narration. The last word is said, the close is held for long enough to read it,
// and the film ends. The founder is told the real length on the card. A film with nobody speaking is still spread
// to its length, because a silent film of timed cards has no voice to run out and nothing to freeze.

// How long the close is held after the last word, and the most it may ever be: long enough to read a closing line
// once, never so long that a frame sits still waiting for the film to be over.
export const CLOSE_TAIL = 1.2;
export const MOST_TAIL = 1.5;

// Settles the takes' ends in place, and hands back the one line the card says about it, if there is one.
export function settleLength(takes: Take[], words: Word[], target: number): string | undefined {
  const last = takes.at(-1);
  if (!last) return undefined;
  if (words.length) {
    const spoken = words.at(-1)!.at + words.at(-1)!.seconds;
    // The close ends a short, fixed beat after the last word — never earlier than the word itself, never later than
    // the tail. Whatever the takes had asked for beyond that was padding.
    if (last.to >= spoken) last.to = Math.round(Math.min(Math.max(last.to, spoken + CLOSE_TAIL), spoken + MOST_TAIL) * 1000) / 1000;
    else last.to = Math.round((spoken + CLOSE_TAIL) * 1000) / 1000;
    last.from = Math.min(last.from, last.to);
    const runs = last.to;
    if (target && runs < target * 0.9) {
      return `the reading came to ${Math.round(spoken)} seconds against ${target}, so the film is ${Math.round(runs)} seconds rather than holding its last line on screen for the difference`;
    }
    return undefined;
  }
  // A film nobody speaks in: the shortfall is spread across every scene, the payoff taking a double share, so the
  // editor has room to cut inside them rather than one long hold at the end.
  const runs = last.to;
  if (!target || runs <= 0 || runs >= target * 0.96) return undefined;
  const short = target * 0.98 - runs;
  const payoff = Math.max(0, takes.length - 2);
  const weights = takes.map((one, index) => Math.max(0.2, one.to - one.from) * (index === payoff ? 2 : 1));
  const whole = weights.reduce((sum, one) => sum + one, 0) || 1;
  let shift = 0;
  for (const [index, one] of takes.entries()) {
    const share = (short * weights[index]) / whole;
    one.from += shift;
    one.to += shift + share;
    shift += share;
  }
  return `the cards came to ${Math.round(runs)} seconds against ${target}, so every scene is given a little more room rather than the film ending early`;
}

// --- how long the storyboard reads, before anything is recorded ------------------------------------------------
//
// A film follows its reading (above), so a storyboard that reads short is a film that runs short. The site's hero
// film came back anywhere from twelve to twenty seconds for the same twenty-second ask, because the director wrote
// fewer words some runs than others and nothing asked it for more. Padding the time is not the answer: it is the
// frozen caption again. The answer is more to say, so a storyboard that reads under 85% of the asked length sends
// the director back once for as many more lines as fill it, and one that reads over 115% loses scenes from the
// middle acts, never the opening or the close.
export const SHORT_OF = 0.85;
export const LONG_OF = 1.15;
// The words one more line is worth: a calm sentence a viewer takes in one breath.
export const WORDS_A_LINE = 9;
const BEAT: Record<Pace, number> = { punchy: 0.4, calm: 0.45 };

// How long a storyboard reads aloud: its words at the narrator's pace, and the pause the voice leaves between scenes.
export function readingOf(spec: Spec, pace: Pace): number {
  return saidWords(spec) / WORDS_A_SECOND + spec.scenes.length * BEAT[pace];
}

export type LengthFit = { more: number; words: number } | { drop: number[] } | null;
export function lengthFit(spec: Spec, seconds: number, pace: Pace): LengthFit {
  if (!seconds || !spec.scenes.length) return null;
  const reads = readingOf(spec, pace);
  if (reads < seconds * SHORT_OF) {
    const words = Math.round((seconds - reads) * WORDS_A_SECOND - BEAT[pace] * WORDS_A_SECOND);
    const more = Math.max(1, Math.round(words / WORDS_A_LINE));
    return { more, words: Math.max(words, more * 4) };
  }
  if (reads > seconds * LONG_OF && spec.scenes.length > 3) {
    // The middle acts, from the centre outwards: the opening sets the film up and the close ends it, and a real
    // screenshot of the product is the last middle scene to go.
    const middle = spec.scenes.map((_one, at) => at).slice(1, -1)
      .sort((a, b) => Number(spec.scenes[a].layout === 'device') - Number(spec.scenes[b].layout === 'device')
        || Math.abs(a - (spec.scenes.length - 1) / 2) - Math.abs(b - (spec.scenes.length - 1) / 2));
    const drop: number[] = [];
    let left = reads;
    for (const at of middle) {
      if (left <= seconds || spec.scenes.length - drop.length <= 3) break;
      drop.push(at);
      left -= countWords(spec.scenes[at].say) / WORDS_A_SECOND + BEAT[pace];
    }
    return drop.length ? { drop: drop.sort((a, b) => a - b) } : null;
  }
  return null;
}
