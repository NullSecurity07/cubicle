import { describe, it, expect } from 'vitest';
import { snapPixels, rgbOf, worldTextVisible, nameLabelStyle, signLabelStyle } from './text.js';
import { stylePalette, flatten } from './text-crisp.js';
import { PALETTE } from './palette.js';

/**
 * Visual QA I5: in-world type was rasterised at 3× and drawn at 1/3, so the raster ratio was `zoom / 3` —
 * resampled at every zoom but 3, and at 0.17 in the tower fit. Rasterising once per world pixel fixes the ratio;
 * `snapPixels` is the other half, flattening the rasteriser's own anti-aliasing so one world pixel of a glyph is
 * one colour and an integer zoom turns it into a uniform block rather than a grey fringe.
 */
const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];
const pixels = (...rows: [number, number, number, number][]): Uint8ClampedArray => Uint8ClampedArray.from(rows.flat());
const at = (d: Uint8ClampedArray, i: number): number[] => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]];

describe('flattening a rasterised glyph to pixel type', () => {
  it('drops thin coverage and makes everything else fully opaque', () => {
    const d = pixels([255, 255, 255, 20], [255, 255, 255, 255], [200, 200, 200, 140]);
    snapPixels(d, [WHITE, BLACK]);
    expect(at(d, 0)[3]).toBe(0);
    expect(at(d, 1)).toEqual([255, 255, 255, 255]);
    expect(at(d, 2)).toEqual([255, 255, 255, 255]);
  });

  it('snaps a half-lit rim to the nearer of the style’s own colours, never to a halo', () => {
    const d = pixels([110, 110, 110, 255], [180, 180, 180, 255]);
    snapPixels(d, [WHITE, BLACK]);
    expect(at(d, 0)).toEqual([0, 0, 0, 255]);
    expect(at(d, 1)).toEqual([255, 255, 255, 255]);
  });

  it('leaves a canvas alone when the style offered no colours to snap to', () => {
    const d = pixels([7, 8, 9, 33]);
    snapPixels(d, []);
    expect(at(d, 0)).toEqual([7, 8, 9, 33]);
  });

  it('reads hex colours and refuses anything a candidate cannot be', () => {
    expect(rgbOf('#e6a93c')).toEqual([230, 169, 60]);
    expect(rgbOf('rgba(0,0,0,0.5)')).toBeNull();
    expect(rgbOf(undefined)).toBeNull();
  });

  it('takes the candidate colours from the style: ink, stroke and plate', () => {
    expect(stylePalette(nameLabelStyle())).toEqual([rgbOf(PALETTE.labelInk), rgbOf(PALETTE.labelStroke)]);
    expect(stylePalette(signLabelStyle('#334455'))).toEqual([rgbOf(PALETTE.labelInk), rgbOf('#334455')]);
  });

  it('does nothing at all to a text object that has no canvas (the test stubs, and a headless boot)', () => {
    expect(() => flatten({}, [WHITE])).not.toThrow();
    expect(() => flatten({ canvas: { width: 0, height: 0 } as HTMLCanvasElement }, [WHITE])).not.toThrow();
  });
});

describe('in-world lettering by elevation', () => {
  it('is drawn from the floor elevation up and not at the tower fit', () => {
    expect(worldTextVisible(0.5)).toBe(false);
    expect(worldTextVisible(1)).toBe(true);
    expect(worldTextVisible(4)).toBe(true);
  });
});
