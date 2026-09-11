import { describe, it, expect } from 'vitest';
import { snapZoom, floorZoom, ZOOM_STEPS, FLOOR_VIEW, FLOOR_ROWS, BARS_H, zoomSnap, snapZoomDown, fitZoom } from './camera.js';

describe('camera zoom', () => {
  it('snaps to the nearest integer step and clamps', () => {
    expect(ZOOM_STEPS).toEqual([1, 2, 3, 4]);
    expect(snapZoom(1.4)).toBe(1); expect(snapZoom(1.6)).toBe(2); expect(snapZoom(0.3)).toBe(1); expect(snapZoom(9)).toBe(4);
  });
  it('floorZoom fits a floor\'s 17 rows into the viewport minus the bars, height only (ruling F2)', () => {
    expect(FLOOR_VIEW).toEqual({ w: 53 * 16, h: 16 * 16 });
    expect({ FLOOR_ROWS, BARS_H }).toEqual({ FLOOR_ROWS: 17, BARS_H: 104 });
    expect(floorZoom(1280, 800)).toBe(2);      // (800 - 104) / 272 = 2.55 → 2: a floor actually fills the screen
    expect(floorZoom(800, 600)).toBe(1);       // (600 - 104) / 272 = 1.82 → 1: a short viewport falls back to 1
    expect(floorZoom(1280, 1500)).toBe(4);     // clamped to the top step
    expect(floorZoom(10000, 10000)).toBe(4);
  });
  it('floorZoom ignores the viewport width — the width term is what used to pin every floor at zoom 1', () => {
    for (const w of [600, 1280, 2560, 5000]) expect(floorZoom(w, 800)).toBe(2);
  });
});

describe('integer zoom (visual layer)', () => {
  it('ZOOM_STEPS is 1..4 and the wheel snaps through it, clamping at the ends', () => {
    expect(ZOOM_STEPS).toEqual([1, 2, 3, 4]);
    expect(zoomSnap(2, 1)).toBe(3); expect(zoomSnap(4, 1)).toBe(4); expect(zoomSnap(1, -1)).toBe(1);
    expect(zoomSnap(1.4, 1)).toBe(2); expect(zoomSnap(1.4, -1)).toBe(1); expect(zoomSnap(2.2, -1)).toBe(2); expect(zoomSnap(0.6, 1)).toBe(1);
  });
  it('snapZoomDown floors to the steps; fitZoom is the smaller ratio; floorZoom fits the rows and snaps down', () => {
    expect(snapZoomDown(3.03)).toBe(3); expect(snapZoomDown(1.51)).toBe(1); expect(snapZoomDown(0.7)).toBe(1); expect(snapZoomDown(9)).toBe(4);
    expect(fitZoom(1280, 800, 816, 848)).toBeCloseTo(800 / 848);
    expect(floorZoom(1280, 800)).toBe(2);     // (800 - 104) / 272 = 2.55 → 2
    expect(floorZoom(2560, 1440)).toBe(4);    // (1440 - 104) / 272 = 4.91 → 4 (clamped)
    expect(floorZoom(800, 600)).toBe(1); expect(floorZoom(3000, 1000)).toBe(3); expect(floorZoom(10000, 10000)).toBe(4);
  });
});
