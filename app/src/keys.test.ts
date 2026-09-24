import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capsOf, checkOverrides, flowKeys, keysOf, matches, parseChord, pressed, setOverrides, SHORTCUTS } from './keys';

const press = (key: string, held: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...held });

afterEach(() => setOverrides({}));

describe('chords', () => {
  it('reads a modifier or several, then one key, in any spelling', () => {
    expect(parseChord('Mod+K')).toEqual({ mods: ['Mod'], key: 'K' });
    expect(parseChord(' ctrl + shift + k ')).toEqual({ mods: ['Ctrl', 'Shift'], key: 'K' });
    expect(parseChord('Cmd+/')).toEqual({ mods: ['Mod'], key: '/' });
    expect(parseChord('esc')).toEqual({ mods: [], key: 'Escape' });
    expect(parseChord('?')).toEqual({ mods: [], key: '?' });
    expect(parseChord('Mod++')).toEqual({ mods: ['Mod'], key: '+' });
    expect(parseChord('Alt+F4')).toEqual({ mods: ['Alt'], key: 'F4' });
    expect(parseChord('Shift')).toEqual({ mods: ['Shift'], key: null });
  });

  it('refuses what is not one chord', () => {
    for (const bad of ['', 'K+Mod', 'Mod+K+J', 'Hyper+K', 'Mod+Mod+K', 'Mod+Shift', 'Mod+Enterr', 'Ctrl+', '+K']) expect(parseChord(bad), bad).toBeNull();
  });

  it('matches Mod to ⌘ on a Mac and to Ctrl elsewhere, and nothing else', () => {
    expect(matches('Mod+K', press('k', { ctrlKey: true }), false)).toBe(true);
    expect(matches('Mod+K', press('k', { metaKey: true }), false)).toBe(false);
    expect(matches('Mod+K', press('k', { metaKey: true }), true)).toBe(true);
    expect(matches('Mod+K', press('k', { ctrlKey: true }), true)).toBe(false);
    expect(matches('Ctrl+K', press('k', { ctrlKey: true }), true)).toBe(true);
    expect(matches('N', press('n', { altKey: true }), false)).toBe(false);
  });

  it('holds Shift exactly for named keys and lets a typed symbol carry its own', () => {
    expect(matches('Enter', press('Enter'), false)).toBe(true);
    expect(matches('Enter', press('Enter', { shiftKey: true }), false)).toBe(false);
    expect(matches('Shift+Tab', press('Tab', { shiftKey: true }), false)).toBe(true);
    expect(matches('?', press('?', { shiftKey: true }), false)).toBe(true);
    expect(matches('N', press('N', { shiftKey: true }), false)).toBe(true);
    expect(matches('Shift+N', press('n'), false)).toBe(false);
    expect(matches('Space', press(' '), false)).toBe(true);
  });

  it('shows ⌘ on a Mac and Ctrl everywhere else', () => {
    expect(capsOf('Mod+K', true)).toEqual(['⌘', 'K']);
    expect(capsOf('Mod+K', false)).toEqual(['Ctrl', 'K']);
    expect(capsOf('Escape', false)).toEqual(['Esc']);
    expect(capsOf('Shift+Tab', true)).toEqual(['⇧', 'Tab']);
  });
});

describe('the founder’s own keys', () => {
  it('takes a good change, tidied', () => {
    expect(checkOverrides({ 'command-bar': ['mod+p'], needs: 'Alt+N' })).toEqual({ keys: { 'command-bar': ['Mod+P'], needs: ['Alt+N'] }, problems: [] });
  });

  it('keeps the default and says why for anything wrong', () => {
    const checked = checkOverrides({ nope: ['K'], needs: ['Mod+Hyper'], messages: [], 'select-area': ['Mod+S'], send: ['Shift'] });
    expect(checked.keys).toEqual({});
    expect(checked.problems).toHaveLength(5);
    expect(checked.problems[0]).toContain('"nope"');
    expect(checked.problems[1]).toContain('it keeps N');
    expect(checked.problems[3]).toContain('one key to hold');
  });

  it('refuses a key another shortcut already has, and keeps the first', () => {
    const checked = checkOverrides({ needs: ['M'] });
    expect(checked.keys).toEqual({});
    expect(checked.problems[0]).toMatch(/^M is already .*\(messages\), so "needs" keeps N\.$/);
    // Mod+K is everywhere, so nothing in a card may take it either.
    expect(checkOverrides({ send: ['Mod+K'] }).problems[0]).toContain('(command-bar)');
    // Moved away first, the key is free for someone else.
    expect(checkOverrides({ messages: ['Alt+M'], needs: ['M'] }).keys).toEqual({ messages: ['Alt+M'], needs: ['M'] });
  });

  it('lets rows keep sharing what they already shared', () => {
    expect(checkOverrides({ back: ['Escape', 'Mod+W'] }).problems).toEqual([]);
  });

  it('says so when the file is not an object at all', () => {
    expect(checkOverrides([1, 2]).problems).toHaveLength(1);
    expect(checkOverrides(undefined).problems).toEqual([]);
  });

  it('reaches every handler and the canvas once applied', () => {
    expect(pressed(press('k', { ctrlKey: true }), 'command-bar')).toBe(true);
    setOverrides(checkOverrides({ 'command-bar': ['Mod+P'], 'delete-cards': ['Delete', 'Backspace'] }).keys);
    expect(keysOf('command-bar')).toEqual(['Mod+P']);
    expect(pressed(press('k', { ctrlKey: true }), 'command-bar')).toBe(false);
    expect(flowKeys('delete-cards')).toEqual(['Delete', 'Backspace']);
  });

  it('gives the canvas the keys React Flow has by default', () => {
    expect(flowKeys('delete-cards')).toEqual(['Backspace']);
    expect(flowKeys('pick-several', false)).toEqual(['Control']);
    expect(flowKeys('pick-several', true)).toEqual(['Meta']);
    expect(flowKeys('select-area')).toEqual(['Shift']);
  });
});

// The sheet can never drift: every row is asked for by a handler, every handler asks for a row, and no key is read
// anywhere except through the table.
describe('the table and the handlers', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
  const here = import.meta.dirname;
  const sources = files(here).map((path) => ({ path: relative(here, path), text: readFileSync(path, 'utf8') }));
  // keys.ts itself only explains how to ask, in a comment.
  const asked = new Set(sources.filter(({ path }) => path !== 'keys.ts').flatMap(({ text }) => [...text.matchAll(/\b(?:pressed\(\s*\w+,\s*|flowKeys\()'([\w-]+)'/g)].map((found) => found[1])));

  it('has one sound row for each id', () => {
    expect(new Set(SHORTCUTS.map((row) => row.id)).size).toBe(SHORTCUTS.length);
    for (const row of SHORTCUTS) {
      expect(row.does.length, row.id).toBeGreaterThan(8);
      for (const key of row.keys) expect(parseChord(key)?.key === null, `${row.id} ${key}`).toBe(!!row.with);
    }
    // The defaults pass the founder's own check, so nobody can write a table the server would refuse.
    expect(checkOverrides(Object.fromEntries(SHORTCUTS.map((row) => [row.id, row.keys]))).problems).toEqual([]);
  });

  it('has a handler for every row', () => {
    expect(SHORTCUTS.map((row) => row.id).filter((id) => !asked.has(id))).toEqual([]);
  });

  it('has a row for every handler', () => {
    const ids = new Set(SHORTCUTS.map((row) => row.id));
    expect([...asked].filter((id) => !ids.has(id))).toEqual([]);
  });

  it('reads no key except through the table', () => {
    // live.ts passes every key on to a live web page as it is; that is forwarding, not a shortcut.
    const raw = sources.filter(({ path, text }) => path !== 'keys.ts' && path !== join('nodes', 'live.ts') && /\bevent\.key\b|\.(ctrl|meta)Key\s*(&&|\|\||\))/.test(text));
    expect(raw.map(({ path }) => path)).toEqual([]);
  });
});
