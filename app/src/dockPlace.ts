import { useSyncExternalStore } from 'react';

// Where the dock sits: floating along the bottom by default, on the right or left edge if the founder says so. The
// choice lives in this browser (localStorage `dock`), so it survives a reload. A narrow window has no room for a
// column beside the cards, so under 880px the dock always sits along the bottom, whatever was chosen; the choice comes
// back when the window is wide again.
export type DockPlace = 'right' | 'left' | 'bottom';
const PLACES: readonly DockPlace[] = ['right', 'left', 'bottom'];
const KEY = 'dock';
const HIDDEN = 'dock-hidden';
export const NARROW = '(max-width: 880px)';

export const isDockPlace = (value: unknown): value is DockPlace => PLACES.includes(value as DockPlace);
// The whole rule in one line, so the tests can read it without a browser.
export const placeFrom = (stored: unknown, narrow: boolean): DockPlace => (narrow ? 'bottom' : isDockPlace(stored) ? stored : 'bottom');

// Storage may be missing (tests, a locked-down browser) or throw (private windows): either way the dock is along the bottom.
function stored(): unknown {
  try { return globalThis.localStorage?.getItem(KEY); } catch { return null; }
}
function narrowQuery(): MediaQueryList | null {
  try { return globalThis.matchMedia?.(NARROW) ?? null; } catch { return null; }
}

// The rail (what comes to the founder) stands on the right edge by itself. A dock that takes the right edge, or a
// window with no room for two bars, gets the rail's buttons folded into the dock instead.
export const railFolded = (place: DockPlace, narrow: boolean) => narrow || place === 'right';

let chosen: DockPlace | null = null;
const choice = () => (chosen ??= placeFrom(stored(), false));
const narrowNow = () => !!narrowQuery()?.matches;
export const dockPlace = (): DockPlace => (narrowNow() ? 'bottom' : choice());
export const railIsFolded = () => railFolded(choice(), narrowNow());

const watchers = new Set<() => void>();
const tell = () => { for (const watcher of watchers) watcher(); };

export function setDockPlace(place: DockPlace) {
  chosen = place;
  try { globalThis.localStorage?.setItem(KEY, place); } catch { /* the choice still holds until the page reloads */ }
  // Asking for the dock somewhere is asking to see it.
  setDockHidden(false);
}

// "hide dock" puts the dock away until "show dock" or a move brings it back; the rail stays, since what waits for the
// founder must never go out of sight. Kept beside the place, and just as forgiving of storage that is not there.
let hidden: boolean | null = null;
export const dockHidden = () => (hidden ??= (() => { try { return globalThis.localStorage?.getItem(HIDDEN) === 'yes'; } catch { return false; } })());
export function setDockHidden(hide: boolean) {
  hidden = hide;
  try { if (hide) globalThis.localStorage?.setItem(HIDDEN, 'yes'); else globalThis.localStorage?.removeItem(HIDDEN); } catch { /* holds until the page reloads */ }
  tell();
}

// Another tab of the stage moving its dock moves this one too.
const onStorage = (change: StorageEvent) => { if (change.key === KEY || change.key === HIDDEN) { chosen = null; hidden = null; tell(); } };

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

export const useDockPlace = () => useSyncExternalStore(subscribe, dockPlace, (): DockPlace => 'bottom');
export const useRailFolded = () => useSyncExternalStore(subscribe, railIsFolded, () => false);
export const useDockHidden = () => useSyncExternalStore(subscribe, dockHidden, () => false);
