/**
 * Where a speech bubble hangs. Pure: no Phaser, no DOM — `world/agents.ts` owns the drawing, this owns the rule.
 */

/** Air between the bubble and the edge it is kept inside, in world pixels. */
export const BUBBLE_MARGIN = 6;

/**
 * The bubble's horizontal offset from the sprite that owns it, in world pixels.
 *
 * `view` is the camera's world rectangle (absent before the first frame). A bubble used to clamp against the
 * *world*, so in `08-board` one spoken at the table sat squarely over the advisors' desks and the screen they
 * were looking at, and in `09-night` the bottom of the viewport cut it (visual QA I10).
 *
 * Centred on the speaker where the whole bubble is in view; slid along until it is inside otherwise. A speaker
 * who is sitting down — a meeting, the one place a bubble reliably covers the thing it is about — gets it beside
 * them instead, on whichever side has more room. The caller draws the tail back under the speaker, so an offset
 * bubble still points at who said it.
 */
export function bubbleOffsetX(speakerX: number, w: number, view: { x: number; width: number } | undefined, worldW: number, aside = false): number {
  const half = w / 2 + BUBBLE_MARGIN;
  const left = view ? Math.max(view.x, 0) : 0;
  const right = view ? Math.min(view.x + view.width, worldW) : worldW;
  if (right - left < w) return 0;                                    // narrower than the bubble: centre and let it bleed
  const lo = left + half - speakerX, hi = right - half - speakerX;    // the offsets that keep the bubble inside
  const want = aside ? (right - speakerX >= speakerX - left ? half : -half) : 0;
  return Math.max(lo, Math.min(hi, want));
}
