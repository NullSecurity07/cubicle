import { describe, it, expect } from 'vitest';
import { snapZoom, floorZoom, ZOOM_STEPS, FLOOR_VIEW, zoomSnap, snapZoomDown, fitZoom } from './camera.js';

describe('camera zoom', () => {
  it('snaps to the nearest integer step and clamps', () => {
    expect(ZOOM_STEPS).toEqual([1, 2, 3, 4]);
    expect(snapZoom(1.4)).toBe(1); expect(snapZoom(1.6)).toBe(2); expect(snapZoom(0.3)).toBe(1); expect(snapZoom(9)).toBe(4);
  });
  it('floorZoom fits one floor (51+2 tiles wide, 14+2 tall) into the view', () => {
    expect(FLOOR_VIEW).toEqual({ w: 53 * 16, h: 16 * 16 });
    expect(floorZoom(1280, 800)).toBe(1);
    expect(floorZoom(800, 600)).toBe(1);
    expect(floorZoom(3000, 2000)).toBe(3);
    expect(floorZoom(10000, 10000)).toBe(4);
  });
});

describe('integer zoom (visual layer)', () => {
  it('ZOOM_STEPS is 1..4 and the wheel snaps through it, clamping at the ends', () => {
    expect(ZOOM_STEPS).toEqual([1, 2, 3, 4]);
    expect(zoomSnap(2, 1)).toBe(3); expect(zoomSnap(4, 1)).toBe(4); expect(zoomSnap(1, -1)).toBe(1);
    expect(zoomSnap(1.4, 1)).toBe(2); expect(zoomSnap(1.4, -1)).toBe(1); expect(zoomSnap(2.2, -1)).toBe(2); expect(zoomSnap(0.6, 1)).toBe(1);
  });
  it('snapZoomDown floors to the steps; fitZoom is the smaller ratio; floorZoom fits 85 % and snaps down', () => {
    expect(snapZoomDown(3.03)).toBe(3); expect(snapZoomDown(1.51)).toBe(1); expect(snapZoomDown(0.7)).toBe(1); expect(snapZoomDown(9)).toBe(4);
    expect(fitZoom(1280, 800, 816, 848)).toBeCloseTo(800 / 848);
    expect(floorZoom(1280, 800)).toBe(1);     // 1280 × .85 / 848 = 1.28 → 1
    expect(floorZoom(2560, 1440)).toBe(2);    // 2560 × .85 / 848 = 2.57 → 2
    expect(floorZoom(800, 600)).toBe(1); expect(floorZoom(3000, 2000)).toBe(3); expect(floorZoom(10000, 10000)).toBe(4);
  });
});
