// Every key the app answers to, in one table. The handlers ask this file whether a key was theirs (`pressed`), the
// canvas takes its keys from it (`flowKeys`), and the cheatsheet is drawn from it, so the sheet can never say one thing
// while a key does another. The founder may change any of them in `<workspace>/keys.json`; the server reads and checks
// that file (server/slices/keys.ts) and the page applies what it accepted (`setOverrides`).
//
// This file imports nothing, on purpose: the server reads the same table to check the founder's file against it.
//
// A chord is written `Mod+K`: any of Mod, Ctrl, Alt and Shift, then one key. `Mod` is ⌘ on a Mac and Ctrl
// everywhere else. A row with `with` is a key held while clicking or dragging, and its chord is one held key alone.
//
// To add a shortcut: add one row below with an id nobody else uses, then have its handler ask `pressed(event, 'id')`
// (or `flowKeys('id')` for a key the canvas itself listens for). The test in keys.test.ts fails until both exist.

export type When = 'anywhere' | 'stage' | 'room' | 'overlay';
export type Shortcut = { id: string; keys: string[]; when: When; does: string; with?: 'click' | 'drag' };

export const SHORTCUTS: Shortcut[] = [
  { id: 'command-bar', keys: ['Mod+K'], when: 'anywhere', does: 'Open the command bar, even while you type' },
  { id: 'cancel', keys: ['Escape'], when: 'anywhere', does: 'Put back what you are in the middle of: an edit, a name, an open menu' },
  { id: 'dashboard', keys: ['Mod+D'], when: 'anywhere', does: 'Open the dashboard: your day, your tokens, your teams, what was made; again closes it' },

  { id: 'command-bar-slash', keys: ['/'], when: 'stage', does: 'Open the command bar' },
  { id: 'cheatsheet', keys: ['?', 'Mod+/'], when: 'stage', does: 'Show this sheet' },
  { id: 'needs', keys: ['N'], when: 'stage', does: 'Open Needs you: what waits for you' },
  { id: 'messages', keys: ['M'], when: 'stage', does: 'Open Messages: every conversation' },
  { id: 'decisions', keys: ['D'], when: 'stage', does: 'Open Decisions: what you decided, and why' },
  { id: 'focus-card', keys: ['F'], when: 'stage', does: 'Focus the selected card, so it fills the window' },
  { id: 'delete-cards', keys: ['Backspace'], when: 'stage', does: 'Remove the selected wires; a card is removed with its own Remove button' },
  { id: 'pick-several', keys: ['Mod'], with: 'click', when: 'stage', does: 'Pick several cards; two or more can be saved as a framework' },
  { id: 'select-area', keys: ['Shift'], with: 'drag', when: 'stage', does: 'Pick every card inside the area you drag across' },

  { id: 'send', keys: ['Enter'], when: 'room', does: 'Send what you wrote; Shift and Enter starts a new line' },
  { id: 'leave-page', keys: ['Escape'], when: 'room', does: 'Stop typing into a live web page and give the keys back to the stage' },

  { id: 'back', keys: ['Escape'], when: 'overlay', does: 'Close the top view, one at a time' },
  { id: 'next-stop', keys: ['Tab', 'Shift+Tab'], when: 'overlay', does: 'Move between the buttons of the open view without leaving it' },
  { id: 'command-down', keys: ['ArrowDown'], when: 'overlay', does: 'Move down the command bar’s suggestions' },
  { id: 'command-up', keys: ['ArrowUp'], when: 'overlay', does: 'Move up the command bar’s suggestions' },
  { id: 'command-run', keys: ['Enter'], when: 'overlay', does: 'Do the chosen suggestion' },
];

export const WHEN_TITLE: Record<When, string> = { anywhere: 'Anywhere', stage: 'On the stage', room: 'In a card', overlay: 'In an open view' };

const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;
type Modifier = (typeof MODIFIERS)[number];
// The named keys a chord may end in, as the browser names them. `Esc` and `Space` are the spellings people write.
const NAMED = ['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space',
  ...Array.from({ length: 12 }, (_, at) => `F${at + 1}`)];
const ALIAS: Record<string, string> = { esc: 'Escape', return: 'Enter', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', spacebar: 'Space', cmd: 'Mod', command: 'Mod', control: 'Ctrl', option: 'Alt' };

export type Chord = { mods: Modifier[]; key: string | null };

// `Mod+Shift+K` → { mods: ['Mod', 'Shift'], key: 'K' }. A held key alone (`Shift`) has no key. Anything else is null.
export function parseChord(text: string): Chord | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 40) return null;
  // `Mod++` is Mod and the plus key; `+` alone is the plus key.
  const parts = trimmed === '+' ? ['+'] : trimmed.endsWith('++') ? [...trimmed.slice(0, -2).split('+'), '+'] : trimmed.split('+');
  const mods: Modifier[] = [];
  let key: string | null = null;
  for (const [at, raw] of parts.entries()) {
    const part = raw.trim();
    if (!part) return null;
    const named = ALIAS[part.toLowerCase()] ?? part;
    const mod = MODIFIERS.find((one) => one.toLowerCase() === named.toLowerCase());
    if (mod) {
      if (mods.includes(mod) || key) return null;
      mods.push(mod);
      continue;
    }
    if (at !== parts.length - 1) return null;
    const known = NAMED.find((one) => one.toLowerCase() === named.toLowerCase());
    if (known) key = known;
    else if ([...named].length === 1) key = named.toUpperCase();
    else return null;
  }
  if (!key && mods.length !== 1) return null;
  return { mods, key };
}

// One spelling for each chord, so `ctrl+k`, `Ctrl + K` and `CTRL+k` are the same chord everywhere.
export const chordText = (chord: Chord) => [...MODIFIERS.filter((mod) => chord.mods.includes(mod)), ...(chord.key ? [chord.key] : [])].join('+');
const tidy = (text: string) => { const chord = parseChord(text); return chord ? chordText(chord) : null; };

// ---- The founder's own keys ----

export type Overrides = Record<string, string[]>;
export type Checked = { keys: Overrides; problems: string[] };

// What the founder wrote in keys.json, checked against the table. A row that is changed well takes its new keys; a row
// that is changed badly keeps its default and says why in one sentence. Nothing here throws.
export function checkOverrides(raw: unknown, table: Shortcut[] = SHORTCUTS): Checked {
  const problems: string[] = [];
  const keys: Overrides = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { keys, problems: raw === undefined ? [] : ['keys.json should hold one object, like { "command-bar": ["Mod+K"] }; every key keeps its default.'] };
  }
  const current = new Map(table.map((row) => [row.id, row.keys.map((one) => tidy(one) ?? one)]));
  const defaults = new Map(current);
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const row = table.find((one) => one.id === id);
    if (!row) { problems.push(`keys.json names "${id}", which is not a shortcut; it was left out.`); continue; }
    const list = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(list) || !list.length) { problems.push(`"${id}" in keys.json should be a list of keys, like ["Mod+K"]; it keeps ${row.keys.join(', ')}.`); continue; }
    const chords: string[] = [];
    let wrong = '';
    for (const one of list) {
      const chord = typeof one === 'string' ? parseChord(one) : null;
      if (!chord) { wrong = `"${String(one)}" for "${id}" is not a key: write Mod, Ctrl, Alt or Shift, then one key, like "Mod+K"`; break; }
      if (row.with ? chord.key !== null : chord.key === null) {
        wrong = row.with ? `"${one}" for "${id}" should be one key to hold, like "Shift"` : `"${one}" for "${id}" holds a key but presses none`;
        break;
      }
      const text = chordText(chord);
      if (!chords.includes(text)) chords.push(text);
    }
    if (wrong) { problems.push(`${wrong}; it keeps ${row.keys.join(', ')}.`); continue; }
    // Two rows may share a key only where they already did (Escape closes a view and also puts an edit back).
    const shared = (other: Shortcut, key: string) => defaults.get(id)!.includes(key) && defaults.get(other.id)!.includes(key);
    let clash: { other: Shortcut; key: string } | undefined;
    for (const other of table) {
      if (clash || other.id === id || !(other.when === row.when || other.when === 'anywhere' || row.when === 'anywhere')) continue;
      const key = (current.get(other.id) ?? []).find((one) => chords.includes(one) && !shared(other, one));
      if (key) clash = { other, key };
    }
    if (clash) { problems.push(`${clash.key} is already "${clash.other.does}" (${clash.other.id}), so "${id}" keeps ${row.keys.join(', ')}.`); continue; }
    current.set(id, chords);
    keys[id] = chords;
  }
  return { keys, problems };
}

// ---- In the page ----

let overrides: Overrides = {};
const watchers = new Set<() => void>();
let version = 0;
export function setOverrides(next: Overrides) { overrides = next; version += 1; for (const tell of watchers) tell(); }
export const onOverrides = (tell: () => void) => { watchers.add(tell); return () => { watchers.delete(tell); }; };
export const overridesVersion = () => version;

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

// The keys a row answers to right now: the founder's own when they set some, the table's otherwise.
export function keysOf(id: string): string[] {
  const row = SHORTCUTS.find((one) => one.id === id);
  if (!row) throw new Error(`no shortcut called ${id}`);
  return overrides[id] ?? row.keys;
}

type Pressed = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };
const eventKey = (key: string) => (key === ' ' ? 'Space' : key === 'Esc' ? 'Escape' : key);

// Whether this key press is chord `text`. Ctrl, ⌘ and Alt must be exactly as written. Shift is exact for a named key
// (Shift and Enter is not Enter) and for a letter the chord names Shift with; a symbol like "?" already carries the
// Shift it took to type it, and a lone letter answers with or without Shift, as it always has.
export function matches(text: string, event: Pressed, mac = isMac()): boolean {
  const chord = parseChord(text);
  if (!chord || !chord.key) return false;
  const want = (mod: Modifier) => chord.mods.includes(mod);
  const ctrl = want('Ctrl') || (!mac && want('Mod'));
  const meta = mac && want('Mod');
  if (event.ctrlKey !== ctrl || event.metaKey !== meta || event.altKey !== want('Alt')) return false;
  const key = eventKey(event.key);
  const named = NAMED.includes(chord.key);
  if (named) return key === chord.key && event.shiftKey === want('Shift');
  if (want('Shift') && !event.shiftKey) return false;
  return key.toUpperCase() === chord.key;
}

// A key pressed with ⌘, Ctrl or Alt held is a command, never typing, so it may work from inside a field.
export const held = (event: Pressed) => event.ctrlKey || event.metaKey || event.altKey;

// The one question every handler asks.
export const pressed = (event: Pressed, id: string) => keysOf(id).some((one) => matches(one, event));

// The same keys in the words the canvas (React Flow) listens for: `Meta`/`Control` for Mod, and `+` between.
export function flowKeys(id: string, mac = isMac()): string[] {
  return keysOf(id).flatMap((text) => {
    const chord = parseChord(text);
    if (!chord) return [];
    const mods = chord.mods.map((mod) => (mod === 'Mod' ? (mac ? 'Meta' : 'Control') : mod === 'Ctrl' ? 'Control' : mod));
    const key = chord.key === 'Space' ? ' ' : chord.key && chord.key.length === 1 ? chord.key.toLowerCase() : chord.key;
    return [[...mods, ...(key ? [key] : [])].join('+')];
  });
}

// How a chord is shown: ⌘ ⇧ ⌥ ⌃ on a Mac, the words everywhere else. One entry per key cap.
const MAC_CAP: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Backspace: '⌫', Enter: '↩' };
const CAP: Record<string, string> = { Mod: 'Ctrl', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
export function capsOf(text: string, mac = isMac()): string[] {
  const chord = parseChord(text);
  if (!chord) return [text];
  return [...chord.mods, ...(chord.key ? [chord.key] : [])].map((part) => (mac ? MAC_CAP[part] : undefined) ?? CAP[part] ?? part);
}

// A row's first key as a short hint beside a button, "Ctrl K" or "⌘ K": read from the table, so a key the founder moved
// in keys.json is the key the hint names.
export const keyHint = (id: string) => capsOf(keysOf(id)[0] ?? '').join(' ');
