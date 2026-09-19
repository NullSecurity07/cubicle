import { useSyncExternalStore } from 'react';
import type { Attention } from '../../shared/model';
import { watchAttention } from '../api';

// One live copy of the founder's list for the whole window; the feed opens with the first reader.
let list: Attention[] = [];
let started = false;
const watchers = new Set<() => void>();
function subscribe(tell: () => void) {
  watchers.add(tell);
  if (!started) { started = true; watchAttention((next) => { list = next; for (const each of watchers) each(); }); }
  return () => { watchers.delete(tell); };
}
export const useAttention = () => useSyncExternalStore(subscribe, () => list);
