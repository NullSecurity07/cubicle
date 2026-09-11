import { describe, it, expect, afterEach } from 'vitest';
import { shortcutFor, SHORTCUTS, keysView, bindKeys, isControl, trapTab, type Action } from './keys.js';

describe('shortcuts', () => {
  it('maps keys to actions', () => {
    expect(shortcutFor({ key: '1' }, false)).toBe('floor1');
    expect(shortcutFor({ key: '4' }, false)).toBe('floor4');
    expect(shortcutFor({ key: 'l' }, false)).toBe('lobby');
    expect(shortcutFor({ key: 'L' }, false)).toBe('lobby');
    expect(shortcutFor({ key: '0' }, false)).toBe('fit');
    expect(shortcutFor({ key: 't' }, false)).toBe('talk');
    expect(shortcutFor({ key: 'q' }, false)).toBe('queue');
    expect(shortcutFor({ key: 'b' }, false)).toBe('brief');
    expect(shortcutFor({ key: 'p' }, false)).toBe('plan');
    expect(shortcutFor({ key: 'o' }, false)).toBe('org');
    expect(shortcutFor({ key: ' ' }, false)).toBe('pause');
    expect(shortcutFor({ key: 'ArrowLeft' }, false)).toBe('prev');
    expect(shortcutFor({ key: 'ArrowRight' }, false)).toBe('next');
    expect(shortcutFor({ key: 'm' }, false)).toBe('minimap');
    expect(shortcutFor({ key: '?' }, false)).toBe('help');
    expect(shortcutFor({ key: '/' }, false)).toBe('quickopen');
    expect(shortcutFor({ key: 'k', ctrlKey: true }, false)).toBe('quickopen');
    expect(shortcutFor({ key: 'k', metaKey: true }, false)).toBe('quickopen');
  });
  it('while typing only the quick-open chord fires; Escape is the panel’s and modifiers are left alone', () => {
    expect(shortcutFor({ key: 'q' }, true)).toBeNull();
    expect(shortcutFor({ key: '/' }, true)).toBeNull();
    expect(shortcutFor({ key: 'k', ctrlKey: true }, true)).toBe('quickopen');
    expect(shortcutFor({ key: 'Escape' }, false)).toBeNull();
    expect(shortcutFor({ key: 'q', altKey: true }, false)).toBeNull();
    expect(shortcutFor({ key: 'q', ctrlKey: true }, false)).toBeNull();
  });
  it('the shortcut sheet lists every shortcut as a kbd row', () => {
    const v = keysView();
    expect(v.mode).toBe('drawer'); expect(v.title).toBe('Shortcuts');
    for (const s of SHORTCUTS) expect(v.html).toContain(s.label);
    expect((v.html.match(/<kbd>/g) ?? []).length).toBeGreaterThanOrEqual(SHORTCUTS.length);
  });
});

/** A key event as the browser would hand it to the window listener. */
const ev = (key: string, target: unknown, shiftKey = false): { key: string; shiftKey: boolean; target: unknown; prevented: boolean; stopped: boolean; preventDefault(): void; stopPropagation(): void } => ({
  key, shiftKey, target, prevented: false, stopped: false,
  preventDefault(): void { this.prevented = true; }, stopPropagation(): void { this.stopped = true; },
});
const el = (tag: string, control: boolean): { tagName: string; isContentEditable: boolean; closest(sel: string): unknown } => ({
  tagName: tag, isContentEditable: false, closest: (sel: string) => (control && /button|role="tab"/.test(sel) ? {} : null),
});
const realWindow = (globalThis as { window?: unknown }).window;
afterEach(() => { (globalThis as { window?: unknown }).window = realWindow; });

describe('Space and the focus ring', () => {
  it('leaves Space to a focused button, tab or link and keeps it for the office', () => {
    expect(isControl(el('BUTTON', true))).toBe(true);
    expect(isControl(el('DIV', false))).toBe(false);
    expect(isControl(null)).toBe(false);

    const fired: Action[] = [];
    const listeners: ((e: unknown) => void)[] = [];
    (globalThis as { window?: unknown }).window = { addEventListener: (_t: string, fn: (e: unknown) => void) => listeners.push(fn), removeEventListener: () => {} };
    const actions: Action[] = ['floor1', 'floor2', 'floor3', 'floor4', 'lobby', 'fit', 'talk', 'queue', 'brief', 'plan', 'org', 'pause', 'prev', 'next', 'minimap', 'help', 'quickopen'];
    const handlers = Object.fromEntries(actions.map((a) => [a, (): void => { fired.push(a); }])) as unknown as Record<Action, () => void>;
    const off = bindKeys(handlers);

    const onButton = ev(' ', el('BUTTON', true));
    listeners[0](onButton);
    expect(fired).toEqual([]);                     // the button activates instead
    expect(onButton.prevented).toBe(false);

    const onCanvas = ev(' ', el('DIV', false));
    listeners[0](onCanvas);
    expect(fired).toEqual(['pause']);
    expect(onCanvas.prevented).toBe(true);

    listeners[0](ev('q', el('BUTTON', true)));     // other shortcuts are unaffected by the focus ring
    expect(fired).toEqual(['pause', 'queue']);
    off();
  });
});

describe('modal Tab trap', () => {
  it('cycles inside the element and never lets the panel see the event', () => {
    const focused: number[] = [];
    const items = [0, 1, 2].map((i) => ({ focus: () => focused.push(i) }));
    const root = { querySelectorAll: () => items };
    const fwd = ev('Tab', null);
    expect(trapTab(root, fwd, items[0])).toBe(true);
    expect(focused).toEqual([1]);
    expect(fwd.prevented).toBe(true); expect(fwd.stopped).toBe(true);   // the panel's window trap never runs
    trapTab(root, ev('Tab', null, true), items[0]);
    expect(focused).toEqual([1, 2]);               // Shift+Tab wraps to the end instead of the sheet underneath
    trapTab(root, ev('Tab', null), items[2]);
    expect(focused).toEqual([1, 2, 0]);
    trapTab(root, ev('Tab', null), null);          // focus outside: start at the top
    expect(focused).toEqual([1, 2, 0, 0]);
    expect(trapTab(root, ev('a', null), items[0])).toBe(false);
    expect(focused).toEqual([1, 2, 0, 0]);
  });
});
