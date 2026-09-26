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

// What each kind of entry is waiting for, said after who is asking ("Maya needs your OK"). The needs panel and the
// dashboard both say it, in the same words.
export const WHAT: Record<Attention['kind'], string> = {
  approval: 'needs your OK', 'run-approval': 'needs your OK on a task', 'proposed-task': 'suggests a task', 'proposed-decision': 'asks for a decision',
  'run-failed': 'could not finish', missed: 'missed a repeat', 'review-due': 'Decision to look at again', 'proposed-source': 'suggests a website', 'page-changed': 'saw a watched page change',
  'metric-alert': 'A number to look at', 'proposed-target': 'suggests a target',
  'runway-low': 'Runway is short', 'proposed-runway': 'suggests a change to the runway',
  'lead-stale': 'A lead to follow up',
  'key-rejected': 'A model key was refused',
};
export const ago = (at: number, now = Date.now()) => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1 ? 'now' : minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
};
// How long ago, said in a sentence the way the clock beside it says it.
export const since = (at: number) => (ago(at) === 'now' ? 'just now' : `${ago(at)} ago`);
