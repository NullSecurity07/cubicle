import type { Handler } from './seams.ts';

export const ALREADY_RAN = 'You already ran this exact call this turn. Use its result.';

// A person who searches the same thing twice learns nothing the second time and spends the founder's quota doing it.
// What succeeded is remembered per room, which is per turn: a room holds one turn at a time, and every turn clears it
// at `turn:before`, so two people working at once never see each other's calls.
export function createGuards() {
  const done = new Map<string, Set<string>>();
  const signature = (name: string, args: Record<string, unknown>) => `${name} ${JSON.stringify(args)}`;

  return {
    reset: (async (payload, next) => {
      done.set(payload.roomId, new Set());
      return next(payload);
    }) satisfies Handler<'turn:before'>,
    before: (async (payload, next) => {
      const { call } = payload;
      const repeat = done.get(payload.roomId)?.has(signature(call.name, call.args));
      return next(repeat && !payload.refusal ? { ...payload, refusal: ALREADY_RAN } : payload);
    }) satisfies Handler<'tool:before'>,
    after: (async (payload, next) => {
      const { event } = payload;
      if (event.ok) {
        const seen = done.get(payload.roomId) ?? new Set<string>();
        done.set(payload.roomId, seen.add(signature(event.name, event.args)));
      }
      return next(payload);
    }) satisfies Handler<'tool:after'>,
  };
}
