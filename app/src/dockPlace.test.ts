import { afterEach, describe, expect, it, vi } from 'vitest';

// A stand-in for the browser: a storage that may throw, and a window that may be narrow.
function browser({ saved, narrow = false, broken = false }: { saved?: string; narrow?: boolean; broken?: boolean } = {}) {
  const items = new Map<string, string>(saved === undefined ? [] : [['dock', saved]]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => { if (broken) throw new Error('denied'); return items.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (broken) throw new Error('denied'); items.set(key, value); },
  });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: narrow && query.includes('880px'), addEventListener() {}, removeEventListener() {} }));
  return items;
}
const fresh = async () => { vi.resetModules(); return import('./dockPlace'); };

describe('dock place', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('floats along the bottom when nothing was chosen, and when there is no storage at all', async () => {
    browser();
    expect((await fresh()).dockPlace()).toBe('bottom');
    vi.unstubAllGlobals();
    expect((await fresh()).dockPlace()).toBe('bottom');
  });

  it('keeps the founder\'s choice in storage, so a reload finds it', async () => {
    const items = browser();
    const first = await fresh();
    first.setDockPlace('left');
    expect(first.dockPlace()).toBe('left');
    expect(items.get('dock')).toBe('left');
    expect((await fresh()).dockPlace()).toBe('left');
  });

  it('falls back to the bottom on a stored value it does not know, or storage that throws', async () => {
    browser({ saved: 'top' });
    expect((await fresh()).dockPlace()).toBe('bottom');
    browser({ saved: 'left', broken: true });
    const place = await fresh();
    expect(place.dockPlace()).toBe('bottom');
    expect(() => place.setDockPlace('left')).not.toThrow();
    expect(place.dockPlace()).toBe('left');
  });

  it('sits along the bottom of a narrow window whatever was chosen', async () => {
    browser({ saved: 'left', narrow: true });
    const { dockPlace, placeFrom } = await fresh();
    expect(dockPlace()).toBe('bottom');
    expect(placeFrom('left', true)).toBe('bottom');
    expect(placeFrom('left', false)).toBe('left');
    expect(placeFrom(null, false)).toBe('bottom');
    expect(placeFrom('right', false)).toBe('right');
  });
});
