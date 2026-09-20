import type { RoomEvent } from '../shared/model.ts';

export type RoomFeed = ReturnType<typeof createRoomFeed>;

// One live feed of everything happening in the rooms, for the windows that did not start it. The founder writes to
// a person from their phone, a colleague hands them a piece of work, a second window asks a question: without this,
// all of it lands on disk and the open canvas shows nothing until somebody reloads. Every writer reaches it through
// the store, and a turn pours its words and its tool chips through it while it runs, so a card that is only
// watching draws the same reply, at the same moment, as the card that asked for it.
export function createRoomFeed() {
  const watchers = new Set<(event: RoomEvent) => void>();
  return {
    watch(tell: (event: RoomEvent) => void) {
      watchers.add(tell);
      return () => { watchers.delete(tell); };
    },
    // A window that went away mid-write throws on the way out. That is its own business, not the other windows'.
    tell(event: RoomEvent) {
      for (const one of [...watchers]) { try { one(event); } catch { /* one closed browser never silences the rest */ } }
    },
    watching: () => watchers.size,
  };
}
