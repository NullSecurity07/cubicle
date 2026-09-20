import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Attention, BoardEvent, MediaEvent, RoomEvent, Skill, SkillEvent, Stage, Task } from '../shared/model.ts';
import { createAttention } from './attention.ts';
import { createEvents, type Envelope } from './events.ts';
import { tidyLapsed } from './lapsed.ts';

// One of the things a window used to open a connection of its own for, driven by hand.
function feedOf<T>() {
  const watchers = new Set<(event: T) => void>();
  return {
    watch(tell: (event: T) => void) { watchers.add(tell); return () => { watchers.delete(tell); }; },
    tell(event: T) { for (const one of watchers) one(event); },
    watching: () => watchers.size,
  };
}
const boardCard = (id: string) => ({ kind: 'board' as const, id, x: 0, y: 0, w: 900, h: 420 });
const stageOf = (...boardIds: string[]): Stage => ({ rooms: [], docs: [], wires: [], cards: boardIds.map(boardCard) });
const task = (title: string) => ({ id: title, title, detail: '', column: 'todo', createdAt: 0 }) as Task;

function hub(stage: Stage, tasks: Record<string, Task[]> = {}, waiting: Attention[] = [], book: Skill[] = []) {
  const attention = feedOf<Attention[]>();
  const skills = feedOf<SkillEvent>();
  const rooms = feedOf<RoomEvent>();
  const media = feedOf<MediaEvent>();
  const all = new Set<(boardId: string, event: BoardEvent) => void>();
  const boards = {
    list: async (boardId: string) => tasks[boardId] ?? [],
    watchAll(tell: (boardId: string, event: BoardEvent) => void) { all.add(tell); return () => { all.delete(tell); }; },
    tell(boardId: string, event: BoardEvent) { for (const one of all) one(boardId, event); },
    watching: () => all.size,
  };
  const events = createEvents({
    attention: { list: async () => waiting, watch: attention.watch },
    skills: { list: async () => book, watch: skills.watch },
    rooms, media, boards, stage: async () => stage,
  });
  return { events, attention, skills, rooms, media, boards };
}
// A window: everything it has been told, and how to stop listening.
async function join(events: ReturnType<typeof hub>['events']) {
  const heard: Envelope[] = [];
  const stop = await events.join((envelope) => heard.push(envelope));
  return { heard, stop, since: () => heard.splice(0) };
}

describe('one live connection carrying every feed', () => {
  it('sends a window what each old feed sent on opening, so it is whole the moment it arrives', async () => {
    const waiting: Attention[] = [{ id: 'a1', kind: 'proposed-task', title: 'A task to accept', at: 1 }];
    const book = [{ id: 's1', name: 'Ship on Fridays' }] as unknown as Skill[];
    const { events } = hub(stageOf('one', 'two'), { one: [task('Book the venue')], two: [] }, waiting, book);
    const { heard } = await join(events);
    expect(heard).toEqual([
      { channel: 'attention', data: waiting, snapshot: true },
      { channel: 'skills', data: { skills: book }, snapshot: true },
      { channel: 'board:one', data: { tasks: [task('Book the venue')] }, snapshot: true },
      { channel: 'board:two', data: { tasks: [] }, snapshot: true },
    ]);
  });

  it('puts everything that happens afterwards in an envelope that says which feed it came from', async () => {
    const { events, attention, skills, rooms, media, boards } = hub(stageOf('one'));
    const window = await join(events);
    window.since();
    attention.tell([]);
    skills.tell({ learned: { roomId: 'marketing', name: 'Ship on Fridays', action: 'create' } });
    rooms.tell({ roomId: 'marketing', chat: 'changed' });
    media.tell({ id: 'feed-image', line: 'drawing' });
    boards.tell('one', { tasks: [task('Book the venue')] });
    expect(window.since()).toEqual([
      { channel: 'attention', data: [] },
      { channel: 'skills', data: { learned: { roomId: 'marketing', name: 'Ship on Fridays', action: 'create' } } },
      { channel: 'rooms', data: { roomId: 'marketing', chat: 'changed' } },
      { channel: 'media', data: { id: 'feed-image', line: 'drawing' } },
      { channel: 'board:one', data: { tasks: [task('Book the venue')] } },
    ]);
  });

  it('follows the stage: a board card put down while the window is open flows, one taken away goes quiet', async () => {
    const { events, boards } = hub(stageOf('one'));
    const window = await join(events);
    window.since();
    events.restage(stageOf('one', 'later'));
    boards.tell('later', { tasks: [task('Ring the printer')] });
    expect(window.since()).toEqual([{ channel: 'board:later', data: { tasks: [task('Ring the printer')] } }]);
    events.restage(stageOf('later'));
    boards.tell('one', { tasks: [] });
    expect(window.since()).toEqual([]);
  });

  it('a window that went away mid-write never silences the ones that are still here', async () => {
    const { events, rooms } = hub(stageOf());
    const gone = await events.join(() => { throw new Error('this window closed'); });
    const window = await join(events);
    window.since();
    rooms.tell({ roomId: 'marketing', chat: 'changed' });
    expect(window.since()).toEqual([{ channel: 'rooms', data: { roomId: 'marketing', chat: 'changed' } }]);
    gone();
  });

  // The bell on the dock counts this one list, so anything that leaves it has to leave down here too, at once.
  it('carries an approval away the moment a turn tidies it up, so the bell stops without a reload', async () => {
    const NOON = new Date(2026, 8, 20, 12).getTime();
    const dir = await mkdtemp(joinPath(tmpdir(), 'events-'));
    const closed = createAttention(dir, () => NOON);
    await closed.raise({ id: 'approval:c1', kind: 'approval', title: 'Send this email?', at: NOON - 600_000, roomId: 'marketing', who: 'Maya', event: { id: 'c1', name: 'send_email', args: { to: 'alex@example.com' }, waiting: true } });
    await closed.settled();

    const attention = createAttention(dir, () => NOON);
    const events = createEvents({
      attention, skills: { list: async () => [], watch: () => () => {} }, rooms: feedOf<RoomEvent>(), media: feedOf<MediaEvent>(),
      boards: { list: async () => [], watchAll: () => () => {} }, stage: async () => stageOf(),
    });
    const window = await join(events);
    expect((window.since()[0].data as Attention[])[0]).toMatchObject({ id: 'approval:c1', lapsed: true });
    await tidyLapsed(attention)({ roomId: 'marketing', source: 'chat', query: 'hello again', reply: { text: 'hi', tools: [], provider: 'fake', model: 'fake', usage: { input: 1, output: 1 }, stopped: false } }, async (given) => given);
    expect(window.since()).toEqual([{ channel: 'attention', data: [] }]);
    window.stop();
  });

  it('leaves nothing listening once the last window has gone, and listens again for the next one', async () => {
    const { events, attention, rooms, boards } = hub(stageOf('one'));
    const first = await join(events);
    const second = await join(events);
    expect([attention.watching(), rooms.watching(), boards.watching()]).toEqual([1, 1, 1]);
    first.stop();
    expect(events.watching()).toBe(1);
    second.stop();
    expect([attention.watching(), rooms.watching(), boards.watching()]).toEqual([0, 0, 0]);
    // Nothing reaches a window that has gone, and nothing throws for the want of one.
    rooms.tell({ roomId: 'marketing', chat: 'changed' });
    expect(first.heard.filter((envelope) => envelope.channel === 'rooms')).toEqual([]);
    const third = await join(events);
    expect(rooms.watching()).toBe(1);
    third.stop();
  });
});
