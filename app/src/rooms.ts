import type { RoomEvent } from '../shared/model';
import { watchRooms } from './api';

// One feed of room activity for the whole window, however many conversations are open on the canvas, the way the
// playbook and the founder's list each keep one. It opens with the first card and stays open; a card hears only
// what happened in its own room.
// `reopened` is the feed coming back after a gap, which means nobody was listening for a while: whoever hears it
// reads their conversation again rather than guess at what was said meanwhile.
export type Heard = RoomEvent | { reopened: true };

const rooms = new Map<string, Set<(event: Heard) => void>>();
let started = false;

export function watchRoom(roomId: string, hear: (event: Heard) => void) {
  const here = rooms.get(roomId) ?? new Set<(event: Heard) => void>();
  rooms.set(roomId, here);
  here.add(hear);
  if (!started) {
    started = true;
    watchRooms(
      (event) => { for (const one of [...(rooms.get(event.roomId) ?? [])]) one(event); },
      (again) => { if (again) for (const room of [...rooms.values()]) for (const one of [...room]) one({ reopened: true }); },
    );
  }
  return () => { here.delete(hear); if (!here.size) rooms.delete(roomId); };
}
