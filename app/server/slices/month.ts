import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STAGE_NAMES, type Lead, type LeadStage } from '../../shared/leads.ts';
import { formatChange, formatPct, formatValue, isDay, northStarOf, type Metric, type Metrics } from '../../shared/metrics.ts';
import type { Card, Decision, Stage, Task } from '../../shared/model.ts';
import { cleanRunway, money, monthOf, months, project, type RunwayFile } from '../../shared/runway.ts';
import type { Deps, Slice } from '../install.ts';
import { readBook, type Move } from '../leads/moves.ts';
import { leadsFor } from '../leads/store.ts';
import { localDay, now as clockNow } from '../clock.ts';
import { wired } from '../prompt.ts';
import { offerWhenWired } from '../slice-kit.ts';
import type { Tool } from '../tools/registry.ts';

// The monthly investor update: a built-in skill (`app/skills/monthly-update.json`), a board task that repeats on the
// first weekday of every month, and one tool, gather_month, that reads what changed since a day out of the stores
// themselves. Every number it returns names the card it came from, and it reads only the cards wired to the person
// asking (decisions are the whole company's, and every person already reads them). No model works anything out here.

export const SKILL_ID = 'monthly-update';
export const MONTH_TOOLS = ['gather_month'];
const KINDS: Card['kind'][] = ['board', 'leads', 'metrics', 'runway'];
const MOST = 12;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The month a run on this moment reports: the one before it. A run on 1 October drafts the September update.
export const reportedMonth = (at: number) => { const day = new Date(at); return MONTH_NAMES[(day.getMonth() + 11) % 12]; };
export const updateTitle = (at: number) => `Draft the ${reportedMonth(at)} update`;
const TITLE = /^Draft the (January|February|March|April|May|June|July|August|September|October|November|December) update$/;
export const TEMPLATE_DETAIL = 'Use the monthly-update skill: call gather_month from the first day of the month being reported, write the update as a doc with create_doc, cite the card beside every number, and do not send it. The founder edits and sends it.';
// The first day of last month, which is what "since" means when it is left out.
export const lastMonthStart = (now: number) => { const day = new Date(now); return localDay(new Date(day.getFullYear(), day.getMonth() - 1, 1).getTime()); };
const startOf = (day: string) => new Date(`${day}T00:00:00`).getTime();

// What gather_month reads, handed in so a test can seed a workspace and read the same lines back.
export type MonthSources = {
  workspace: string; stage: Stage; roomId: string;
  decisions: () => Promise<Decision[]>; boards: (boardId: string) => Promise<Task[]>; leads: (cardId: string) => Promise<Lead[]>;
  now: number;
};

const readJson = async <T>(path: string, fallback: T): Promise<T> => { try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return fallback; } };
const some = (lines: string[]) => (lines.length > MOST ? [...lines.slice(0, MOST), `- …and ${lines.length - MOST} more`] : lines);

// How each card is cited: its kind, and its title or id when there is more than one of that kind wired.
function citer(cards: Card[]) {
  return (card: Card) => {
    const kind = { board: 'Board', leads: 'Leads', metrics: 'Metrics', runway: 'Runway' }[card.kind as 'board'] ?? card.kind;
    const named = card.kind === 'metrics' && card.title ? `${kind} "${card.title}"` : kind;
    return cards.filter((one) => one.kind === card.kind).length > 1 && named === kind ? `[${kind} ${card.id}]` : `[${named}]`;
  };
}

// One number's month: where it stood going in, where it is now, and the change, all read off its own readings.
export function metricLine(metric: Metric, since: string): string | null {
  const before = metric.points.filter((point) => point.at < since).at(-1);
  const inside = metric.points.filter((point) => point.at >= since);
  const last = inside.at(-1);
  const star = metric.northStar ? ' (north star)' : '';
  if (!last) return before ? `${metric.label}${star}: no reading since ${since}; the last was ${formatValue(before.value, metric.unit)} on ${before.at}` : null;
  if (!before) return `${metric.label}${star}: ${formatValue(last.value, metric.unit)} on ${last.at}, first reading ${formatValue(inside[0].value, metric.unit)} on ${inside[0].at}`;
  const change = Math.round((last.value - before.value) * 100) / 100;
  const pct = before.value === 0 ? '' : ` (${formatPct(Math.round((change / Math.abs(before.value)) * 100))})`;
  return `${metric.label}${star}: ${formatValue(last.value, metric.unit)} on ${last.at}, from ${formatValue(before.value, metric.unit)} on ${before.at}: ${formatChange(change, metric.unit)}${pct}`;
}

export async function gatherMonth(from: MonthSources, since: string): Promise<string> {
  const today = localDay(from.now);
  const after = startOf(since);
  const cards = (from.stage.cards ?? []).filter((card) => KINDS.includes(card.kind));
  const mine = new Set(wired(from.stage, from.roomId, cards.map((card) => card.id)));
  const mineCards = cards.filter((card) => mine.has(card.id));
  const cite = citer(mineCards);
  const out: string[] = [`What changed from ${since} to ${today}. Each line names the card it came from in brackets. Use only these numbers; anything not here is not tracked.`];

  const decided = (await from.decisions().catch(() => [])).filter((one) => one.status === 'decided' && (one.decidedAt ?? one.at) >= after);
  out.push('Decisions decided [Decisions]:', ...(decided.length ? some(decided.map((one) => `- ${localDay(one.decidedAt ?? one.at)} ${one.title}${one.chosen ? `: ${one.chosen.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`)) : ['- none']));

  const nameOf = (roomId?: string) => from.stage.rooms.find((room) => room.id === roomId)?.name;
  for (const card of mineCards.filter((one) => one.kind === 'board')) {
    // A run's end is dated. A task moved to Done by hand is not, so it counts when it was also made in the window.
    const done = (await from.boards(card.id).catch(() => [])).flatMap((task) => {
      const at = task.run?.state === 'done' ? task.run.finishedAt : task.column === 'done' && !task.run ? task.createdAt : undefined;
      return at && at >= after ? [{ at, line: `- ${localDay(at)} ${task.title}${nameOf(task.assignee) ? `, by ${nameOf(task.assignee)}` : ''}` }] : [];
    }).sort((a, b) => a.at - b.at);
    out.push(`Tasks done ${cite(card)}:`, ...(done.length ? some(done.map((one) => one.line)) : ['- none']));
  }

  const moves = (await readBook(from.workspace)).moves;
  for (const card of mineCards.filter((one) => one.kind === 'leads')) {
    const leads = await from.leads(card.id).catch(() => [] as Lead[]);
    const added = leads.filter((lead) => lead.addedAt >= after).length;
    const moved = moves.filter((move: Move) => move.cardId === card.id && move.at >= after);
    const counts = (Object.keys(STAGE_NAMES) as LeadStage[]).map((stage) => [stage, leads.filter((lead) => lead.stage === stage).length] as const).filter(([, count]) => count);
    out.push(`Leads ${cite(card)}: ${added} added, ${moved.length} stage move${moved.length === 1 ? '' : 's'}. Now: ${counts.length ? counts.map(([stage, count]) => `${count} ${STAGE_NAMES[stage]}`).join(', ') : 'empty'}.`,
      ...some(moved.map((move) => `- ${localDay(move.at)} ${move.name}: ${STAGE_NAMES[move.from]} to ${STAGE_NAMES[move.to]}`)));
  }

  for (const card of mineCards.filter((one) => one.kind === 'metrics')) {
    const data = await readJson<Partial<Metrics>>(join(from.workspace, 'metrics', `${card.id}.json`), {});
    const all = data.metrics ?? [];
    const star = northStarOf(all);
    const ordered = star ? [star, ...all.filter((one) => one !== star)] : all;
    const lines = ordered.flatMap((metric) => { const line = metricLine(metric, since); return line ? [`- ${line}`] : []; });
    out.push(`Numbers ${cite(card)}:`, ...(lines.length ? lines : ['- no readings']));
  }

  for (const card of mineCards.filter((one) => one.kind === 'runway')) {
    const saved = await readJson<RunwayFile | null>(join(from.workspace, 'runway', `${card.id}.json`), null);
    const currency = card.kind === 'runway' ? card.currency ?? 'USD' : 'USD';
    if (!saved) { out.push(`Runway ${cite(card)}: empty.`); continue; }
    const runway = cleanRunway(saved, today);
    const base = project(runway, undefined, today);
    const left = base.zero && base.monthsLeft !== null ? `${months(base.monthsLeft)} left, cash out ${monthOf(base.zero)}` : 'cash does not run out on this plan';
    out.push(`Runway ${cite(card)}: cash ${money(runway.cash.amount, currency)} on ${runway.cash.asOf}; burn ${money(base.burn, currency)} a month${base.revenue ? `, revenue ${money(base.revenue, currency)} a month` : ''}; ${left}.`);
  }

  const missing = (['metrics', 'runway', 'leads', 'board'] as const).filter((kind) => !mineCards.some((card) => card.kind === kind));
  if (missing.length) out.push(`Not wired to you: ${missing.map((kind) => ({ metrics: 'Metrics', runway: 'Runway', leads: 'Leads', board: 'Board' })[kind]).join(', ')}. Say so in the update rather than guessing.`);
  return out.join('\n');
}

export function monthTools(deps: Pick<Deps, 'workspace' | 'decisions' | 'boards'>, leads: (cardId: string) => Promise<Lead[]>, now: () => number = clockNow): Tool[] {
  return [{
    name: 'gather_month', perTurn: 2,
    description: 'Read what changed since a day, for the monthly update: decisions decided, board tasks done, lead moves, numbers with their change, runway left. Each line names its card. Use only these numbers.',
    parameters: { type: 'object', properties: { since: { type: 'string', description: 'YYYY-MM-DD, the first day of the month being reported. Left out: the first day of last month.' } } },
    async run(args, context) {
      const asked = typeof args.since === 'string' ? args.since.trim() : '';
      if (asked && !isDay(asked)) throw new Error('"since" is a day, written YYYY-MM-DD');
      const at = now();
      const since = asked || lastMonthStart(at);
      if (since > localDay(at)) throw new Error(`"since" is after today (${localDay(at)})`);
      return { text: await gatherMonth({ workspace: deps.workspace, stage: context.stage, roomId: context.roomId, decisions: () => deps.decisions.list(), boards: (id) => deps.boards.list(id), leads, now: at }, since) };
    },
  }];
}

// A board task on the first weekday of every month, given to the first person wired to the board.
export async function addMonthlyUpdate(deps: Pick<Deps, 'boards' | 'store'>, boardId?: string, now = clockNow()) {
  const stage = await deps.store.loadStage();
  const boards = (stage.cards ?? []).filter((card) => card.kind === 'board');
  const board = boardId ? boards.find((card) => card.id === boardId) : boards[0];
  if (!board) throw new Error('Add a task board first, then ask for the monthly update again.');
  const held = (await deps.boards.list(board.id)).find((task) => task.skill === SKILL_ID && task.repeat?.every === 'month');
  if (held) return { boardId: board.id, task: held, added: false };
  const person = wired(stage, board.id, stage.rooms.map((room) => room.id))[0];
  const task = await deps.boards.add(board.id, { title: 'Draft the monthly update', detail: TEMPLATE_DETAIL });
  const changed = await deps.boards.change(board.id, task.id, { repeat: { every: 'month', time: '09:00' }, skill: SKILL_ID, ...(person ? { assignee: person } : {}) });
  const titled = await deps.boards.change(board.id, task.id, { title: updateTitle(changed.nextRun ?? now) });
  return { boardId: board.id, task: titled, added: true };
}

export default {
  name: 'month',
  install(deps) {
    // The Leads card's own store, read when asked (never while installing, so the card's slice made it first).
    const leads = (cardId: string) => leadsFor(deps.workspace).list(cardId);
    const holds = (stage: Stage, roomId: string) => wired(stage, roomId, (stage.cards ?? []).filter((card) => KINDS.includes(card.kind)).map((card) => card.id)).length > 0;
    return {
      tools: monthTools(deps, leads),
      // Offered to a person wired to any card it reads; decisions alone are not worth a tool.
      offer: offerWhenWired(holds, MONTH_TOOLS),
      // A monthly task's title names the month it will report, once that run is a week away. A title the founder
      // wrote themselves is left alone.
      async tick() {
        const stage = await deps.store.loadStage();
        const now = clockNow();
        for (const card of (stage.cards ?? []).filter((one) => one.kind === 'board')) {
          for (const task of await deps.boards.list(card.id)) {
            if (task.skill !== SKILL_ID || task.repeat?.every !== 'month' || !task.nextRun || !TITLE.test(task.title)) continue;
            if (task.run?.state === 'running' || task.run?.state === 'waiting' || task.nextRun - now > 7 * 86_400_000) continue;
            const title = updateTitle(task.nextRun);
            if (title !== task.title) await deps.boards.change(card.id, task.id, { title });
          }
        }
      },
      async route(req, res, path) {
        if (path !== '/api/month/template' || req.method !== 'POST') return false;
        try {
          const sent = await deps.body(req);
          const made = await addMonthlyUpdate(deps, typeof sent?.boardId === 'string' ? sent.boardId : undefined);
          deps.json(res, 200, made);
        } catch (error) { deps.json(res, 400, { error: (error as Error).message }); }
        return true;
      },
    };
  },
} satisfies Slice;
