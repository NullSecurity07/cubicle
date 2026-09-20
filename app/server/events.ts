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

export function createEvents(deps: Deps) {
  const windows = new Set<(envelope: Envelope) => void>();
  // Which board cards are on the stage. The stage itself says when this changes, so nothing is re-read on a timer.
  let onStage = new Set<string>();
  let stops: (() => void)[] = [];

  // A window that went away mid-write throws on the way out. That is its own business, not the other windows'.
  const say = (hear: (envelope: Envelope) => void, envelope: Envelope) => { try { hear(envelope); } catch { /* one closed browser never silences the rest */ } };
  const tell = (channel: string, data: unknown) => { for (const one of [...windows]) say(one, { channel, data }); };
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
    async join(hear: (envelope: Envelope) => void) {
      if (!stops.length) stops = attach();
      onStage = boardsOn(await deps.stage());
      say(hear, { channel: 'attention', data: await deps.attention.list(), snapshot: true });
      say(hear, { channel: 'skills', data: { skills: await deps.skills.list() } satisfies SkillEvent, snapshot: true });
      for (const boardId of onStage) say(hear, { channel: `board:${boardId}`, data: { tasks: await deps.boards.list(boardId) } satisfies BoardEvent, snapshot: true });
      windows.add(hear);
      return () => {
        windows.delete(hear);
        if (windows.size) return;
        for (const stop of stops) stop();
        stops = [];
      };
    },
  };
}
