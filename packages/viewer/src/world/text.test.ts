import { describe, it, expect } from 'vitest';
import { RES, FONT, MONO, NAME_LABEL_ZOOM, NAME_LABEL_PX, nameLabelView, nameLabelScale, nameLabelStyle, signLabelStyle } from './text.js';
import { PALETTE } from './palette.js';

describe('name labels (ruling F1)', () => {
  it('is hidden below zoom 2 — at zoom 1 a row of names is a smear across the desks', () => {
    expect(NAME_LABEL_ZOOM).toBe(2);
    expect(nameLabelView(1).visible).toBe(false);
    expect(nameLabelView(1.9).visible).toBe(false);
    expect(nameLabelView(2).visible).toBe(true);
    expect(nameLabelView(4).visible).toBe(true);
  });

  it('shows at any zoom on hover or selection: pointing at someone is how you ask who they are', () => {
    expect(nameLabelView(1, { hover: true }).visible).toBe(true);
    expect(nameLabelView(1, { selected: true }).visible).toBe(true);
    expect(nameLabelView(0.5, { hover: true }).visible).toBe(true);
  });

  it('holds a constant screen height at every zoom it is drawn at', () => {
    // The label is rasterised at NAME_LABEL_PX * RES and lives inside a container the camera zoom scales, so the
    // on-screen height is rasterSize × scale × zoom. That product must not move.
    const raster = NAME_LABEL_PX * RES;
    for (const zoom of [1, 2, 3, 4, 2.5]) {
      expect(raster * nameLabelScale(zoom) * zoom, `zoom ${zoom}`).toBeCloseTo(NAME_LABEL_PX);
      expect(raster * nameLabelView(zoom).scale * zoom, `zoom ${zoom}`).toBeCloseTo(NAME_LABEL_PX);
    }
    // what the old code did — a fixed 1/RES — grew with the zoom: 9 px at zoom 1, 36 px at zoom 4
    expect(raster * (1 / RES) * 4).toBe(36);
  });

  it('never divides by zero on a degenerate zoom', () => {
    expect(Number.isFinite(nameLabelScale(0))).toBe(true);
    expect(nameLabelScale(0)).toBeGreaterThan(0);
  });
});

describe('one set of in-world text constants', () => {
  it('rasterises at 3× and uses one font stack with real fallbacks', () => {
    expect(RES).toBe(3);
    expect(FONT).toMatch(/^system-ui,/);
    expect(FONT.split(',').length).toBeGreaterThan(3);   // headless and minimal systems have no system-ui
    expect(MONO).toMatch(/monospace$/);
  });
  it('draws the shared label and sign styles from the palette', () => {
    const label = nameLabelStyle();
    expect(label).toEqual({ fontFamily: FONT, fontSize: `${NAME_LABEL_PX * RES}px`, color: PALETTE.labelInk, stroke: PALETTE.labelStroke, strokeThickness: 2 * RES });
    const sign = signLabelStyle('#334455');
    expect(sign.backgroundColor).toBe('#334455');
    expect(sign.fontFamily).toBe(FONT);
    expect(sign.color).toBe(PALETTE.labelInk);
  });
});
