import { useSyncExternalStore } from 'react';

// Where the dock sits: on the right edge by default, the left edge or along the bottom if the founder says so. The
// choice lives in this browser (localStorage `dock`), so it survives a reload. A narrow window has no room for a
// column beside the cards, so under 880px the dock always sits along the bottom, whatever was chosen; the choice comes
// back when the window is wide again.
export type DockPlace = 'right' | 'left' | 'bottom';
const PLACES: readonly DockPlace[] = ['right', 'left', 'bottom'];
const KEY = 'dock';
export const NARROW = '(max-width: 880px)';

export const isDockPlace = (value: unknown): value is DockPlace => PLACES.includes(value as DockPlace);
// The whole rule in one line, so the tests can read it without a browser.
export const placeFrom = (stored: unknown, narrow: boolean): DockPlace => (narrow ? 'bottom' : isDockPlace(stored) ? stored : 'right');

// Storage may be missing (tests, a locked-down browser) or throw (private windows): either way the dock is on the right.
function stored(): unknown {
  try { return globalThis.localStorage?.getItem(KEY); } catch { return null; }
}
function narrowQuery(): MediaQueryList | null {
  try { return globalThis.matchMedia?.(NARROW) ?? null; } catch { return null; }
}

let chosen: DockPlace | null = null;
const choice = () => (chosen ??= placeFrom(stored(), false));
export const dockPlace = (): DockPlace => (narrowQuery()?.matches ? 'bottom' : choice());

const watchers = new Set<() => void>();
const tell = () => { for (const watcher of watchers) watcher(); };

export function setDockPlace(place: DockPlace) {
  chosen = place;
  try { globalThis.localStorage?.setItem(KEY, place); } catch { /* the choice still holds until the page reloads */ }
  tell();
}

// Another tab of the stage moving its dock moves this one too.
const onStorage = (change: StorageEvent) => { if (change.key === KEY) { chosen = null; tell(); } };

function subscribe(watcher: () => void) {
  watchers.add(watcher);
  const query = narrowQuery();
  query?.addEventListener?.('change', watcher);
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    watchers.delete(watcher);
    query?.removeEventListener?.('change', watcher);
    if (!watchers.size) globalThis.removeEventListener?.('storage', onStorage);
  };
}

export const useDockPlace = () => useSyncExternalStore(subscribe, dockPlace, (): DockPlace => 'right');
