import { describe, it, expect } from 'vitest';
import { bubbleOffsetX, BUBBLE_MARGIN } from './bubble.js';

/**
 * Visual QA I10: a speech bubble clamped against the world, not against the camera. In `08-board` it sat squarely
 * over the advisors' desks and the screen they were looking at; in `09-night` the bottom of the viewport cut it.
 */
const WORLD = 960;
const view = (x: number, width = 1280): { x: number; width: number } => ({ x, width });

describe('where a speech bubble hangs', () => {
  it('is centred on the speaker when the whole bubble is in view', () => {
    expect(bubbleOffsetX(480, 120, view(0), WORLD)).toBe(0);
  });

  it('slides in from an edge of the *camera*, not of the world', () => {
    // a speaker at the left edge of a camera that is looking at the middle of the map
    const off = bubbleOffsetX(320, 200, view(300, 640), WORLD);
    expect(off).toBeGreaterThan(0);
    expect(320 + off - (100 + BUBBLE_MARGIN)).toBeGreaterThanOrEqual(300);
    const right = bubbleOffsetX(920, 200, view(300, 640), WORLD);
    expect(right).toBeLessThan(0);
    expect(920 + right + 100 + BUBBLE_MARGIN).toBeLessThanOrEqual(940);
  });

  it('goes beside a seated speaker, on whichever side has more room', () => {
    const wide = view(0, 1280);
    expect(bubbleOffsetX(400, 120, wide, WORLD)).toBe(0);                 // standing: over the head
    expect(bubbleOffsetX(400, 120, wide, WORLD, true)).toBe(66);          // seated: to the right, the free side
    expect(bubbleOffsetX(900, 120, wide, WORLD, true)).toBe(-66);         // and to the left when that is the free side
  });

  it('never leaves the bubble half off the screen, seated or not', () => {
    for (const seated of [false, true]) {
      for (const x of [0, 40, 480, 900, 960]) {
        const w = 200, off = bubbleOffsetX(x, w, view(200, 700), WORLD, seated);
        expect(x + off - w / 2 - BUBBLE_MARGIN, `x ${x} seated ${seated}`).toBeGreaterThanOrEqual(200 - 1e-6);
        expect(x + off + w / 2 + BUBBLE_MARGIN, `x ${x} seated ${seated}`).toBeLessThanOrEqual(900 + 1e-6);
      }
    }
  });

  it('centres and lets it bleed when the view is narrower than the bubble itself', () => {
    expect(bubbleOffsetX(480, 400, view(400, 200), WORLD)).toBe(0);
  });
});
