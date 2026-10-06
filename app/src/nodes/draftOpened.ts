import { useSyncExternalStore } from 'react';

// Which drafted emails the founder has opened in Gmail, from the chat or from Needs you. Until then a draft is only a
// filled-in compose link, so the chat must not say it is in their Gmail; once opened, it says so. Kept in this browser,
// and forgiving of storage that is not there: at worst a draft reads as not opened yet.
const KEY = 'cubicle.draftsOpened';
const MOST = 200;
let opened: string[] | undefined;
const watchers = new Set<() => void>();
const read = () => (opened ??= (() => { try { const kept = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]'); return Array.isArray(kept) ? kept.filter((one): one is string => typeof one === 'string') : []; } catch { return []; } })());

export function markDraftOpened(id: string) {
  if (read().includes(id)) return;
  opened = [...read(), id].slice(-MOST);
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(opened)); } catch { /* kept for this window only */ }
  for (const watcher of watchers) watcher();
}

const subscribe = (watcher: () => void) => { watchers.add(watcher); return () => { watchers.delete(watcher); }; };
export const useDraftOpened = (id: string) => useSyncExternalStore(subscribe, () => read().includes(id));
