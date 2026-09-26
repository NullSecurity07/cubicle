import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LEAD_STAGES, STAGE_NAMES, type LeadStage } from '../../shared/leads.ts';
import { findMetric, formatValue, isDay, type Metrics } from '../../shared/metrics.ts';
import type { Attention, Stage } from '../../shared/model.ts';
import { VERDICT_WORDS, type Bet, type BetVerdict } from '../../shared/partner.ts';
import { localDay } from '../clock.ts';
import { writeAtomic } from '../fsx.ts';
import { leadsFor } from '../leads/store.ts';
import { newId } from '../slice-kit.ts';
import { createSurveys } from '../surveys/store.ts';

// The bets ledger, in `workspace/bets.json`: what the company tried, what it expected to move, and on which day to
// look. A person proposes a bet and the founder takes it or not; on the check day the number is read here, in code,
// from the card it lives on, and the founder (or the partner) says whether it worked.

const MOST = 200;

export function betsBook(workspace: string, now: () => number = Date.now) {
  const path = join(workspace, 'bets.json');
  let queue: Promise<unknown> = Promise.resolve();
  async function list(): Promise<Bet[]> {
    try { const saved = JSON.parse(await readFile(path, 'utf8')) as { bets?: Bet[] }; return Array.isArray(saved.bets) ? saved.bets : []; } catch { return []; }
  }
  function change<T>(edit: (bets: Bet[]) => T): Promise<T> {
    const job = queue.then(async () => {
      const bets = await list();
      const out = edit(bets);
      await writeAtomic(path, JSON.stringify({ bets: bets.slice(-MOST) }, null, 2), { mkdir: true });
      return out;
    });
    queue = job.catch(() => {});
    return job;
  }
  const held = (bets: Bet[], id: string) => { const bet = bets.find((one) => one.id === id); if (!bet) throw new Error('there is no bet by that name'); return bet; };
  return {
    list,
    settled: () => queue,
    propose: (input: Pick<Bet, 'what' | 'hypothesis' | 'metric' | 'target' | 'checkDate'> & { proposedBy?: string; roomId?: string }) => change((bets) => {
      const bet: Bet = { id: newId('bet-'), made: localDay(now()), status: 'proposed', at: now(), ...input };
      bets.push(bet);
      return bet;
    }),
    // The founder's yes makes it a bet on record; a no takes it out of the ledger.
    answer: (id: string, accept: boolean) => change((bets) => {
      const bet = held(bets, id);
      if (bet.status !== 'proposed') throw new Error('this bet is not waiting for an answer');
      if (!accept) { bets.splice(bets.indexOf(bet), 1); return null; }
      bet.status = 'open';
      bet.made = localDay(now());
      return bet;
    }),
    close: (id: string, result: { verdict: BetVerdict; value: number | null; note: string; by: string }) => change((bets) => {
      const bet = held(bets, id);
      if (bet.status !== 'open') throw new Error(bet.status === 'closed' ? 'this bet is already closed' : 'this bet has not been taken yet');
      bet.status = 'closed';
      bet.result = { at: now(), ...result };
      return bet;
    }),
  };
}
export type BetsBook = ReturnType<typeof betsBook>;

// ---------------------------------------------------------------- the number a bet is measured by

// Read in code from where it lives. `value` is null when the card or the number is not on the stage.
export type Reading = { value: number | null; said: string };
const readJson = async <T>(path: string, fallback: T): Promise<T> => { try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return fallback; } };

export async function readMetric(workspace: string, stage: Stage, spec: string): Promise<Reading> {
  const asked = spec.trim().toLowerCase();
  const cards = stage.cards ?? [];
  if (asked === 'leads' || asked.startsWith('leads:')) {
    const wanted = asked.slice('leads:'.length) as LeadStage;
    const leadCards = cards.filter((card) => card.kind === 'leads');
    if (!leadCards.length) return { value: null, said: 'no Leads card is on the stage' };
    if (asked !== 'leads' && !LEAD_STAGES.includes(wanted)) return { value: null, said: `"${spec}" is not a lead stage` };
    let count = 0;
    for (const card of leadCards) count += (await leadsFor(workspace).list(card.id)).filter((lead) => asked === 'leads' || lead.stage === wanted).length;
    return { value: count, said: `${count} ${asked === 'leads' ? 'leads' : `leads in ${STAGE_NAMES[wanted]}`}, read from the Leads card` };
  }
  if (asked === 'survey') {
    const surveyCards = cards.filter((card) => card.kind === 'survey');
    if (!surveyCards.length) return { value: null, said: 'no Survey card is on the stage' };
    let count = 0;
    for (const card of surveyCards) count += (await createSurveys(workspace).list(card.id)).length;
    return { value: count, said: `${count} survey answers, read from the Survey card` };
  }
  for (const card of cards.filter((one) => one.kind === 'metrics')) {
    const data = await readJson<Partial<Metrics>>(join(workspace, 'metrics', `${card.id}.json`), {});
    const metric = findMetric(data.metrics ?? [], spec);
    if (!metric) continue;
    const last = metric.points.at(-1);
    if (!last) return { value: null, said: `${metric.label} has no reading yet` };
    return { value: last.value, said: `${metric.label} is ${formatValue(last.value, metric.unit)} (${last.at}), read from the Metrics card` };
  }
  return { value: null, said: `no number called "${spec}" is on a Metrics card` };
}

// What a bet may be measured by on this stage, for a person who named something else.
export async function metricChoices(workspace: string, stage: Stage): Promise<string[]> {
  const cards = stage.cards ?? [];
  const found: string[] = [];
  for (const card of cards.filter((one) => one.kind === 'metrics')) found.push(...((await readJson<Partial<Metrics>>(join(workspace, 'metrics', `${card.id}.json`), {})).metrics ?? []).map((metric) => metric.key));
  if (cards.some((card) => card.kind === 'leads')) found.push('leads', ...LEAD_STAGES.map((one) => `leads:${one}`));
  if (cards.some((card) => card.kind === 'survey')) found.push('survey');
  return [...new Set(found)];
}

// A bet's check is due from its check day on, while nobody has said how it went.
export const betDue = (bet: Bet, today: string) => bet.status === 'open' && !bet.result && isDay(bet.checkDate) && bet.checkDate <= today;

// What the ledger has waiting for the founder: bets to take or leave, and bets whose day has come, each with the
// number as it stands now.
export async function betsAttention(bets: Bet[], stage: Stage, workspace: string, today: string): Promise<Attention[]> {
  const found: Attention[] = [];
  for (const bet of bets) {
    if (bet.status === 'proposed') {
      found.push({ id: `proposed-bet:${bet.id}`, kind: 'proposed-bet', title: bet.what, at: bet.at, ...(bet.proposedBy ? { who: bet.proposedBy } : {}), ...(bet.roomId ? { roomId: bet.roomId } : {}),
        detail: `${bet.hypothesis ? `${bet.hypothesis}. ` : ''}Measured by ${bet.metric}: ${bet.target} by ${bet.checkDate}.` });
    } else if (betDue(bet, today)) {
      const reading = await readMetric(workspace, stage, bet.metric);
      found.push({ id: `bet-check:${bet.id}`, kind: 'bet-check', title: `Check the bet: ${bet.what}`, at: new Date(`${bet.checkDate}T00:00:00`).getTime(),
        detail: `The target was ${bet.target} by ${bet.checkDate}. Now: ${reading.said}.` });
    }
  }
  return found;
}

export const closedLine = (bet: Bet) => `Closed "${bet.what}": it ${VERDICT_WORDS[bet.result!.verdict]}; ${bet.metric} was ${bet.result!.value ?? 'unread'} against ${bet.target}.`;
