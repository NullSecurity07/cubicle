import { describe, it, expect } from 'vitest';
import { tickLayout, minimapPointToWorld, layoutKey, chromeVisibility, BUILDING_ROWS, FLOOR_ROWS } from './minimap.js';

describe('minimap chrome', () => {
  // The brief pinned 52 building rows and four 26 px ticks in a 104 px camera. The map says otherwise: BUILDING is
  // rows 2..54 inclusive = 53, because the four 13-row floors share a slab row each (4 x 13 + 1). Geometry wins, so a
  // floor is 13/53 of the camera, the ticks sit slightly tighter, and the last one ends one row short of the bottom.
  it('lays four equal floor ticks from F4 at the top to F1 at the bottom, in floor colours', () => {
    const ticks = tickLayout(106, { 1: '#a', 2: '#b', 3: '#c', 4: '#d' });
    expect(ticks.map((t) => t.floor)).toEqual([4, 3, 2, 1]);
    expect(ticks[0]).toEqual({ floor: 4, top: 0, height: 26, color: '#d' });
    expect(ticks[3]).toEqual({ floor: 1, top: 78, height: 26, color: '#a' });
  });
  it('sizes a tick as one floor out of the whole building, leaving the shared slab row over', () => {
    expect(BUILDING_ROWS).toBe(53);
    expect(BUILDING_ROWS - 4 * FLOOR_ROWS).toBe(1);
    const ticks = tickLayout(530, {});
    expect(ticks.map((t) => t.height)).toEqual([130, 130, 130, 130]);
    expect(ticks.map((t) => t.top)).toEqual([0, 130, 260, 390]);
    expect(ticks[3].top + ticks[3].height).toBe(520);   // 10 px, one row, left under F1
  });
  it('maps a click in the minimap to the world point under it', () => {
    expect(minimapPointToWorld(60, 65, { scrollX: 64, scrollY: 32, zoom: 0.125 })).toEqual({ x: 544, y: 552 });
  });
});

/** M10: `layout()` wrote four inline styles and morphed four ticks every beat, hidden or not. */
describe('the chrome lays itself out only when something moved', () => {
  const cam = { x: 1114, y: 628, width: 154, height: 160 };
  const colours = { 1: '#a', 2: '#b', 3: '#c', 4: '#d' };
  it('is the same key for the same window and the same floors', () => {
    expect(layoutKey(cam, colours)).toBe(layoutKey({ ...cam }, { ...colours }));
  });
  it('changes when the window moves, which is the case it exists for', () => {
    expect(layoutKey({ ...cam, x: 1115 }, colours)).not.toBe(layoutKey(cam, colours));
    expect(layoutKey({ ...cam, height: 161 }, colours)).not.toBe(layoutKey(cam, colours));
  });
  it('changes when a floor is repainted, so the ticks are not stuck on the old hue', () => {
    expect(layoutKey(cam, { ...colours, 3: '#z' })).not.toBe(layoutKey(cam, colours));
  });
  it('covers all four floors, including one the scene has not reported yet', () => {
    expect(layoutKey(cam, { 1: '#a' })).toBe(layoutKey(cam, { 1: '#a' }));
    expect(layoutKey(cam, { 1: '#a' })).not.toBe(layoutKey(cam, colours));
  });
});

/**
 * Visual QA R-M8: the tower elevation puts the minimap away, because at that fit it is the same picture as the
 * main view with a viewport rectangle over all of it. The first cut of that had the two controls the wrong way
 * round — the "Map" button appeared when the *scene* hid the strip, and never when the owner did, so `M` was a
 * one-way door for anyone using the mouse.
 */
describe('which minimap control is on the screen', () => {
  it('shows the strip and no button while the strip is up', () => {
    expect(chromeVisibility(true, true)).toEqual({ strip: true, showBtn: false });
  });
  it('offers the way back only when the owner is the one who hid it', () => {
    expect(chromeVisibility(false, false)).toEqual({ strip: false, showBtn: true });
  });
  it('says nothing when the elevation hid it: it comes back by itself', () => {
    expect(chromeVisibility(false, true)).toEqual({ strip: false, showBtn: false });
  });
});
