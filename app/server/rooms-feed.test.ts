import { describe, expect, it } from 'vitest';
import type { RoomEvent } from '../shared/model.ts';
import { createRoomFeed } from './rooms-feed.ts';

const heard = (feed: ReturnType<typeof createRoomFeed>) => {
  const seen: RoomEvent[] = [];
  const stop = feed.watch((event) => seen.push(event));
  return { seen, stop };
};

describe('the rooms feed', () => {
  it('gives every window the same events, in the order they happened', () => {
    const feed = createRoomFeed();
    const [one, two] = [heard(feed), heard(feed)];
    feed.tell({ roomId: 'marketing', chat: 'changed' });
    feed.tell({ roomId: 'marketing', turn: 't1', started: { via: 'phone' } });
    feed.tell({ roomId: 'marketing', turn: 't1', token: 'Hel' });
    feed.tell({ roomId: 'marketing', turn: 't1', token: 'lo' });
    feed.tell({ roomId: 'marketing', turn: 't1', ended: true });
    expect(one.seen).toEqual(two.seen);
    const what = (event: RoomEvent) => ('token' in event ? event.token : 'chat' in event ? 'chat' : 'started' in event ? 'started' : 'ended');
    expect(one.seen.map(what)).toEqual(['chat', 'started', 'Hel', 'lo', 'ended']);
  });

  it('carries on past a window that throws on its way out', () => {
    const feed = createRoomFeed();
    feed.watch(() => { throw new Error('this browser is gone'); });
    const after = heard(feed);
    expect(() => feed.tell({ roomId: 'build', chat: 'changed' })).not.toThrow();
    expect(after.seen).toHaveLength(1);
  });

  it('lets go of a window that disconnected, and tells it nothing more', () => {
    const feed = createRoomFeed();
    const one = heard(feed);
    expect(feed.watching()).toBe(1);
    one.stop();
    expect(feed.watching()).toBe(0);
    feed.tell({ roomId: 'build', chat: 'changed' });
    expect(one.seen).toEqual([]);
    // Letting go twice is what a browser that reloads mid-write does; it must not take somebody else's place with it.
    const two = heard(feed);
    one.stop();
    feed.tell({ roomId: 'build', chat: 'changed' });
    expect(two.seen).toHaveLength(1);
  });
});
