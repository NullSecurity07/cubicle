import type { Attention, AttentionKind, Decision } from '../../shared/model.ts';
import type { Stage } from '../../shared/model.ts';
import { filled, sectionBody, verdictOf } from '../tools/verdict.ts';
import { NO_SIGNAL, type PartnerCall } from './call.ts';
import { decisionLine, learnedSection } from './company.ts';
import { isWeak, type TeamVerdict } from './pushback.ts';
import { betLine, gatherCompany, type CompanyGather, type MorningSources } from './morning.ts';

// The standing facts: what the morning note is written from, cut to what holds across every room, carried in every
// partner turn. Journey 5 found the note leading with the team's WEAK verdict while, minutes later, the partner's own
// answers told the founder to ship the thing the verdict said to pause, and told them to approve tasks and take a bet
// they had already approved and taken. A partner who holds the whole company has these in front of them every time.

export const STANDING_HEAD = 'Standing facts, read in code from every room just now. When one contradicts the founder\'s ask or your own advice, say so first:';
export const STANDING_MOST = 1500;
const LINE_MOST = 220;
const DECIDED_MOST = 4;

// What the gather gives, plus the decisions on record, as the slice caches them between ticks.
// `learned`: one line per closed bet, as What we learned in the Company document has it.
// `promised`: the founder's open promises, one line each, read fresh every turn.
// `declined`: what the founder said no to lately, one line each (server/partner/saidno.ts), read fresh every turn.
// `call`: the partner's own verdict on record, read from the partner's notes every turn (verdictLines).
// `corrected`: what the founder put right in chat, one line each (server/partner/corrections.ts), read fresh every turn.
export type StandingParts = Pick<CompanyGather, 'verdicts' | 'numbers' | 'open' | 'planned' | 'flagCounts'> & { decided: string[]; learned: string[]; promised?: string[]; declined?: string[]; call?: string[]; corrected?: string[] };

// Journey 14, day 2: "what did we decide yesterday, and what kill signal do we hold ourselves to?" The partner said
// nothing was decided and gave the runway it had got wrong; retain had kept nothing from day 1, since it asks the model
// on this machine only every third turn, and the pushback that moved the kill signal was one it skipped. The verdict
// is on record in code (the call, the reason, the kill signal, the first move), so it is in every turn without a model.
export function verdictLines(call: (PartnerCall & { day: string }) | undefined): string[] {
  if (!call?.decision) return [];
  return [
    `Your verdict on ${call.day}: ${call.decision}.${call.why ? ` Why: ${call.why.replace(/[\s.]+$/, '')}.` : ''}`,
    `Kill signal: ${call.signal ? `${call.signal.what} by ${call.signal.by}` : NO_SIGNAL}.${call.move ? ` This week: ${call.move.replace(/[\s.]+$/, '')}.` : ''}`,
  ];
}

export async function standingParts(from: MorningSources): Promise<StandingParts> {
  const got = await gatherCompany(from, { verdictChars: LINE_MOST });
  const decided = (await from.decisions().catch(() => [] as Decision[])).filter((one) => one.status === 'decided')
    .sort((a, b) => (b.decidedAt ?? b.at) - (a.decidedAt ?? a.at)).slice(0, DECIDED_MOST).map(decisionLine);
  return { verdicts: got.verdicts, numbers: got.numbers, open: got.open, planned: got.planned, flagCounts: got.flagCounts, decided, learned: learnedSection(got.closed) };
}

// What waits in Needs you, by kind, in the founder's words. The partner's own morning note is left out.
const WAITING: Partial<Record<AttentionKind, [one: string, many: string]>> = {
  'proposed-decision': ['decision to make', 'decisions to make'],
  'proposed-bet': ['bet to take or leave', 'bets to take or leave'],
  'bet-check': ['bet to check', 'bets to check'],
  'proposed-plan': ['plan to put on the board', 'plans to put on the board'],
  'review-flag': ['team doc flagged to fix', 'team docs flagged to fix'],
  'proposed-task': ['task to accept', 'tasks to accept'],
  approval: ['action to approve', 'actions to approve'],
  'run-approval': ['run to approve', 'runs to approve'],
  'proposed-source': ['website to add', 'websites to add'],
  'proposed-target': ['target to set', 'targets to set'],
  'proposed-runway': ['runway figure to confirm', 'runway figures to confirm'],
  'mail-draft': ['email to send', 'emails to send'],
  'partner-proposal': ['unasked move to run or turn down', 'unasked moves to run or turn down'],
};
const quoted = (title: string) => `"${title.replace(/\s+/g, ' ').trim().slice(0, 60)}"`;

// One line: what waits, by kind and count with the first titles, and that nothing else does. A done item is gone from
// Needs you, so it is gone from here: the partner never tells the founder to do what they already did.
export function waitingLine(items: Attention[]): string {
  const groups = new Map<string, Attention[]>();
  for (const item of items) {
    if (item.kind === 'morning-note') continue;
    const key = item.kind;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  if (!groups.size) return 'Waiting in Needs you: nothing. Never tell the founder something waits there.';
  const parts = [...groups.entries()].map(([kind, list]) => {
    const [one, many] = WAITING[kind as AttentionKind] ?? [kind.replace(/-/g, ' '), `${kind.replace(/-/g, ' ')}s`];
    const titles = list.slice(0, 2).map((item) => quoted(item.title)).join(', ');
    return `${list.length} ${list.length === 1 ? one : many} (${titles}${list.length > 2 ? ', …' : ''})`;
  });
  return `Waiting in Needs you: ${parts.join('; ')}. Nothing else waits there: anything the founder already answered is done.`;
}

// What waits, held to the bets ledger: a bet row in Needs you whose bet the ledger no longer has as proposed (taken or
// left a moment ago, the row not yet refreshed) does not wait, whatever the row says.
export function stillWaiting(items: Attention[], bets: { id: string; status: string }[]): Attention[] {
  const proposed = new Set(bets.filter((bet) => bet.status === 'proposed').map((bet) => bet.id));
  return items.filter((item) => item.kind !== 'proposed-bet' || proposed.has(item.id.slice('proposed-bet:'.length)));
}

const cut = (line: string) => (line.length > LINE_MOST ? `${line.slice(0, LINE_MOST - 1)}…` : line);

// The block itself, in the order it matters, whole lines only and never longer than STANDING_MOST. What waits in
// Needs you is read fresh every turn and goes right under the verdicts, so a cap never takes it away.
export function standingBlock(parts: StandingParts, waiting: Attention[]): string {
  const sections: [string, string[]][] = [
    ['Your own verdict on record (quote it as it stands when asked what was decided; never make up another):', parts.call ?? []],
    ['The founder corrected (their word stands over any figure before it; never say the wrong one again):', parts.corrected ?? []],
    ['Team verdicts:', parts.verdicts],
    ['', [waitingLine(waiting)]],
    ['Company Numbers:', parts.numbers ? parts.numbers.split('\n').filter((line) => line.trim()) : ['- none written yet']],
    ['Decided:', parts.decided],
    // "Open" alone read as "still to take": journey 10's partner told the founder to accept a bet they had taken.
    ['Bets on record (the founder took each; none waits in Needs you):', parts.open.map(betLine)],
    ['What we learned (closed bets; cite the line when advice rests on it):', parts.learned ?? []],
    ['Due on the board:', parts.planned],
    ['The founder\'s promises:', parts.promised ?? []],
    ['The founder said no to (never put one to them again as new):', parts.declined ?? []],
    ['', parts.flagCounts.length ? [`Truth net since yesterday: ${parts.flagCounts.map((one) => `${one.room} had ${one.count} flagged ${one.count === 1 ? 'line' : 'lines'}`).join('; ')}. Never repeat a flagged figure as a fact.`] : []],
  ];
  const lines = [STANDING_HEAD];
  let size = STANDING_HEAD.length;
  const add = (line: string) => { if (size + line.length + 1 > STANDING_MOST) return false; lines.push(line); size += line.length + 1; return true; };
  for (const [head, body] of sections) {
    if (!body.length) continue;
    // A heading goes in only with at least its first line under it.
    if (head && size + head.length + cut(body[0]).length + 2 > STANDING_MOST) break;
    if (head) add(head);
    for (const line of body) if (!add(cut(line))) break;
  }
  return lines.join('\n');
}

// The weakest team verdict on the stage, as its own document has it: the first weak one, else none. What the partner's
// reply and a proposed bet are held to (server/partner/pushback.ts).
export async function teamVerdict(stage: Stage, readDoc: (id: string) => Promise<string>): Promise<TeamVerdict | null> {
  for (const doc of stage.docs.filter((one) => one.rules)) {
    const body = sectionBody(await readDoc(doc.id).catch(() => ''), doc.rules!.verdict.heading);
    if (!filled(body).length) continue;
    const { word, score } = verdictOf(body ?? '', doc.rules!.outcomes ?? []);
    const verdict: TeamVerdict = { title: doc.title, ...(word ? { word } : {}), ...(score !== undefined ? { score } : {}) };
    if ((word || score !== undefined) && isWeak(verdict)) return verdict;
  }
  return null;
}

// Journey 6: "Approve the task board: check your Needs you list" with nothing waiting there. A reply that sends the
// founder to Needs you while nothing waits gets a line saying so.
// Journey 7 widened it: "check your decisions list and approve" is the same advice without the words "Needs you".
const SENDS_TO_NEEDS = /\b(?:approve|accept|decline|check|review|answer|take|decide)\b[^.\n]{0,80}\b(?:needs you|decisions?|tasks?|bets?|proposals?|your (?:\w+\s+)?list)\b|\bwaiting\b[^.\n]{0,30}\bneeds you\b|\bneeds you\b[^.\n]{0,30}\b(?:waiting|list)\b/i;
export const NOTHING_WAITING = '(Nothing is waiting in Needs you.)';
export function staleNeeds(reply: string, waiting: Attention[]): string {
  if (!SENDS_TO_NEEDS.test(reply) || waiting.some((item) => item.kind !== 'morning-note')) return reply;
  return `${reply.replace(/\s+$/, '')}\n\n${NOTHING_WAITING}`;
}
