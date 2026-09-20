import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIET, feed } from './feed';

// A connection as the browser hands one over, driven by hand.
function fakeSources() {
  const made: { url: string; closed: boolean; readyState: number; onopen: any; onmessage: any; onerror: any; heard: Record<string, () => void>; close(): void; addEventListener(name: string, fn: () => void): void }[] = [];
  const make = (url: string) => {
    const one = { url, closed: false, readyState: 1, onopen: null as any, onmessage: null as any, onerror: null as any, heard: {} as Record<string, () => void>, close() { this.closed = true; }, addEventListener(name: string, fn: () => void) { this.heard[name] = fn; } };
    made.push(one);
    return one as any;
  };
  const says = (channel: string, data: unknown, snapshot?: true) => made.at(-1)!.onmessage({ data: JSON.stringify({ channel, data, ...(snapshot ? { snapshot } : {}) }) });
  return { made, make, says };
}

describe('one live connection for the whole window, that looks after itself', () => {
  // Every listener leaves at the end, which is also what puts the shared connection back as it was found.
  const stops: (() => void)[] = [];
  const listen = (...args: Parameters<typeof feed>) => { const stop = feed(...args); stops.push(stop); return stop; };
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { while (stops.length) stops.pop()!(); vi.useRealTimers(); });

  it('carries every channel on one connection, and hands each listener only its own news', () => {
    const { made, make, says } = fakeSources();
    const attention: unknown[] = [];
    const board: unknown[] = [];
    listen('attention', (event) => attention.push(event), () => {}, make);
    listen('board:one', (event) => board.push(event));
    expect(made).toHaveLength(1);
    expect(made[0].url).toBe('/api/events');
    made[0].onopen();
    says('attention', [{ id: 'a1' }]);
    says('board:one', { tasks: [{ id: 't1' }] });
    says('rooms', { roomId: 'marketing', chat: 'changed' });
    expect(attention).toEqual([[{ id: 'a1' }]]);
    expect(board).toEqual([{ tasks: [{ id: 't1' }] }]);
  });

  it('tells every listener when it opens, and whether it had been open before', () => {
    const { made, make } = fakeSources();
    const opens: boolean[] = [];
    listen('attention', () => {}, (again) => opens.push(again), make);
    listen('rooms', () => {}, (again) => opens.push(again));
    made[0].onopen();
    expect(opens).toEqual([false, false]);
    // The server restarted and whatever sits between kept this end open: no error, no news, no pulse.
    vi.advanceTimersByTime(QUIET + 1);
    expect(made).toHaveLength(2);
    expect(made[0].closed).toBe(true);
    made[1].onopen();
    expect(opens).toEqual([false, false, true, true]);
  });

  it('gives a listener that arrives after the connection did whatever its channel said on opening', async () => {
    const { made, make, says } = fakeSources();
    listen('attention', () => {}, () => {}, make);
    made[0].onopen();
    says('board:one', { tasks: [{ id: 't1' }] }, true);
    const late: unknown[] = [];
    listen('board:one', (event) => late.push(event));
    await Promise.resolve();
    expect(late).toEqual([{ tasks: [{ id: 't1' }] }]);
    expect(made).toHaveLength(1);
  });

  it('is kept open by the server saying it is still there, however long nothing happens', () => {
    const { made, make } = fakeSources();
    listen('rooms', () => {}, () => {}, make);
    made[0].onopen();
    for (let beat = 0; beat < 20; beat += 1) { vi.advanceTimersByTime(15_000); made[0].heard.pulse(); }
    expect(made).toHaveLength(1);
  });

  it('opens a refused connection again, and leaves one that is only reconnecting alone', () => {
    const { made, make } = fakeSources();
    listen('rooms', () => {}, () => {}, make);
    made[0].readyState = 0;
    made[0].onerror();
    vi.advanceTimersByTime(5_000);
    expect(made).toHaveLength(1);
    made[0].readyState = 2;
    made[0].onerror();
    vi.advanceTimersByTime(1_600);
    expect(made).toHaveLength(2);
  });

  it('closes for good when the last listener leaves, and opens again when a new one arrives', () => {
    const { made, make } = fakeSources();
    const first = listen('rooms', () => {}, () => {}, make);
    const second = listen('attention', () => {});
    first();
    // One card going away is not the window going away: the other listener is still on the same connection.
    expect(made[0].closed).toBe(false);
    second();
    expect(made[0].closed).toBe(true);
    vi.advanceTimersByTime(QUIET * 3);
    expect(made).toHaveLength(1);
    listen('rooms', () => {});
    expect(made).toHaveLength(2);
  });
});
