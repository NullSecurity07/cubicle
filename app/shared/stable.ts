// JSON with every object's keys in one order, so two copies of the same value always read the same. Plain
// JSON.stringify keeps the order the keys were set in: a card a change on the server wrote field by field reads as
// different from the same card a window wrote, and a compare would take an unchanged card for a changed one.
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, held: unknown) => (held && typeof held === 'object' && !Array.isArray(held)
    ? Object.fromEntries(Object.entries(held as Record<string, unknown>).sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0)))
    : held));
}
