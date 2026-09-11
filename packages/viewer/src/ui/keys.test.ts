import { describe, it, expect } from 'vitest';
import { shortcutFor, SHORTCUTS, keysView } from './keys.js';

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
