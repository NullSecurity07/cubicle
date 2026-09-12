import { describe, it, expect } from 'vitest';
import { snapZoom, floorZoom, ZOOM_STEPS, FIT_STEPS, TOWER_ZOOM, FLOOR_VIEW, FLOOR_ROWS, BARS_H, CHROME, GUTTER, ROOF_SKY, zoomSnap, snapZoomDown, stepDown, fitZoom, fitCamera, cameraCentre, cameraBounds, clampTop, rectOfTiles, veilBands, veilAlpha, VEIL_ALPHA } from './camera.js';
import { CAPTION_BAND } from './text.js';

const VIEW = { w: 1280, h: 800 };
/** The tower as the scene frames it: the building's columns, the roof, and the last row of pavement. */
const TOWER = rectOfTiles(4, 2, 54, 63);

describe('camera zoom', () => {
  it('snaps to the nearest integer step and clamps', () => {
    expect(ZOOM_STEPS).toEqual([1, 2, 3, 4]);
    expect(snapZoom(1.4)).toBe(1); expect(snapZoom(1.6)).toBe(2); expect(snapZoom(0.3)).toBe(1); expect(snapZoom(9)).toBe(4);
  });
  it('the wheel snaps through the integer steps, clamping at the ends', () => {
    expect(zoomSnap(2, 1)).toBe(3); expect(zoomSnap(4, 1)).toBe(4); expect(zoomSnap(1, -1)).toBe(1);
    expect(zoomSnap(1.4, 1)).toBe(2); expect(zoomSnap(1.4, -1)).toBe(1); expect(zoomSnap(2.2, -1)).toBe(2); expect(zoomSnap(0.6, 1)).toBe(1);
  });
  it('snapZoomDown floors to the integer steps; stepDown also knows the tower half-step', () => {
    expect(snapZoomDown(3.03)).toBe(3); expect(snapZoomDown(1.51)).toBe(1); expect(snapZoomDown(0.7)).toBe(1); expect(snapZoomDown(9)).toBe(4);
    expect(FIT_STEPS).toEqual([0.5, 1, 2, 3, 4]);
    expect(stepDown(0.7)).toBe(0.5); expect(stepDown(0.4)).toBe(0.5); expect(stepDown(1)).toBe(1); expect(stepDown(2.9)).toBe(2);
    expect(fitZoom(1280, 800, 816, 848)).toBeCloseTo(800 / 848);
  });
});

/**
 * Visual QA C3: `fitTower` divided the raw canvas height, so the 52 px top bar ate F4's desks and the street was a
 * sliver; the zoom it landed on was 0.909, a fractional zoom in a module whose first line is "integer zooms only".
 */
describe('the tower fit', () => {
  it('knows the chrome the canvas runs under', () => {
    expect(CHROME).toEqual({ top: 52, bottom: 64, left: 44 });   // --bar-h, --time-h, --rail-w in ui/tokens.css
    expect(BARS_H).toBe(116);
    expect(FLOOR_VIEW).toEqual({ w: 53 * 16, h: 16 * 16 });
    expect(FLOOR_ROWS).toBe(14);
  });

  it('fits the roof, four floors, the lobby and the street between the bars, at an exact half', () => {
    const fit = fitCamera(VIEW.w, VIEW.h, TOWER);
    expect(fit.zoom).toBe(TOWER_ZOOM);
    // top of the roof and the last row of pavement, in screen pixels, against the band the bars leave free
    const top = (TOWER.y - (fit.cy - VIEW.h / 2 / fit.zoom)) * fit.zoom;
    const bottom = (TOWER.y + TOWER.h - (fit.cy - VIEW.h / 2 / fit.zoom)) * fit.zoom;
    expect(top).toBeGreaterThanOrEqual(CHROME.top);
    expect(bottom).toBeLessThanOrEqual(VIEW.h - CHROME.bottom);
    // and it is centred in that band, not in the canvas
    expect((top + bottom) / 2).toBeCloseTo(CHROME.top + (VIEW.h - BARS_H) / 2, 6);
  });

  it('clears the floor rail on the left', () => {
    const fit = fitCamera(VIEW.w, VIEW.h, TOWER);
    const left = (TOWER.x - (fit.cx - VIEW.w / 2 / fit.zoom)) * fit.zoom;
    expect(left).toBeGreaterThanOrEqual(CHROME.left);
  });

  it('takes a bigger step when the viewport can hold one', () => {
    expect(fitCamera(2600, 2200, TOWER).zoom).toBe(2);
  });
});

/**
 * Visual QA C4: `floorZoom` ignored the viewport width and picked zoom 2, at which 40 of the building's 51 columns
 * are on screen — the CTO's office in `06-f4` was an empty rectangle because its desk was off the left edge.
 */
describe('the floor fit', () => {
  const BUILDING_W = 51 * 16;
  it('shows the whole floor, both ends included, at 1280 × 800', () => {
    const z = floorZoom(VIEW.w, VIEW.h);
    expect(z).toBe(1);
    expect(BUILDING_W * z).toBeLessThanOrEqual(VIEW.w - CHROME.left - GUTTER * 2);
    expect(FLOOR_ROWS * 16 * z).toBeLessThanOrEqual(VIEW.h - BARS_H - GUTTER * 2);
  });
  it('takes a bigger step on a viewport wide enough for one, and never leaves an end cut', () => {
    for (const [w, h] of [[1280, 800], [1600, 1000], [2560, 1440], [3840, 2160]] as const) {
      const z = floorZoom(w, h);
      expect(ZOOM_STEPS).toContain(z);
      expect(BUILDING_W * z, `${w}×${h}`).toBeLessThanOrEqual(w - CHROME.left - GUTTER * 2);
    }
    expect(floorZoom(2560, 1440)).toBe(3);
    // Below the building's own width there is nothing to choose: zoom 1 is the floor of the set.
    expect(floorZoom(800, 600)).toBe(1);
  });
  it('centres the floor in the band the bars leave, not in the canvas', () => {
    const rect = rectOfTiles(4, 28, 54, 41);   // F2
    const c = cameraCentre(rect, 1);
    const top = (rect.y - (c.cy - VIEW.h / 2)) , bottom = (rect.y + rect.h - (c.cy - VIEW.h / 2));
    expect((top + bottom) / 2).toBeCloseTo(CHROME.top + (VIEW.h - BARS_H) / 2, 6);
  });
});

describe('camera bounds', () => {
  it('are wide enough that the tower elevation is never clamped against them', () => {
    const b = cameraBounds(VIEW.w, VIEW.h, 60 * 16, 64 * 16);
    expect(b.w).toBeGreaterThan(VIEW.w / TOWER_ZOOM);
    expect(b.h).toBeGreaterThan(VIEW.h / TOWER_ZOOM);
  });
});

describe('the focus veil', () => {
  const BUILDING = { x0: 4, x1: 54, y0: 2, y1: 54 };
  const WORLD = { cols: 60, rows: 64 };
  /** The tower's four floors as `world/map.ts` reports them: 14-row objects that overlap on the slab they share. */
  const FLOORS = [{ n: 1, y0: 41, y1: 54 }, { n: 2, y0: 28, y1: 41 }, { n: 3, y0: 15, y1: 28 }, { n: 4, y0: 2, y1: 15 }];
  const bands = (n: number): ReturnType<typeof veilBands> => veilBands(n, FLOORS, BUILDING, WORLD);
  const dimmed = (n: number, y: number): boolean => bands(n).some((b) => y >= b.y && y < b.y + b.h);

  it('covers the tower above and below the floor in focus, and the street', () => {
    expect(bands(2)).toEqual([
      { x: 4 * 16, y: 1 * 16, w: 51 * 16, h: 28 * 16 - CAPTION_BAND - 16 },
      { x: 4 * 16, y: 41 * 16 - CAPTION_BAND, w: 51 * 16, h: 56 * 16 - (41 * 16 - CAPTION_BAND) },
      { x: 0, y: 56 * 16, w: 60 * 16, h: 8 * 16 },
    ]);
  });

  /**
   * Visual QA R-C1: a screen's caption plate hangs above the screen's own top row, which is the slab of the floor
   * above it. Bands cut on the floor boundary dimmed every focused floor's own captions and lit the captions of
   * the floor below — "Terminal" measured 42 average when F2 was focused and 64 when F3 was.
   */
  it('keeps a screen and its caption plate on the same side of every edge', () => {
    for (const f of FLOORS) {
      const glass = f.y0 * 16 + 4;
      const caption = f.y0 * 16 - CAPTION_BAND + 1;
      for (const focus of [1, 2, 3, 4]) {
        expect(dimmed(focus, caption), `F${f.n} caption, focus F${focus}`).toBe(dimmed(focus, glass));
      }
      expect(dimmed(f.n, glass), `F${f.n} lit when focused`).toBe(false);
    }
  });

  it('bounds a floor by the floor below it, not by its own overlapping last row', () => {
    // F2's object runs to row 41, which is F1's own wall row: a cut at 42 left that row lit under a dimmed F1.
    // The band edges then sit one row higher again, to keep each floor's captions on its own side (R-C1), so the
    // lit band is the floor's caption row down to the row above its last corridor row.
    expect(dimmed(2, 41 * 16 + 8)).toBe(true);
    expect(dimmed(2, 39 * 16 + 8)).toBe(false);
    expect(dimmed(2, 40 * 16 + 8)).toBe(true);    // the row the floor below's captions hang in
    expect(dimmed(1, 54 * 16 + 8)).toBe(false);
  });

  /**
   * Visual QA R-I4 made this a picture rather than a principle: the bands ran one tile wide of the building on
   * each side, which nobody could see while every scene was night, and read as a hard vertical seam down both
   * edges of the frame the moment the floor scenes were taken by day.
   */
  it('never draws over the sky beside the building', () => {
    for (const n of [1, 2, 3, 4]) {
      for (const b of bands(n)) {
        if (b.y < (BUILDING.y1 + 2) * 16) { expect(b.x).toBe(BUILDING.x0 * 16); expect(b.x + b.w).toBe((BUILDING.x1 + 1) * 16); }
      }
    }
  });

  it('drops the band the floor has run out of, and draws none for a floor that is not there', () => {
    expect(bands(4).map((b) => b.y)).toEqual([15 * 16 - CAPTION_BAND, 56 * 16]);   // nothing above F4's caption row
    expect(bands(1)[0].y).toBe(1 * 16);
    expect(veilBands(9, FLOORS, BUILDING, WORLD)).toEqual([]);
  });

  it('is off at the tower elevation and on from the floor elevation up', () => {
    expect(veilAlpha(TOWER_ZOOM)).toBe(0);
    expect(veilAlpha(1)).toBe(VEIL_ALPHA);
    expect(veilAlpha(4)).toBe(VEIL_ALPHA);
    expect(VEIL_ALPHA).toBeGreaterThan(0.4);
    expect(VEIL_ALPHA).toBeLessThan(0.8);
  });
});

/**
 * Visual QA R-I1: `clampBottom` had no partner at the top, so the top floor was centred in the band with 229 px
 * of flat sky over the roof while the floors below ran off the bottom edge.
 */
describe('how much sky a floor view may hold', () => {
  const ROOF = 2 * 16;
  it('pins the roofline two tiles below the top bar on the top floor', () => {
    const cy = clampTop(cameraCentre(rectOfTiles(4, 2, 54, 15), 1).cy, 1, VIEW.h, ROOF);
    const roofOnScreen = (ROOF - (cy - VIEW.h / 2)) - CHROME.top;
    expect(roofOnScreen).toBeCloseTo(ROOF_SKY, 6);
  });
  it('leaves a floor that is already low enough exactly where it was', () => {
    const f1 = cameraCentre(rectOfTiles(4, 41, 54, 54), 1).cy;
    expect(clampTop(f1, 1, VIEW.h, ROOF)).toBe(f1);
    const f3 = cameraCentre(rectOfTiles(4, 15, 54, 28), 1).cy;
    expect(clampTop(f3, 1, VIEW.h, ROOF)).toBe(f3);
  });
  it('scales with the zoom, so a room elevation is not pushed into the sky', () => {
    for (const zoom of [1, 2, 3, 4]) {
      const cy = clampTop(0, zoom, VIEW.h, ROOF);
      expect((ROOF - (cy - VIEW.h / 2 / zoom)) * zoom - CHROME.top, `zoom ${zoom}`).toBeCloseTo(ROOF_SKY * zoom, 6);
    }
  });
});
