import type { Attention, BoardEvent, MediaEvent, RoomEvent, Skill, SkillEvent, Stage, Task } from '../shared/model.ts';

// Everything a window listens to, on one connection. A browser allows about six connections to a site, and a live
// feed holds one for as long as the window is open: with the founder's four boards on the stage the old page held
// eight of them, and every ordinary request after that — their conversations, their missions, a picture — queued
// behind feeds that never end. So every feed says its own name and pours down the same stream.
export type Envelope = { channel: string; data: unknown; snapshot?: true };

type Deps = {
  attention: { list(): Promise<Attention[]>; watch(tell: (list: Attention[]) => void): () => void };
  skills: { list(): Promise<Skill[]>; watch(tell: (event: SkillEvent) => void): () => void };
  rooms: { watch(tell: (event: RoomEvent) => void): () => void };
  media: { watch(tell: (event: MediaEvent) => void): () => void };
  boards: { list(boardId: string): Promise<Task[]>; watchAll(tell: (boardId: string, event: BoardEvent) => void): () => void };
  stage(): Promise<Stage>;
};

const boardsOn = (stage: Stage) => new Set((stage.cards ?? []).filter((card) => card.kind === 'board').map((card) => card.id));

// A slice has no feed of its own to hand over here, and the window has only this one connection: news from an extra
// goes out through this. It is filled in by `createEvents` below, and until a window is listening it says nothing.
// The same trick the library uses to ask the frameworks whether a note is held: one small handle both sides share.
// `opening` is what an extra says to a window the moment it joins, the way a board card's tasks are: a card whose
// window opened late is whole without waiting for the next thing to happen.
type Opening = () => Promise<{ channel: string; data: unknown }[]>;
// `open` adds one and hands back the way to take it off again, so a slice's `close` is one call.
export const hub: { say: (channel: string, data: unknown) => void; opening: Opening[]; open(fn: Opening): () => void } = {
  say: () => {}, opening: [],
  open(fn) {
    hub.opening.push(fn);
    return () => { const at = hub.opening.indexOf(fn); if (at >= 0) hub.opening.splice(at, 1); };
  },
};

export function createEvents(deps: Deps) {
  const windows = new Set<(envelope: Envelope) => void>();
  // Which board cards are on the stage. The stage itself says when this changes, so nothing is re-read on a timer.
  let onStage = new Set<string>();
  let stops: (() => void)[] = [];

  // A window that went away mid-write throws on the way out. That is its own business, not the other windows'.
  const say = (hear: (envelope: Envelope) => void, envelope: Envelope) => { try { hear(envelope); } catch { /* one closed browser never silences the rest */ } };
  const tell = (channel: string, data: unknown) => { for (const one of [...windows]) say(one, { channel, data }); };
  // Whatever the extras have to say goes down the same stream as everything the app says itself.
  hub.say = tell;
  // Nothing is listened to while no window is here, and nothing is left listening once the last one leaves.
  const attach = () => [
    deps.attention.watch((list) => tell('attention', list)),
    deps.skills.watch((event) => tell('skills', event)),
    deps.rooms.watch((event) => tell('rooms', event)),
    deps.media.watch((event) => tell('media', event)),
    deps.boards.watchAll((boardId, event) => { if (onStage.has(boardId)) tell(`board:${boardId}`, event); }),
  ];

  return {
    watching: () => windows.size,
    // The stage as it has just been saved: a board card put down while the window is open starts flowing at once,
    // and one taken away goes quiet, without anybody reopening anything.
    restage(stage: Stage) { onStage = boardsOn(stage); },
    // A window joining is sent what each of the old feeds sent on opening, so it is whole the moment it arrives,
    // and then everything as it happens. What comes back stops it listening.
    // It is listening from the very start, because reading the openings takes a moment and whatever changed in that
    // moment would otherwise never reach it. What arrives meanwhile is held and sent after the openings, except what
    // a feed said before its own opening was read: that opening already has it, and sent after it, it would be older.
    async join(hear: (envelope: Envelope) => void) {
      if (!stops.length) stops = attach();
      const held: Envelope[] = [];
      let live = false;
      const window = (envelope: Envelope) => { if (live) say(hear, envelope); else held.push(envelope); };
      windows.add(window);
      const leave = () => {
        windows.delete(window);
        if (windows.size) return;
        for (const stop of stops) stop();
        stops = [];
      };
      // Where in what was held each feed's opening was read from.
      const from = new Map<string, number>();
      const opening = (channel: string, data: unknown, at: number) => { from.set(channel, at); say(hear, { channel, data, snapshot: true }); };
      try {
        onStage = boardsOn(await deps.stage());
        let at = held.length;
        opening('attention', await deps.attention.list(), at);
        at = held.length;
        opening('skills', { skills: await deps.skills.list() } satisfies SkillEvent, at);
        for (const boardId of onStage) { at = held.length; opening(`board:${boardId}`, { tasks: await deps.boards.list(boardId) } satisfies BoardEvent, at); }
        for (const open of hub.opening) { at = held.length; for (const one of await open().catch(() => [])) opening(one.channel, one.data, at); }
      } catch (error) {
        leave();
        throw error;
      }
      held.forEach((envelope, at) => { if (at >= (from.get(envelope.channel) ?? 0)) say(hear, envelope); });
      live = true;
      return leave;
    },
  };
}
