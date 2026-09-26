import type { Stage } from '../shared/model';

// Two windows on one stage. Each holds the stage as the server last told it (`base`, with its revision) and the stage
// as the founder has it now (`mine`). When the server has moved on (`theirs`), the two are put together card by card:
// what this window changed or added since `base` is kept as this window has it, what it took away stays away, and
// everything else is taken as the server has it, including what the other window added or took away.

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function mergeList<T extends { id: string }>(base: T[], mine: T[], theirs: T[]): T[] {
  const was = new Map(base.map((one) => [one.id, one]));
  const now = new Map(mine.map((one) => [one.id, one]));
  const there = new Set(theirs.map((one) => one.id));
  const out: T[] = [];
  for (const one of theirs) {
    const before = was.get(one.id);
    const here = now.get(one.id);
    if (before && !here) continue;
    out.push(here && (!before || !same(before, here)) ? here : one);
  }
  for (const one of mine) if (!there.has(one.id) && !was.has(one.id)) out.push(one);
  return out;
}

export function mergeStage(base: Stage, mine: Stage, theirs: Stage): Stage {
  const rooms = mergeList(base.rooms, mine.rooms, theirs.rooms);
  const docs = mergeList(base.docs, mine.docs, theirs.docs);
  const cards = mergeList(base.cards ?? [], mine.cards ?? [], theirs.cards ?? []);
  // A wire is kept only while both of its ends are.
  const ends = new Set([...rooms, ...docs, ...cards].map((one) => one.id));
  const wires = mergeList(base.wires, mine.wires, theirs.wires).filter((wire) => ends.has(wire.from) && ends.has(wire.to));
  return { rooms, docs, cards, wires, rev: theirs.rev };
}

// What the server says to a save: the new revision, or that the stage moved on, with the stage as it is now.
export type PutAnswer = { rev: number } | { stale: Stage };

// The founder's stage saved on the revision this window last saw. Refused, it is put together with the newer stage
// and saved again, once: a stage that keeps moving under it is left for the next save. `base` is what the server
// now has, as far as this window knows; `merged` is the stage the window should show, when it has to change.
export async function saveOver(base: Stage, mine: Stage, put: (stage: Stage) => Promise<PutAnswer>): Promise<{ saved: boolean; base: Stage; merged?: Stage }> {
  let from = base;
  let sent: Stage = { ...mine, rev: base.rev ?? 0 };
  let merged: Stage | undefined;
  for (let tries = 0; tries < 2; tries += 1) {
    const answer = await put(sent);
    if ('rev' in answer) return { saved: true, base: { ...sent, rev: answer.rev }, merged };
    merged = mergeStage(from, sent, answer.stale);
    from = answer.stale;
    sent = merged;
  }
  return { saved: false, base: from, merged };
}
