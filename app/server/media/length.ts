import type { Take } from './editor.ts';
import type { Word } from './timings.ts';

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
