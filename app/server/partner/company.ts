import type { Decision, Doc, Stage } from '../../shared/model.ts';
import { companyTemplate, COMPANY_TITLE, isCompanyTitle, VERDICT_WORDS, type Bet } from '../../shared/partner.ts';
import { DOC_SIZE } from '../../shared/frameworks.ts';
import { localDay } from '../clock.ts';
import type { Store } from '../store.ts';
import { headingKey, headings, replaceSection } from '../tools/sections.ts';

// The Company document: one pinned doc every person reads, which the app writes into as things are decided and bet
// on. Written with `writeDoc`, not `replaceDoc`, because a line appended on its own is not the founder's work to keep
// a copy of in the trash every time.

type CompanyStore = Pick<Store, 'loadStage' | 'patchStage' | 'readDoc' | 'writeDoc'>;
export const COMPANY_ID = 'company';

export const companyDocOf = (stage: Stage): Doc | undefined => stage.docs.find((doc) => isCompanyTitle(doc.title));

// Beside the documents already on the stage, level with the first pinned one.
function placeOf(stage: Stage) {
  const right = Math.max(0, ...stage.docs.map((doc) => doc.x + doc.w));
  const top = stage.docs.find((doc) => doc.pinned)?.y ?? stage.docs[0]?.y ?? 40;
  return stage.docs.length ? { x: right + 60, y: top } : { x: 520, y: 40 };
}

// The document on the stage, made if it is not there, and given its sections if it is there but empty (the window
// put it down with a new partner and has not written anything into it). A Company doc with words in it is left as is.
export async function ensureCompany(store: CompanyStore): Promise<{ id: string; created: boolean }> {
  let made: string | null = null;
  const stage = await store.patchStage((draft) => {
    if (companyDocOf(draft)) return;
    const id = draft.docs.some((doc) => doc.id === COMPANY_ID) ? `${COMPANY_ID}-${Date.now().toString(36)}` : COMPANY_ID;
    draft.docs.push({ id, title: COMPANY_TITLE, pinned: true, ...placeOf(draft), w: DOC_SIZE.w, h: DOC_SIZE.h + 160 });
    made = id;
  });
  const id = companyDocOf(stage)!.id;
  if (!(await store.readDoc(id)).trim()) await store.writeDoc(id, companyTemplate());
  return { id, created: made !== null };
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
export async function syncDecisions(store: CompanyStore, docId: string, all: Decision[], known: string[]): Promise<string[]> {
  const held = new Set(known);
  const fresh = all.filter((one) => one.status === 'decided' && !held.has(one.id)).sort((a, b) => (a.decidedAt ?? a.at) - (b.decidedAt ?? b.at));
  if (!fresh.length) return known;
  await store.writeDoc(docId, addToSection(await store.readDoc(docId), 'Decisions', fresh.map(decisionLine)));
  return [...known, ...fresh.map((one) => one.id)];
}

// The ledger as the Company document shows it: open bets first, then the ones that were checked, newest first.
export function betsSection(bets: Bet[]): string {
  const open = bets.filter((bet) => bet.status === 'open').map((bet) => `- Open: ${bet.what}. ${bet.metric} to ${bet.target} by ${bet.checkDate} (made ${bet.made})`);
  const closed = bets.filter((bet) => bet.status === 'closed' && bet.result).sort((a, b) => b.checkDate.localeCompare(a.checkDate)).map((bet) => {
    const verdict = VERDICT_WORDS[bet.result!.verdict];
    const value = bet.result!.value === null ? 'could not be read' : `was ${bet.result!.value} against ${bet.target}`;
    return `- ${verdict.charAt(0).toUpperCase()}${verdict.slice(1)}: ${bet.what}. ${bet.metric} ${value} (checked ${bet.checkDate})${bet.result!.note ? `. ${bet.result!.note}` : ''}`;
  });
  return [...open, ...closed].join('\n');
}

// The Bets section is the ledger's own: it is written whole from `bets.json` whenever a bet changes.
export async function writeBets(store: CompanyStore, docId: string, bets: Bet[]) {
  const text = await store.readDoc(docId);
  const body = betsSection(bets);
  const swapped = replaceSection(text, 'Bets', body);
  const next = 'text' in swapped ? swapped.text : addToSection(text, 'Bets', body ? body.split('\n') : []);
  if (next !== text) await store.writeDoc(docId, next);
}
