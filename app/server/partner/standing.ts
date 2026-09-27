import type { Attention, AttentionKind, Decision } from '../../shared/model.ts';
import { decisionLine } from './company.ts';
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
export type StandingParts = Pick<CompanyGather, 'verdicts' | 'numbers' | 'open' | 'planned' | 'flagCounts'> & { decided: string[] };

export async function standingParts(from: MorningSources): Promise<StandingParts> {
  const got = await gatherCompany(from, { verdictChars: LINE_MOST });
  const decided = (await from.decisions().catch(() => [] as Decision[])).filter((one) => one.status === 'decided')
    .sort((a, b) => (b.decidedAt ?? b.at) - (a.decidedAt ?? a.at)).slice(0, DECIDED_MOST).map(decisionLine);
  return { verdicts: got.verdicts, numbers: got.numbers, open: got.open, planned: got.planned, flagCounts: got.flagCounts, decided };
}

// What waits in Needs you, by kind, in the founder's words. The partner's own morning note is left out.
const WAITING: Partial<Record<AttentionKind, [one: string, many: string]>> = {
  'proposed-decision': ['decision to make', 'decisions to make'],
  'proposed-bet': ['bet to take or leave', 'bets to take or leave'],
  'bet-check': ['bet to check', 'bets to check'],
  'proposed-plan': ['plan to put on the board', 'plans to put on the board'],
  'proposed-task': ['task to accept', 'tasks to accept'],
  approval: ['action to approve', 'actions to approve'],
  'run-approval': ['run to approve', 'runs to approve'],
  'proposed-source': ['website to add', 'websites to add'],
  'proposed-target': ['target to set', 'targets to set'],
  'proposed-runway': ['runway figure to confirm', 'runway figures to confirm'],
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

const cut = (line: string) => (line.length > LINE_MOST ? `${line.slice(0, LINE_MOST - 1)}…` : line);

// The block itself, in the order it matters, whole lines only and never longer than STANDING_MOST. What waits in
// Needs you is read fresh every turn and goes right under the verdicts, so a cap never takes it away.
export function standingBlock(parts: StandingParts, waiting: Attention[]): string {
  const sections: [string, string[]][] = [
    ['Team verdicts:', parts.verdicts],
    ['', [waitingLine(waiting)]],
    ['Company Numbers:', parts.numbers ? parts.numbers.split('\n').filter((line) => line.trim()) : ['- none written yet']],
    ['Decided:', parts.decided],
    ['Bets on record:', parts.open.map(betLine)],
    ['Due on the board:', parts.planned],
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
