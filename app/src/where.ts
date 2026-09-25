import { useSyncExternalStore } from 'react';

// Where each browser card's page is, as its live view last heard it; '' for a blank page or one nobody has opened.
// The live view is the only part of the page that learns this, and the video card needs it to know whether a wired
// browser has anything on it to photograph.
let pages: Record<string, string> = {};
const watchers = new Set<() => void>();

export function notePage(cardId: string, url: string) {
  if ((pages[cardId] ?? '') === url) return;
  pages = { ...pages, [cardId]: url };
  for (const tell of watchers) tell();
}
const subscribe = (tell: () => void) => { watchers.add(tell); return () => { watchers.delete(tell); }; };
export const usePages = () => useSyncExternalStore(subscribe, () => pages);
