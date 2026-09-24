// How a key that keeps failing is left alone, one key at a time. Two ways of failing, two ways of resting:
// a 429 that names no wait rests the key three seconds, then six, then twelve, up to five minutes, and one good answer
// clears it; a provider that errors (5xx) or times out (408) five times in a row is taken out for thirty seconds, then
// trusted with exactly one request, which closes it again on success and opens it for another thirty on failure.
// A resting key is only moved to the back: its siblings serve, and it is still there when nothing else is.
export const TRIPS = 5;
export const OPEN_MS = 30_000;
export const REST_FIRST = 3000;
export const REST_MOST = 5 * 60_000;

type Key = { fails: number; openUntil?: number; probeUntil?: number; half?: boolean; rest?: number; restUntil?: number };

const statusOf = (error: unknown) => (error as { status?: number })?.status;
const headerWait = (error: unknown) => {
  const seconds = Number((error as { headers?: Headers })?.headers?.get?.('retry-after'));
  return seconds > 0 ? seconds * 1000 : undefined;
};
// A request that never got an answer is the provider down as much as a 503 is. An abort is the founder's Stop, not a failure.
const TIMED_OUT = /timed? ?out|ECONNRESET|ECONNREFUSED|fetch failed|Connection error/i;
export const brokeDown = (error: unknown) => {
  const status = statusOf(error);
  if (status !== undefined) return status >= 500 || status === 408;
  const { name, message } = (error ?? {}) as Error;
  return name !== 'AbortError' && TIMED_OUT.test(`${name} ${message}`);
};

export function createBreaker(now: () => number = Date.now) {
  const keys: Record<string, Key> = {};
  const key = (name: string) => (keys[name] ??= { fails: 0 });

  return {
    // One failed request. Gives back how long the key now rests, or 0 when this failure is not the kind we count.
    failed(name: string, error: unknown): number {
      const one = key(name);
      if (statusOf(error) === 429) {
        const asked = headerWait(error);
        const rest = asked ?? Math.min(one.rest ? one.rest * 2 : REST_FIRST, REST_MOST);
        if (asked === undefined) one.rest = rest;
        one.restUntil = now() + rest;
        return rest;
      }
      if (!brokeDown(error)) return 0;
      one.fails += 1;
      if (one.half || one.fails >= TRIPS) {
        one.openUntil = now() + OPEN_MS;
        one.half = false;
        one.probeUntil = undefined;
        return OPEN_MS;
      }
      return 0;
    },
    // A good answer: whatever was held against the key is forgotten.
    ok(name: string) { if (keys[name]) keys[name] = { fails: 0 }; },
    // True while the key should be skipped by the ranking: resting after a 429, open, or half open with its one
    // request already out.
    resting(name: string) {
      const one = keys[name];
      if (!one) return false;
      const at = now();
      if ((one.restUntil ?? 0) > at || (one.openUntil ?? 0) > at) return true;
      return !!one.half && (one.probeUntil ?? 0) > at;
    },
    // Asked right before a request goes out. An open key says no; a key whose thirty seconds are up lets exactly one
    // request through and says no to the rest until that one has answered (or thirty more seconds have passed).
    admit(name: string) {
      const one = keys[name];
      if (!one?.openUntil) return true;
      const at = now();
      if (one.openUntil > at) return false;
      if (one.half && (one.probeUntil ?? 0) > at) return false;
      one.half = true;
      one.probeUntil = at + OPEN_MS;
      return true;
    },
    state(name: string): 'closed' | 'open' | 'half-open' {
      const one = keys[name];
      if (!one?.openUntil) return 'closed';
      return one.openUntil > now() ? 'open' : 'half-open';
    },
  };
}
export type Breaker = ReturnType<typeof createBreaker>;
