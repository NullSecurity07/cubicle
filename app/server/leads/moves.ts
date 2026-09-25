import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lead, LeadStage } from '../../shared/leads.ts';
import { CHASE_AFTER, nudgeId, staleDays } from '../../shared/leads-nudge.ts';

// What the app has watched happen on the Leads cards: the stage each lead was last seen in and since when, every move
// from one stage to another, and which follow-up nudges were raised and are over. A lead keeps only its current stage,
// so this is the one place a stage move is written down; the nudges and the monthly update both read it.
export type Seen = { stage: LeadStage; since: number };
export type Move = { at: number; cardId: string; leadId: string; name: string; from: LeadStage; to: LeadStage };
export type LeadBook = {
  seen: Record<string, Seen>; moves: Move[];
  // A nudge raised, by id, with the moment it became due; and the ones that are over: answered, moved on or dismissed.
  raised: Record<string, number>; done: string[];
};
export const MAX_MOVES = 2000;
const MAX_DONE = 4000;

export const emptyBook = (): LeadBook => ({ seen: {}, moves: [], raised: {}, done: [] });
export const bookPath = (workspace: string) => join(workspace, 'nudges', 'leads.json');
export async function readBook(workspace: string): Promise<LeadBook> {
  try { return { ...emptyBook(), ...JSON.parse(await readFile(bookPath(workspace), 'utf8')) as Partial<LeadBook> }; } catch { return emptyBook(); }
}
export async function writeBook(workspace: string, book: LeadBook) {
  const path = bookPath(workspace);
  await mkdir(join(workspace, 'nudges'), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(book, null, 2));
  await rename(`${path}.tmp`, path);
}

const keyOf = (cardId: string, leadId: string) => `${cardId}:${leadId}`;
// When the lead entered the stage it is in, as far as the app has seen. A lead never seen before is dated by its own
// last change, which is when it was moved if a move was the last thing done to it.
export const enteredAt = (book: LeadBook, cardId: string, lead: Pick<Lead, 'id' | 'stage' | 'updatedAt'>) => {
  const seen = book.seen[keyOf(cardId, lead.id)];
  return seen && seen.stage === lead.stage ? seen.since : lead.updatedAt;
};

// One look at one card's leads. Records every stage move since the last look, raises a nudge the first time a lead
// goes quiet in a stage, and closes one whose lead is no longer quiet there. Pure on the book: says whether it changed.
export function observe(book: LeadBook, cardId: string, leads: Lead[], now: number): boolean {
  let changed = false;
  const here = new Set<string>();
  for (const lead of leads) {
    const key = keyOf(cardId, lead.id);
    here.add(key);
    const seen = book.seen[key];
    if (!seen) { book.seen[key] = { stage: lead.stage, since: lead.updatedAt }; changed = true; }
    else if (seen.stage !== lead.stage) {
      const at = Math.max(seen.since, Math.min(lead.updatedAt, now));
      book.moves.push({ at, cardId, leadId: lead.id, name: `${lead.person.name} at ${lead.company.name}`, from: seen.stage, to: lead.stage });
      book.seen[key] = { stage: lead.stage, since: at };
      changed = true;
    }
  }
  // A lead taken off the card is forgotten; the moves it made stay, because they happened.
  for (const key of Object.keys(book.seen)) if (key.startsWith(`${cardId}:`) && !here.has(key)) { delete book.seen[key]; changed = true; }
  if (book.moves.length > MAX_MOVES) book.moves = book.moves.slice(-MAX_MOVES);

  const done = new Set(book.done);
  const stale = new Set<string>();
  for (const lead of leads) {
    if (!(lead.stage in CHASE_AFTER)) continue;
    const since = enteredAt(book, cardId, lead);
    if (staleDays(lead, since, now) === null) continue;
    const id = nudgeId(cardId, lead.id, lead.stage);
    stale.add(id);
    if (!(id in book.raised) && !done.has(id)) { book.raised[id] = now; changed = true; }
  }
  // Raised once and no longer quiet: the founder wrote, or the lead moved on. It is over for this stage.
  for (const id of Object.keys(book.raised)) {
    if (!id.startsWith(`lead-stale:${cardId}:`) || stale.has(id)) continue;
    delete book.raised[id];
    if (!done.has(id)) { book.done.push(id); done.add(id); }
    changed = true;
  }
  if (book.done.length > MAX_DONE) book.done = book.done.slice(-MAX_DONE);
  return changed;
}

// The founder waved one away: over, for this lead in this stage.
export function dismiss(book: LeadBook, id: string): boolean {
  if (book.done.includes(id)) return false;
  delete book.raised[id];
  book.done.push(id);
  return true;
}
