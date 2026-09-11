import { describe, it, expect } from 'vitest';
import { setThemeAndAnnounce, THEME_EVENT } from './theme-event.js';

/** Records every `cubicle:theme` detail seen on a bare EventTarget (no DOM, no Phaser). */
function listener(): { target: EventTarget; seen: unknown[] } {
  const target = new EventTarget();
  const seen: unknown[] = [];
  target.addEventListener(THEME_EVENT, (e) => seen.push((e as CustomEvent).detail));
  return { target, seen };
}

describe('setThemeAndAnnounce', () => {
  it('applies the mode and announces it', () => {
    const { target, seen } = listener();
    const asked: string[] = [];
    const applied = setThemeAndAnnounce('light', target, (m) => { asked.push(m); return 'light'; });
    expect(asked).toEqual(['light']);
    expect(applied).toBe('light');
    expect(seen).toEqual(['light']);
  });

  it('announces the resolved mode, not the word "system"', () => {
    const { target, seen } = listener();
    const applied = setThemeAndAnnounce('system', target, () => 'dark');
    expect(applied).toBe('dark');
    expect(seen).toEqual(['dark']);   // a listener never has to resolve 'system' itself
  });

  it('announces after the theme is applied, so a listener reading data-theme sees the new value', () => {
    const { target } = listener();
    const order: string[] = [];
    target.addEventListener(THEME_EVENT, () => order.push('announced'));
    setThemeAndAnnounce('dark', target, () => { order.push('applied'); return 'dark'; });
    expect(order).toEqual(['applied', 'announced']);
  });
});
