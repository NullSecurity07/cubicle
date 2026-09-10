import { describe, it, expect } from 'vitest';
import { snapZoom, floorZoom, ZOOM_STEPS, FLOOR_VIEW } from './camera.js';

describe('camera zoom', () => {
  it('snaps to the nearest integer step and clamps', () => {
    expect(ZOOM_STEPS).toEqual([1, 2, 3, 4, 5]);
    expect(snapZoom(1.4)).toBe(1); expect(snapZoom(1.6)).toBe(2); expect(snapZoom(0.3)).toBe(1); expect(snapZoom(9)).toBe(5);
  });
  it('floorZoom fits one floor (51+2 tiles wide, 14+2 tall) into the view', () => {
    expect(FLOOR_VIEW).toEqual({ w: 53 * 16, h: 16 * 16 });
    expect(floorZoom(1280, 800)).toBe(2);
    expect(floorZoom(800, 600)).toBe(1);
    expect(floorZoom(3000, 2000)).toBe(4);
    expect(floorZoom(10000, 10000)).toBe(5);
  });
});
