import type { Box, Decision, Doc, Stage } from '../../shared/model.ts';
import { bare, COMPANY_SECTIONS, companyTemplate, COMPANY_TITLE, findCompanyDoc, VERDICT_WORDS, type Bet } from '../../shared/partner.ts';
import { DOC_SIZE } from '../../shared/frameworks.ts';
import { localDay } from '../clock.ts';
import type { Store } from '../store.ts';
import { headingKey, headings, replaceSection } from '../tools/sections.ts';

// The Company document: one pinned doc every person reads, which the app writes into as things are decided and bet
// on. Written with `writeDoc`, not `replaceDoc`, because a line appended on its own is not the founder's work to keep
// a copy of in the trash every time.

type CompanyStore = Pick<Store, 'loadStage' | 'patchStage' | 'readDoc' | 'writeDoc'>;
// Told after every write the app makes into the document, so an open Company card reads it again rather than saving
// its old text over the new lines with the founder's next keystroke.
export type Changed = (docId: string) => void;
export const COMPANY_ID = 'company';

// The recorded one while it is there; with nothing recorded, the first pinned one called "Company" or "Company brief".
export const companyDocOf = (stage: Stage, id?: string): Doc | undefined => findCompanyDoc(stage.docs, id);

// Right of everything already on the stage (people, documents and cards), level with the first pinned doc.
export function placeOf(stage: Stage) {
  const all: Box[] = [...stage.rooms, ...stage.docs, ...(stage.cards ?? [])];
  if (!all.length) return { x: 520, y: 40 };
  const right = Math.max(...all.map((one) => one.x + one.w));
  const top = stage.docs.find((doc) => doc.pinned)?.y ?? Math.min(...all.map((one) => one.y));
  return { x: right + 60, y: top };
}

// The sections the document is missing, added at its end; the founder's own lines are never moved or rewritten.
export function withSections(text: string): string {
  if (!text.trim()) return companyTemplate();
  const have = new Set(headings(text).map((one) => headingKey(one.title)));
  const missing = COMPANY_SECTIONS.filter((name) => !have.has(headingKey(name)));
  return missing.length ? `${text.replace(/\s+$/, '')}\n\n${missing.map((name) => `## ${name}`).join('\n\n')}\n` : text;
}

// The company's one document: the one named by `id` when it is on the stage, else the pinned "Company" or "Company
// brief" the stage already has (adopted: its id, its title and its text kept), else a new "Company". Whichever it is
// gets the sections it lacks.
export async function ensureCompany(store: CompanyStore, id?: string, changed: Changed = () => {}): Promise<{ id: string; created: boolean }> {
  let made: string | null = null;
  const stage = await store.patchStage((draft) => {
    if (companyDocOf(draft, id) ?? companyDocOf(draft)) return;
    const fresh = draft.docs.some((doc) => doc.id === COMPANY_ID) ? `${COMPANY_ID}-${Date.now().toString(36)}` : COMPANY_ID;
    draft.docs.push({ id: fresh, title: COMPANY_TITLE, pinned: true, ...placeOf(draft), w: DOC_SIZE.w, h: DOC_SIZE.h + 160 });
    made = fresh;
  });
  const doc = (companyDocOf(stage, id) ?? companyDocOf(stage))!;
  const before = await store.readDoc(doc.id);
  const after = withSections(before);
  if (after !== before) { await store.writeDoc(doc.id, after); changed(doc.id); }
  return { id: doc.id, created: made !== null };
}

// Lines added at the end of one section, before the next heading of the same level or higher; the section is made at
// the end of the document when it is not there.
export function addToSection(text: string, heading: string, lines: string[]): string {
  if (!lines.length) return text;
  const all = headings(text);
  const hit = all.find((one) => headingKey(one.title) === headingKey(heading));
  if (!hit) return `${text.replace(/\s+$/, '')}\n\n## ${heading}\n\n${lines.join('\n')}\n`;
  const rows = text.split('\n');
  const next = all.find((one) => one.line > hit.line && one.level <= hit.level);
  let end = next ? next.line : rows.length;
  while (end > hit.line + 1 && !rows[end - 1].trim()) end -= 1;
  const gap = end === hit.line + 1 ? [''] : [];
  return [...rows.slice(0, end), ...gap, ...lines, ...rows.slice(end)].join('\n');
}

export const decisionLine = (decision: Decision) => `- ${localDay(decision.decidedAt ?? decision.at)} ${decision.title}: ${(decision.chosen ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)}`;

// Every decided decision not yet written goes under Decisions as one dated line, oldest first. Hands back every id
// written so far, so a decision is never written twice however often this runs.
// How long after the app writes a decision's line it puts that line back if it goes missing: long enough for a window
// that had the document open to save its old text over it, short enough that a line the founder deletes or rewords
// later stays as they left it.
export const RESTORE_FOR = 2 * 60_000;
export type DecisionsWritten = { decided: string[]; writtenAt?: Record<string, number> };
// The text under the Decisions heading, up to the next heading of the same level or higher.
export function sectionText(text: string, heading: string): string {
  const all = headings(text);
  const hit = all.find((one) => headingKey(one.title) === headingKey(heading));
  if (!hit) return '';
  const next = all.find((one) => one.line > hit.line && one.level <= hit.level);
  return text.split('\n').slice(hit.line + 1, next ? next.line : undefined).join('\n');
}
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whether the Decisions section already has this decision's line: "- <date> <title>:" at the start of a line. Its
// date or what follows the colon may have changed (another time zone, a founder's rewording); it is still that
// decision's line. The founder's own words elsewhere, and a longer title ending in this one, are not.
export function hasLine(text: string, decision: Pick<Decision, 'title'>): boolean {
  const title = decision.title.trim();
  if (!title) return false;
  return new RegExp(`^- \\S+ ${escaped(title)}:`, 'm').test(sectionText(text, 'Decisions'));
}

// Each decided decision gets one dated line under Decisions, oldest first, once. A line the app wrote goes back in
// only while it is fresh (a window saved over it); after that the founder's edits stand.
export async function syncDecisions(store: CompanyStore, docId: string, all: Decision[], held: DecisionsWritten, changed: Changed = () => {}, now = Date.now()): Promise<DecisionsWritten> {
  const known = new Set(held.decided);
  const writtenAt = Object.fromEntries(Object.entries(held.writtenAt ?? {}).filter(([, at]) => now - at < RESTORE_FOR));
  const decided = all.filter((one) => one.status === 'decided').sort((a, b) => (a.decidedAt ?? a.at) - (b.decidedAt ?? b.at));
  const text = await store.readDoc(docId);
  const due = decided.filter((one) => (!known.has(one.id) || one.id in writtenAt) && !hasLine(text, one));
  if (due.length) {
    const fresh = due.filter((one) => !known.has(one.id));
    await store.writeDoc(docId, answerQuestions(addToSection(text, 'Decisions', due.map(decisionLine)), fresh));
    changed(docId);
    for (const one of due) if (!known.has(one.id)) writtenAt[one.id] = now;
  }
  return { decided: [...held.decided, ...decided.filter((one) => !known.has(one.id)).map((one) => one.id)], writtenAt };
}

const words = (text: string) => text.toLowerCase().replace(/[*_`~?.!:,;"'()]/g, ' ').replace(/\s+/g, ' ').trim();
// A question under Open questions that a decision just answered is struck through, with the answer and its day,
// rather than left open. It matches when one reads as the other ("Newsletter first or marketplace first?").
export function answerQuestions(text: string, decided: Decision[]): string {
  const all = headings(text);
  const hit = all.find((one) => headingKey(one.title) === headingKey('Open questions'));
  if (!hit || !decided.length) return text;
  const next = all.find((one) => one.line > hit.line && one.level <= hit.level);
  const lines = text.split('\n');
  for (let at = hit.line + 1; at < (next ? next.line : lines.length); at += 1) {
    const item = /^(\s*[-*+]\s+)(.+)$/.exec(lines[at]);
    if (!item || item[2].startsWith('~~')) continue;
    const asked = words(item[2]);
    const answer = decided.find((one) => { const title = words(one.title); return asked.length >= 8 && title.length >= 8 && (asked.includes(title) || title.includes(asked)); });
    if (answer) lines[at] = `${item[1]}~~${item[2].trim()}~~ Decided ${localDay(answer.decidedAt ?? answer.at)}: ${(answer.chosen ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}`;
  }
  return lines.join('\n');
}

// The ledger as the Company document shows it: open bets first, then the ones that were checked, newest first.
export function betsSection(bets: Bet[]): string {
  const open = bets.filter((bet) => bet.status === 'open').map((bet) => `- Open: ${bare(bet.what)}. ${bet.metric} to ${bet.target} by ${bet.checkDate} (made ${bet.made})`);
  const closed = bets.filter((bet) => bet.status === 'closed' && bet.result).sort((a, b) => b.checkDate.localeCompare(a.checkDate)).map((bet) => {
    const verdict = VERDICT_WORDS[bet.result!.verdict];
    const value = bet.result!.value === null ? 'could not be read' : `was ${bet.result!.value} against ${bet.target}`;
    return `- ${verdict.charAt(0).toUpperCase()}${verdict.slice(1)}: ${bare(bet.what)}. ${bet.metric} ${value} (checked ${bet.checkDate})${bet.result!.note ? `. ${bare(bet.result!.note)}.` : ''}`;
  });
  return [...open, ...closed].join('\n');
}

// The Bets section is the ledger's own: it is written whole from `bets.json` whenever a bet changes.
export async function writeBets(store: CompanyStore, docId: string, bets: Bet[], changed: Changed = () => {}) {
  const text = await store.readDoc(docId);
  const body = betsSection(bets);
  const swapped = replaceSection(text, 'Bets', body);
  const next = 'text' in swapped ? swapped.text : addToSection(text, 'Bets', body ? body.split('\n') : []);
  if (next !== text) { await store.writeDoc(docId, next); changed(docId); }
}
