import { describe, expect, it } from 'vitest';
import { keyMessage, mouseMessage, toFrame } from './live';

const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe('toFrame', () => {
  it('maps a box of the same shape straight to page pixels', () => {
    expect(toFrame({ x: 320, y: 180 }, { width: 640, height: 360 }, { width: 1280, height: 720 })).toEqual({ x: 640, y: 360 });
  });
  it('centres a picture narrower than its box and ignores the empty sides', () => {
    // A 1280x720 page in a 1000x360 box is drawn 640 wide, starting 180 in.
    const box = { width: 1000, height: 360 };
    const frame = { width: 1280, height: 720 };
    expect(toFrame({ x: 180, y: 0 }, box, frame)).toEqual({ x: 0, y: 0 });
    expect(toFrame({ x: 500, y: 180 }, box, frame)).toEqual({ x: 640, y: 360 });
    expect(toFrame({ x: 100, y: 100 }, box, frame)).toBeNull();
    expect(toFrame({ x: 900, y: 100 }, box, frame)).toBeNull();
  });
  it('top-aligns a picture shorter than its box and ignores the space below', () => {
    // A 1280x720 page in a 640x600 box is drawn 360 tall from the top.
    const box = { width: 640, height: 600 };
    const frame = { width: 1280, height: 720 };
    expect(toFrame({ x: 640, y: 360 }, box, frame)).toEqual({ x: 1279, y: 719 });
    expect(toFrame({ x: 10, y: 400 }, box, frame)).toBeNull();
  });
  it('says nothing before the first frame or with an empty box', () => {
    expect(toFrame({ x: 1, y: 1 }, { width: 0, height: 0 }, { width: 1280, height: 720 })).toBeNull();
    expect(toFrame({ x: 1, y: 1 }, { width: 100, height: 100 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe('mouseMessage', () => {
  it('presses the left button with the click count and held keys', () => {
    expect(mouseMessage({ ...none, shiftKey: true, ctrlKey: true, button: 0, detail: 2 }, { x: 5, y: 6 }, 'mousePressed'))
      .toEqual({ type: 'input_mouse', eventType: 'mousePressed', x: 5, y: 6, button: 'left', clickCount: 2, modifiers: 10 });
  });
  it('names the right button and counts at least one click', () => {
    expect(mouseMessage({ ...none, button: 2, detail: 0 }, { x: 1, y: 1 }, 'mouseReleased')).toMatchObject({ button: 'right', clickCount: 1 });
  });
  it('moves with no button and no clicks', () => {
    expect(mouseMessage({ ...none, button: 0, detail: 0 }, { x: 1, y: 2 }, 'mouseMoved')).toMatchObject({ button: 'none', clickCount: 0 });
  });
  it('carries wheel deltas only on a wheel', () => {
    expect(mouseMessage({ ...none, altKey: true, metaKey: true, button: 0, detail: 0, deltaX: 3, deltaY: -120 }, { x: 1, y: 2 }, 'mouseWheel'))
      .toEqual({ type: 'input_mouse', eventType: 'mouseWheel', x: 1, y: 2, button: 'none', clickCount: 0, modifiers: 5, deltaX: 3, deltaY: -120 });
    expect(mouseMessage({ ...none, button: 0, detail: 1, deltaY: 5 }, { x: 1, y: 2 }, 'mousePressed')).not.toHaveProperty('deltaY');
  });
});

describe('keyMessage', () => {
  it('types a printable character on key down only', () => {
    expect(keyMessage({ ...none, key: 'h', code: 'KeyH' }, 'keyDown'))
      .toEqual({ type: 'input_keyboard', eventType: 'keyDown', key: 'h', code: 'KeyH', modifiers: 0, windowsVirtualKeyCode: 72, text: 'h' });
    expect(keyMessage({ ...none, key: 'h', code: 'KeyH' }, 'keyUp')).not.toHaveProperty('text');
  });
  it('keeps a capital with Shift held', () => {
    expect(keyMessage({ ...none, shiftKey: true, key: 'H', code: 'KeyH' }, 'keyDown')).toMatchObject({ text: 'H', modifiers: 8, windowsVirtualKeyCode: 72 });
  });
  it('gives punctuation no key code so it never acts as another key', () => {
    expect(keyMessage({ ...none, key: '.', code: 'Period' }, 'keyDown')).toMatchObject({ text: '.', windowsVirtualKeyCode: 0 });
  });
  it('sends Enter as a return and Backspace with its key code and no text', () => {
    expect(keyMessage({ ...none, key: 'Enter', code: 'Enter' }, 'keyDown')).toMatchObject({ text: '\r', windowsVirtualKeyCode: 13 });
    const back = keyMessage({ ...none, key: 'Backspace', code: 'Backspace' }, 'keyDown');
    expect(back).toMatchObject({ windowsVirtualKeyCode: 8 });
    expect(back).not.toHaveProperty('text');
  });
  it('types nothing for a shortcut or a named key', () => {
    expect(keyMessage({ ...none, ctrlKey: true, key: 'a', code: 'KeyA' }, 'keyDown')).toMatchObject({ modifiers: 2, windowsVirtualKeyCode: 65 });
    expect(keyMessage({ ...none, ctrlKey: true, key: 'a', code: 'KeyA' }, 'keyDown')).not.toHaveProperty('text');
    expect(keyMessage({ ...none, key: 'ArrowLeft', code: 'ArrowLeft' }, 'keyDown')).not.toHaveProperty('text');
    expect(keyMessage({ ...none, key: 'Shift', code: 'ShiftLeft' }, 'keyDown')).toMatchObject({ windowsVirtualKeyCode: 0 });
  });
});
