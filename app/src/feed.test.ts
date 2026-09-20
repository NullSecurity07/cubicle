import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIET, feed } from './feed';

// A feed as the browser hands one over, driven by hand.
function fakeSources() {
  const made: { url: string; closed: boolean; readyState: number; onopen: any; onmessage: any; onerror: any; heard: Record<string, () => void>; close(): void; addEventListener(name: string, fn: () => void): void }[] = [];
  const make = (url: string) => {
    const one = { url, closed: false, readyState: 1, onopen: null as any, onmessage: null as any, onerror: null as any, heard: {} as Record<string, () => void>, close() { this.closed = true; }, addEventListener(name: string, fn: () => void) { this.heard[name] = fn; } };
    made.push(one);
    return one as any;
  };
  return { made, make };
}

describe('a live feed that looks after itself', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('passes news on, and says whether it had been open before', () => {
    const { made, make } = fakeSources();
    const news: unknown[] = [];
    const opens: boolean[] = [];
    feed('/api/x', (event) => news.push(event), (again) => opens.push(again), make);
    made[0].onopen();
    made[0].onmessage({ data: '{"a":1}' });
    expect(news).toEqual([{ a: 1 }]);
    expect(opens).toEqual([false]);
  });

  it('opens again by itself when it has heard nothing at all for a while, which is what a dead feed looks like', () => {
    const { made, make } = fakeSources();
    const opens: boolean[] = [];
    feed('/api/x', () => {}, (again) => opens.push(again), make);
    made[0].onopen();
    // The server restarted and whatever sits between kept this end open: no error, no news, no pulse.
    vi.advanceTimersByTime(QUIET + 1);
    expect(made).toHaveLength(2);
    expect(made[0].closed).toBe(true);
    made[1].onopen();
    expect(opens).toEqual([false, true]);
  });

  it('is kept open by the server saying it is still there, however long nothing happens', () => {
    const { made, make } = fakeSources();
    feed('/api/x', () => {}, () => {}, make);
    made[0].onopen();
    for (let beat = 0; beat < 20; beat += 1) { vi.advanceTimersByTime(15_000); made[0].heard.pulse(); }
    expect(made).toHaveLength(1);
  });

  it('opens a refused feed again, leaves one that is only reconnecting alone, and stops for good when told to', () => {
    const { made, make } = fakeSources();
    const stop = feed('/api/x', () => {}, () => {}, make);
    made[0].readyState = 0;
    made[0].onerror();
    vi.advanceTimersByTime(5_000);
    expect(made).toHaveLength(1);
    made[0].readyState = 2;
    made[0].onerror();
    vi.advanceTimersByTime(1_600);
    expect(made).toHaveLength(2);
    stop();
    vi.advanceTimersByTime(QUIET * 3);
    expect(made).toHaveLength(2);
    expect(made[1].closed).toBe(true);
  });
});
