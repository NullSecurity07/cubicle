// Where the Getting started list may sit: open, tucked to its head, or out of the way, so it never lies over the card
// the founder has just chosen or the stage has just brought forward (the partner's ask box after "add a partner").
export type Rect = { x: number; y: number; w: number; h: number };
export type Fit = 'open' | 'head' | 'away';

const meets = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// `full` is where the whole list would be and `head` where its head alone would be, both in window pixels.
export function sheetFit(full: Rect, head: Rect, cards: Rect[]): Fit {
  if (!cards.some((card) => meets(full, card))) return 'open';
  return cards.some((card) => meets(head, card)) ? 'away' : 'head';
}

// A card's place in window pixels: its stage position through the view ([x, y, zoom]), from the pane's own corner.
export function cardOnScreen(at: { x: number; y: number }, size: { w: number; h: number }, [x, y, zoom]: [number, number, number], pane: { x: number; y: number }): Rect {
  return { x: pane.x + x + at.x * zoom, y: pane.y + y + at.y * zoom, w: size.w * zoom, h: size.h * zoom };
}
