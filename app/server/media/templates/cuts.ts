import type { Cut } from './packs.ts';

// What happens between two scenes, written as moves on the film's own clock.
//
// The renderer hides a timed section outside its own window, so two scenes cannot be on screen at once unless the one
// leaving is given a little longer to leave in. That is exactly what happens: every scene but the last carries its own
// length plus the pack's overlap, and spends that overlap sliding, blurring or scaling out from under the next one,
// which is arriving over the top of it. Later sections paint over earlier ones, so the new scene is always the one on
// top, which is what a cut looks like.
//
// Everything here is a `fromTo`, because a paused timeline that is seeked rather than played has to be able to land on
// any frame and be right.

export type Move = { into: string[]; outOf: string[] };

// One transition, as the move the arriving scene makes and the move the leaving one makes. `box` is the scene's own
// wrapper; `at` is when the scene starts; `out` is when it begins to leave; `span` is how long either move takes.
export function cutSteps(cut: Cut, box: string, at: number, out: number, span: number, index: number): Move {
  const t = (value: number) => value.toFixed(3);
  const s = span.toFixed(2);
  // A whip alternates its direction, so a film of them reads as a camera moving rather than a tic.
  const way = index % 2 === 0 ? 1 : -1;
  const into: string[] = [];
  const outOf: string[] = [];
  switch (cut) {
    case 'whip':
      into.push(`tl.fromTo("${box}", { xPercent: ${58 * way}, filter: "blur(16px)", opacity: 0.2 }, { xPercent: 0, filter: "blur(0px)", opacity: 1, duration: ${s}, ease: "power3.out" }, ${t(at)});`);
      outOf.push(`tl.to("${box}", { xPercent: ${-34 * way}, filter: "blur(20px)", opacity: 0, duration: ${s}, ease: "power2.in" }, ${t(out)});`);
      break;
    case 'zoom':
      into.push(`tl.fromTo("${box}", { scale: 1.32, opacity: 0, filter: "blur(12px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: ${s}, ease: "power3.out" }, ${t(at)});`);
      outOf.push(`tl.to("${box}", { scale: 1.26, opacity: 0, filter: "blur(14px)", duration: ${s}, ease: "power2.in" }, ${t(out)});`);
      break;
    case 'wipe':
      into.push(`tl.fromTo("${box}", { clipPath: "inset(0% 0% 0% 100%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: ${s}, ease: "power4.inOut" }, ${t(at)});`);
      outOf.push(`tl.to("${box}", { opacity: 0, duration: ${s}, ease: "power2.in" }, ${t(out)});`);
      break;
    case 'push':
      into.push(`tl.fromTo("${box}", { yPercent: 100 }, { yPercent: 0, duration: ${s}, ease: "power3.out" }, ${t(at)});`);
      outOf.push(`tl.to("${box}", { yPercent: -22, opacity: 0, duration: ${s}, ease: "power2.in" }, ${t(out)});`);
      break;
    case 'cut':
      // A match cut: no dissolve at all, one frame's worth of scale so the two shots lock together.
      into.push(`tl.fromTo("${box}", { scale: 1.05, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.10, ease: "power2.out" }, ${t(at)});`);
      outOf.push(`tl.to("${box}", { opacity: 0, duration: 0.06, ease: "none" }, ${t(out + span - 0.06)});`);
      break;
    default:
      into.push(`tl.fromTo("${box}", { opacity: 0 }, { opacity: 1, duration: ${s}, ease: "power2.out" }, ${t(at)});`);
      outOf.push(`tl.to("${box}", { opacity: 0, duration: ${s}, ease: "power2.in" }, ${t(out)});`);
  }
  return { into, outOf };
}

// A cut lands better on a beat than a fraction of a second away from one. When the bed came with its beats, every
// scene's start is pulled to the nearest one it can reach without changing the film's length by more than a hair —
// and nothing moves further than `reach`, because a scene that waits for the beat is worse than one that misses it.
export function snapToBeats(seconds: number[], beats: number[], reach = 0.22): number[] {
  if (!beats.length || seconds.length < 2) return seconds;
  const sorted = [...beats].sort((a, b) => a - b);
  const kept = [...seconds];
  let clock = 0;
  for (let index = 0; index < kept.length - 1; index += 1) {
    const end = clock + kept[index];
    const near = sorted.reduce((best, beat) => (Math.abs(beat - end) < Math.abs(best - end) ? beat : best), sorted[0]);
    const move = near - end;
    if (Math.abs(move) <= reach && kept[index] + move > 0.8 && kept[index + 1] - move > 0.8) {
      kept[index] = Math.round((kept[index] + move) * 100) / 100;
      kept[index + 1] = Math.round((kept[index + 1] - move) * 100) / 100;
    }
    clock += kept[index];
  }
  return kept;
}
