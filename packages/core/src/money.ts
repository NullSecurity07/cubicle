// ---------- the CFO's split ----------

/** Where the heartbeat's own calls, the board, security and anyone with no division are charged. */
export const HOUSE = 'house';
/** No division is ever allocated less than this: a division that cannot hold one planning round is stopped, not budgeted. */
export const MIN_DIVISION_CALLS = 20;
/** Taken off the top for the house before the divisions split the rest. */
export const HOUSE_RESERVE_PCT = 0.25;

export interface DivisionWeight { id: string; people: number }

/**
 * Split a day's free calls between the divisions and the house.
 *
 * The house is reserved first, because the heartbeat, the gates and the board session are what keep the company
 * coherent and must not be starved by whichever division is busiest. What is left goes by headcount, with a
 * floor so a small division can still hold a planning round, and the remainder distributed largest-fraction
 * first so the allocation sums to the capacity **exactly** — a split that drifts by a call a day is a gauge
 * that slowly stops meaning anything.
 *
 * Deterministic: divisions are sorted by id and ties in the remainder are broken by id, so two calls with the
 * same input always return the same object.
 */
export function allocateQuota(capacity: number, divisions: DivisionWeight[], opts: { reservePct?: number; floor?: number } = {}): Record<string, number> {
  const cap = Math.max(0, Math.floor(capacity));
  const reservePct = opts.reservePct ?? HOUSE_RESERVE_PCT;
  const floor = opts.floor ?? MIN_DIVISION_CALLS;
  const ids = [...divisions].sort((a, b) => a.id.localeCompare(b.id));
  const out: Record<string, number> = { [HOUSE]: cap };
  for (const d of ids) out[d.id] = 0;
  if (cap === 0 || ids.length === 0) return out;

  const pool = cap - Math.ceil(cap * reservePct);
  // Too small to give every division something: the house keeps it all and every division runs on the cheap
  // tier, which is the floor and is effectively unlimited. Nothing stops.
  const base = pool >= floor * ids.length ? floor : 1;
  if (pool < base * ids.length) return out;

  const remaining = pool - base * ids.length;
  const totalPeople = ids.reduce((t, d) => t + Math.max(0, d.people), 0);
  const shares = ids.map((d) => {
    const exact = totalPeople > 0 ? (remaining * Math.max(0, d.people)) / totalPeople : remaining / ids.length;
    return { id: d.id, whole: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let given = shares.reduce((t, s) => t + s.whole, 0);
  const order = [...shares].sort((a, b) => b.frac - a.frac || a.id.localeCompare(b.id));
  for (let i = 0; given < remaining; i++, given++) order[i % order.length].whole += 1;
  for (const s of shares) out[s.id] = base + s.whole;
  out[HOUSE] = cap - ids.reduce((t, d) => t + out[d.id], 0);
  return out;
}
