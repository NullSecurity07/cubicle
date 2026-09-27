// How a key that keeps failing is left alone, one key at a time. Two ways of failing, two ways of resting:
// a 429 that names no wait rests the key three seconds, then six, then twelve, up to five minutes, and one good answer
// clears it; a provider that errors (5xx) or times out (408) five times in a row is taken out for thirty seconds, then
// trusted with exactly one request, which closes it again on success and opens it for another thirty on failure.
// A key the provider refuses (401, 403) is dead, not busy: it rests six hours, so it stops going first every turn, and
// one good answer brings it back. The usage book tells the founder once.
// A resting key is only moved to the back: its siblings serve, and it is still there when nothing else is.
const TRIPS = 5;
export const OPEN_MS = 30_000;
const REST_FIRST = 3000;
export const REST_MOST = 5 * 60_000;
export const DEAD_MS = 6 * 3_600_000;

type Key = { fails: number; openUntil?: number; probeUntil?: number; half?: boolean; rest?: number; restUntil?: number; deadUntil?: number };

const statusOf = (error: unknown) => (error as { status?: number })?.status;
// A key whose plan allows no requests at all is refused, not busy: Mistral answers a key with no plan chosen yet with
// a 429 whose headers say the minute allows nothing (x-ratelimit-limit-req-minute: 0), and waiting never fixes that.
export const planless = (error: unknown) => {
  if (statusOf(error) !== 429) return false;
  const headers = (error as { headers?: Headers })?.headers;
  if (typeof headers?.forEach !== 'function') return false;
  let none = false;
  headers.forEach((value, name) => { if (/^x-ratelimit-limit-/i.test(name) && value.trim() === '0') none = true; });
  return none;
};
// A 403 for a prompt the provider's moderation flagged (OpenRouter does this) says nothing about the key.
export const refused = (error: unknown) => statusOf(error) === 401
  || (statusOf(error) === 403 && !/moderat|flagged/i.test(String((error as Error)?.message ?? '')))
  || planless(error);
// Which free limit a 429 hit, in the words the founder reads, from what the provider wrote: the day's quota is not
// the same news as a busy minute, and the dashboard's "left today" is only about the first.
export const limitWords = (error: unknown) => {
  const said = String((error as Error)?.message ?? '');
  if (/per.?day|\bRPD\b|\bTPD\b|daily/i.test(said)) return "today's free limit reached";
  if (/per.?minute|\bRPM\b|\bTPM\b/i.test(said)) return 'busy this minute';
  return 'busy for now';
};
// How long a provider said to wait before asking again, from its Retry-After header, whatever the status.
export const headerWait = (error: unknown) => {
  const seconds = Number((error as { headers?: Headers })?.headers?.get?.('retry-after'));
  return seconds > 0 ? seconds * 1000 : undefined;
};
// A request that never got an answer is the provider down as much as a 503 is. An abort is the founder's Stop, not a failure.
const TIMED_OUT = /timed? ?out|ECONNRESET|ECONNREFUSED|fetch failed|Connection error/i;
// A model that cannot make its own tool call (Groq's 400 failed_generation) is broken for this kind of work, not asked
// wrongly: five in a row rest it like five 503s would, so it is not first in line again next turn.
const MALFORMED = /failed_generation|failed to call a function/i;
const brokeDown = (error: unknown) => {
  const status = statusOf(error);
  if (status === 400 && MALFORMED.test((error as Error)?.message ?? '')) return true;
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
      if (refused(error)) {
        one.deadUntil = now() + DEAD_MS;
        return DEAD_MS;
      }
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
      if ((one.restUntil ?? 0) > at || (one.openUntil ?? 0) > at || (one.deadUntil ?? 0) > at) return true;
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
    // True while the key rests after the provider refused it.
    dead: (name: string) => (keys[name]?.deadUntil ?? 0) > now(),
    state(name: string): 'closed' | 'open' | 'half-open' {
      const one = keys[name];
      if (!one?.openUntil) return 'closed';
      return one.openUntil > now() ? 'open' : 'half-open';
    },
  };
}
