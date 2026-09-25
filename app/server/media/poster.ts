import { startsOf, type Film } from './templates/index.ts';

// The one frame that stands for a film wherever it cannot be played: the page before the video loads, a reduced
// motion visitor, a link preview.
//
// It used to be whatever was on screen six tenths of the way into the first shot, which in a captioned film is a
// caption caught in the middle of its phrase. The site's hero film went out with "to what they" as its poster. A
// poster is the film's opening title, settled, with nothing half-said on it: the first of the opening shots that
// writes a headline, taken once its words have landed, from the film set without its caption track.

// How far into its shot a headline has arrived and settled (the studio's poster always sat here), and how far from
// the cut it is kept.
export const SETTLE = 0.6;
const CLEAR_OF_CUT = 0.25;
// How far into a film its opening title can still be: the first three shots.
const OPENING = 3;

const writes = (shot: Film['shots'][number]): boolean =>
  [shot.scene.heading, shot.scene.text, ...(shot.scene.bullets ?? [])].some((one) => !!one?.trim());

export function posterOf(film: Film): { at: number; film: Film } {
  const { starts } = startsOf(film.shots);
  const titled = film.shots.slice(0, OPENING).findIndex(writes);
  const pick = titled >= 0 ? titled : 0;
  const seconds = film.shots[pick]?.seconds ?? 1;
  const into = Math.max(0, Math.min(seconds * SETTLE, seconds - CLEAR_OF_CUT));
  return { at: Math.round(((starts[pick] ?? 0) + into) * 100) / 100, film: { ...film, captions: false } };
}
