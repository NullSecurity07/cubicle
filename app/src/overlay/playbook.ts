import { useSyncExternalStore } from 'react';
import type { Skill } from '../../shared/model';
import { watchSkills } from '../api';

// One live copy of the playbook for the whole window, and the quiet lines a birth or an improvement leaves behind in
// the room it happened in. The feed opens with the first reader, the way the founder's list does; every open
// conversation is a reader, so a line reaches a room whether or not the panel is open.
export type Learned = { id: string; roomId: string; name: string; action: 'create' | 'patch' };

const NONE: Learned[] = [];
let book: { skills: Skill[]; ready: boolean } = { skills: [], ready: false };
let lines: Record<string, Learned[]> = {};
let started = false;
const watchers = new Set<() => void>();

function subscribe(tell: () => void) {
  watchers.add(tell);
  if (!started) {
    started = true;
    watchSkills((event) => {
      if ('skills' in event) book = { skills: event.skills, ready: true };
      else {
        const { roomId } = event.learned;
        lines = { ...lines, [roomId]: [...(lines[roomId] ?? []), { id: `${roomId}-${lines[roomId]?.length ?? 0}`, ...event.learned }] };
      }
      for (const each of watchers) each();
    });
  }
  return () => { watchers.delete(tell); };
}

export const usePlaybook = () => useSyncExternalStore(subscribe, () => book);
export const useLearnedIn = (roomId: string) => useSyncExternalStore(subscribe, () => lines[roomId] ?? NONE);
