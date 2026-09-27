import { describe, expect, it } from 'vitest';
import { cardOnScreen, sheetFit } from './missionsFit';

// The Getting started list sits bottom-left: 288 wide, 300 tall when open, a 40-tall head when tucked.
const full = { x: 16, y: 584, w: 288, h: 300 };
const head = { x: 16, y: 844, w: 288, h: 40 };

describe('the Getting started list keeps clear of the card the founder is on', () => {
  it('stays open when no chosen card is under it', () => {
    expect(sheetFit(full, head, [])).toBe('open');
    expect(sheetFit(full, head, [{ x: 400, y: 200, w: 380, h: 520 }])).toBe('open');
  });

  it('tucks down to its head when the card reaches under the list but not under the head', () => {
    expect(sheetFit(full, head, [{ x: 200, y: 300, w: 380, h: 480 }])).toBe('head');
  });

  it('steps aside when even its head would sit on the card', () => {
    expect(sheetFit(full, head, [{ x: 200, y: 400, w: 380, h: 470 }])).toBe('away');
  });

  it('counts touching edges as clear', () => {
    expect(sheetFit(full, head, [{ x: 304, y: 0, w: 100, h: 900 }])).toBe('open');
  });

  it('puts a card where the window draws it, from the stage position, the view and the pane', () => {
    expect(cardOnScreen({ x: 100, y: 50 }, { w: 380, h: 520 }, [20, 10, 0.5], { x: 0, y: 0 })).toEqual({ x: 70, y: 35, w: 190, h: 260 });
    expect(cardOnScreen({ x: 0, y: 0 }, { w: 10, h: 10 }, [0, 0, 1], { x: 5, y: 7 })).toEqual({ x: 5, y: 7, w: 10, h: 10 });
  });
});
