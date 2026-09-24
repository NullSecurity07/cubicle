import { useSyncExternalStore } from 'react';
import type { ModelInfo } from '../shared/model';
import { getModels } from './api';
import { listen } from './bus';

// The window's one copy of which models are set up and how much of today each has left. It is read when the first
// view asks and again whenever a turn has used some; null until the first answer, and kept as it was if one fails.
let held: ModelInfo[] | null = null;
let started = false;
const watchers = new Set<() => void>();

function refresh() {
  getModels().then((next) => { held = next; for (const tell of watchers) tell(); }).catch(() => {});
}
function subscribe(tell: () => void) {
  watchers.add(tell);
  if (!started) { started = true; refresh(); listen('usage', refresh); }
  return () => { watchers.delete(tell); };
}
export const useModels = () => useSyncExternalStore(subscribe, () => held);
