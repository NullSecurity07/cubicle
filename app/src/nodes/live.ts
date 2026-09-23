// Turns the founder's pointer and keys on a browser card's live picture into the input messages its stream accepts.

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type MouseKind = 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
export type KeyKind = 'keyDown' | 'keyUp';
type Held = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };
type MouseLike = Held & { button: number; detail: number; deltaX?: number; deltaY?: number };
type KeyLike = Held & { key: string; code: string };

// The picture is contained and top-aligned, so it can sit inside a wider or taller box with empty space beside it.
export function toFrame(point: Point, box: Size, frame: Size): Point | null {
  if (box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  const [drawnWidth, drawnHeight] = [frame.width * scale, frame.height * scale];
  const left = (box.width - drawnWidth) / 2;
  const [x, y] = [(point.x - left) / scale, point.y / scale];
  if (x < 0 || y < 0 || x > frame.width || y > frame.height) return null;
  return { x: Math.min(Math.round(x), frame.width - 1), y: Math.min(Math.round(y), frame.height - 1) };
}

// Chrome's own bit per held key.
export const modifiers = (event: Held) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

const BUTTONS = ['left', 'middle', 'right'] as const;

export function mouseMessage(event: MouseLike, point: Point, kind: MouseKind) {
  const button = kind === 'mouseMoved' || kind === 'mouseWheel' ? 'none' : (BUTTONS[event.button] ?? 'none');
  const clickCount = kind === 'mousePressed' || kind === 'mouseReleased' ? Math.max(1, event.detail || 1) : 0;
  return {
    type: 'input_mouse', eventType: kind, x: point.x, y: point.y, button, clickCount, modifiers: modifiers(event),
    ...(kind === 'mouseWheel' ? { deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 0 } : {}),
  };
}

// Keys Chrome only acts on with their Windows key code; the typed ones also carry the character they make.
const SPECIAL: Record<string, { code: number; text?: string }> = {
  Enter: { code: 13, text: '\r' }, Tab: { code: 9, text: '\t' }, Backspace: { code: 8 }, Escape: { code: 27 },
  ArrowLeft: { code: 37 }, ArrowUp: { code: 38 }, ArrowRight: { code: 39 }, ArrowDown: { code: 40 },
  Delete: { code: 46 }, Home: { code: 36 }, End: { code: 35 }, PageUp: { code: 33 }, PageDown: { code: 34 }, ' ': { code: 32 },
};

// Letters and digits share their key code with the capital character; punctuation gets none, so it never reads as Delete.
const keyCode = (key: string) => SPECIAL[key]?.code ?? (/^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0);

export function keyMessage(event: KeyLike, kind: KeyKind) {
  const printable = [...event.key].length === 1;
  // A shortcut held with Ctrl or Meta types nothing.
  const text = kind !== 'keyDown' || event.ctrlKey || event.metaKey ? undefined : printable ? event.key : SPECIAL[event.key]?.text;
  return {
    type: 'input_keyboard', eventType: kind, key: event.key, code: event.code, modifiers: modifiers(event),
    windowsVirtualKeyCode: keyCode(event.key), ...(text !== undefined ? { text } : {}),
  };
}
