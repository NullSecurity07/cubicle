import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LEAD_STAGES, STAGE_NAMES, type LeadStage } from '../../shared/leads.ts';
import { findMetric, formatValue, guessBetter, isDay, keyOf, UNITS, type Metrics, type Unit } from '../../shared/metrics.ts';
import type { Attention, Stage } from '../../shared/model.ts';
import { bare, VERDICT_WORDS, type Bet, type BetVerdict } from '../../shared/partner.ts';
import { localDay, now as clockNow } from '../clock.ts';
import { writeAtomic } from '../fsx.ts';
import { readBook } from '../rescue.ts';
import { leadsFor } from '../leads/store.ts';
import { newId } from '../slice-kit.ts';
import { createSurveys } from '../surveys/store.ts';
import { BUILDS, isWeak, verdictName, type TeamVerdict } from './pushback.ts';

// The bets ledger, in `workspace/bets.json`: what the company tried, what it expected to move, and on which day to
// look. A person proposes a bet and the founder takes it or not; on the check day the number is read here, in code,
// from the card it lives on, and the founder (or the partner) says whether it worked.

const MOST = 200;

export function betsBook(workspace: string, now: () => number = clockNow) {
  const path = join(workspace, 'bets.json');
  let queue: Promise<unknown> = Promise.resolve();
  async function list(): Promise<Bet[]> {
    const saved = await readBook<{ bets?: Bet[] }>(path, workspace, { empty: { bets: [] }, what: { thing: 'The bets file', again: 'your bets started again', first: 'your bets start empty' } });
    return Array.isArray(saved?.bets) ? saved.bets : [];
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
    propose: (input: Pick<Bet, 'what' | 'hypothesis' | 'metric' | 'target' | 'checkDate'> & { proposedBy?: string; roomId?: string; brief?: Bet['brief'] }) => change((bets) => {
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

// Read in code from where it lives. `value` is null when the card or the number is not on the stage. `better` is
// which way that number should move: a count of leads or answers goes up, a Metrics row says for itself.
export type Reading = { value: number | null; said: string; better?: 'up' | 'down' };
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
    return { value: count, said: `${count} ${asked === 'leads' ? 'leads' : `leads in ${STAGE_NAMES[wanted]}`}, read from the Leads card`, better: 'up' };
  }
  if (asked === 'survey') {
    const surveyCards = cards.filter((card) => card.kind === 'survey');
    if (!surveyCards.length) return { value: null, said: 'no Survey card is on the stage' };
    let count = 0;
    for (const card of surveyCards) count += (await createSurveys(workspace).list(card.id)).length;
    return { value: count, said: `${count} survey answers, read from the Survey card`, better: 'up' };
  }
  for (const card of cards.filter((one) => one.kind === 'metrics')) {
    const data = await readJson<Partial<Metrics>>(join(workspace, 'metrics', `${card.id}.json`), {});
    const metric = findMetric(data.metrics ?? [], spec);
    if (!metric) continue;
    const last = metric.points.at(-1);
    if (!last) return { value: null, said: `${metric.label} has no reading yet` };
    return { value: last.value, said: `${metric.label} is ${formatValue(last.value, metric.unit)} (${last.at}), read from the Metrics card`, better: metric.better };
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

// What the founder has to add before a bet can be measured by `metric`, in words the person passes on as they are:
// which card, and which row on it. The choices already on the stage come after, when there are any.
export function missingMetric(stage: Stage, metric: string, choices: string[]): string {
  const asked = metric.trim().toLowerCase();
  const has = (kind: string) => (stage.cards ?? []).some((card) => card.kind === kind);
  const need = asked === 'leads' || asked.startsWith('leads:') ? (has('leads') ? `"${metric}" is not a lead stage on the Leads card` : `there is no Leads card to count "${metric}" on. Ask the founder to add a Leads card from the dock`)
    : asked === 'survey' ? 'there is no Survey card to count answers on. Ask the founder to add a Survey card from the dock'
    : has('metrics') ? `the Metrics card has no "${metric}" row. Ask the founder to add one: paste a CSV with a date,${asked.replace(/[^a-z0-9_]+/g, '_')} header onto the Metrics card`
    : `there is no Metrics card with a "${metric}" row. Ask the founder to add a Metrics card and paste a CSV with a date,${asked.replace(/[^a-z0-9_]+/g, '_')} header onto it`;
  return `${need}.${choices.length ? ` Or measure it by one of what is already there: ${choices.join(', ')}.` : ''} Tell the founder exactly which card and row to add.`;
}

// ---------------------------------------------------------------- a number only the brief holds

// Journey 9: a bet on paying users failed with "no Metrics card", while the Company brief held "Paying users: 2", and
// the founder had to add a card, paste a CSV and drag a wire. The brief's Numbers row the metric names, when exactly
// one row fits it: "paying users", "paying_users" and "paying" all find "Paying users"; "users" alone, beside "Beta
// users", finds none.
export type BriefRow = { label: string; value: number; unit?: Unit };
const stems = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((word) => word.replace(/s$/, ''));
export function briefRow(numbers: string, metric: string): BriefRow | null {
  const asked = stems(metric);
  if (!asked.length) return null;
  const rows = numbers.split('\n').flatMap((line): BriefRow[] => {
    const found = /^\s*[-*]\s+([^:]{1,40}):\s*([$€£])?\s?(\d[\d,]*(?:\.\d+)?)(\s?%)?/.exec(line);
    if (!found) return [];
    const label = found[1].trim();
    const words = stems(label);
    if (!asked.every((word) => words.includes(word)) && !words.every((word) => asked.includes(word))) return [];
    const unit = (found[2] ?? (found[4] ? '%' : '')) as Unit;
    return [{ label, value: Number(found[3].replace(/,/g, '')), ...(unit && UNITS.includes(unit) ? { unit } : {}) }];
  });
  return rows.length === 1 ? rows[0] : null;
}
export const briefReading = (row: BriefRow): Reading => ({ value: row.value, said: `${row.label} is ${formatValue(row.value, row.unit)}, read from the Company brief`, better: guessBetter(row.label) });
// The Metrics card a taken bet adds: one row, today's reading from the brief, and the bet's own number and day as
// the row's target, so the card shows the aim the founder just took instead of asking for one (journey 13).
export const briefMetrics = (row: BriefRow, today: string, at: number, target?: { value: number; by: string }): Metrics => ({ updatedAt: at, metrics: [{
  key: keyOf(row.label), label: row.label, better: guessBetter(row.label), ...(row.unit ? { unit: row.unit } : {}), points: [{ at: today, value: row.value, from: 'the Company brief' }],
  ...(target ? { target } : {}),
}] });
export const BRIEF_CARD = 'Add a Metrics card from the brief and take the bet';

// ---------------------------------------------------------------- the metric an ask names

// What a founder's ask counts, as the metric that measures it: "50 newsletter signups by Oct 10" is the "signups"
// row on a Metrics card, never "leads". A number with a plural noun after it, up to two words on ("20 paying
// customers"); a sum of money, a percentage or a length of time names no metric.
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const TENS: Record<string, number> = { thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
const NUMBER = `\\d[\\d,]*(?:\\.\\d+)?\\s*k?|${[...WORDS, ...Object.keys(TENS)].join('|')}`;
// "50 newsletter signups", "fifty signups": a number, up to two words, a plural noun. "signups: 50": the noun first.
const COUNTED = new RegExp(`(?<![$€£\\d.,])\\b(${NUMBER})\\s+(?:[a-z][a-z'-]*\\s+){0,2}?([a-z][a-z-]*s)\\b|\\b([a-z][a-z-]*s)\\s*:\\s*(\\d[\\d,]*)\\b`, 'gi');
const NOT_COUNTS = new Set(['minutes', 'hours', 'days', 'weeks', 'months', 'years', 'times', 'percents', 'dollars', 'euros', 'pounds', 'steps', 'things', 'ways', 'others']);
const FROM_CARDS: Record<string, string> = { leads: 'leads', replies: 'leads:replied', meetings: 'leads:meeting', answers: 'survey', responses: 'survey' };
const valueOf = (said: string) => {
  const word = said.trim().toLowerCase();
  if (WORDS.includes(word)) return WORDS.indexOf(word);
  if (TENS[word]) return TENS[word];
  return Number(word.replace(/[,\s]/g, '').replace(/k$/, '')) * (/k$/.test(word) ? 1000 : 1);
};
// Every number the ask counts, in the order said, each as the metric that would measure it.
export function metricsAsked(ask: string): { metric: string; value: number }[] {
  return [...ask.matchAll(COUNTED)].flatMap((found) => {
    const noun = (found[2] ?? found[3]).toLowerCase();
    return NOT_COUNTS.has(noun) ? [] : [{ metric: FROM_CARDS[noun] ?? noun, value: valueOf(found[1] ?? found[4]) }];
  });
}
// The one the bet is about: the noun whose number is the target, else the first counted.
export function metricAsked(ask: string, target?: number): string | undefined {
  const all = metricsAsked(ask);
  return (all.find((one) => one.value === target) ?? all[0])?.metric;
}
// Which card a metric is read from.
const familyOf = (metric: string) => { const said = metric.trim().toLowerCase(); return said === 'leads' || said.startsWith('leads:') ? 'leads' : said === 'survey' ? 'survey' : 'metrics'; };
export const CARD_NAMES = { leads: 'the Leads card', survey: 'the Survey card', metrics: 'the Metrics card' } as const;
export const cardOf = (metric: string) => CARD_NAMES[familyOf(metric)];
// Whether a pick measures what the ask counts: "Signups", "signup" and "newsletter_signups" all measure signups.
export function metricFits(pick: string, asked: string): boolean {
  const said = pick.trim().toLowerCase();
  if (familyOf(asked) !== 'metrics') return said === asked;
  const stem = (word: string) => word.replace(/s$/, '');
  return familyOf(said) === 'metrics' && said.split(/[^a-z0-9]+/).some((word) => word && stem(word) === stem(asked));
}
// A pick is held to the ask when it is read off another card than the ask's number, or off none at all. A Metrics
// row the founder already keeps under another name ("subs" for signups) stands.
export async function askedInstead(workspace: string, stage: Stage, pick: string, ask: string, target?: number): Promise<string | null> {
  const all = metricsAsked(ask);
  const named = all.find((one) => one.value === target);
  const asked = (named ?? all[0])?.metric;
  // With no count at the target, a pick that fits any count the ask names stands.
  if (!asked || metricFits(pick, asked) || (!named && all.some((one) => metricFits(pick, one.metric)))) return null;
  if (familyOf(pick) === familyOf(asked) && (await readMetric(workspace, stage, pick)).value !== null) return null;
  const there = (await readMetric(workspace, stage, asked)).value !== null;
  const missing = there ? '' : ` ${missingMetric(stage, asked, [])}`.replace(/^ (\w)/, (_, first: string) => ` ${first.toUpperCase()}`);
  return `The founder's ask counts ${asked.replace(/^leads:/, 'leads in ')}: propose it again measured by "${asked}".${missing}`;
}

// A bet has to be able to lose: its target beats the number as it stands, up for most numbers and down for one that
// is better lower (churn, burn, cost). Null when it does; else what to tell the person, with the number read now.
// A hold is about this number: keep, hold, retain or maintain in the same clause as the number or the metric's name
// ("keep our 3 paying users"), never "make the bet, keep it simple".
function holds(ask: string, metric: string, target: number): boolean {
  const words = metric.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2).map((word) => word.replace(/s$/, ''));
  return ask.toLowerCase().split(/[,;.!?]|\band\b|\bbut\b/).some((clause) => /\b(?:keep|hold|retain|maintain)\b/.test(clause)
    && (new RegExp(`(?<![\\d.])${target}(?![\\d.])`).test(clause) || words.some((word) => new RegExp(`\\b${word}`).test(clause))));
}

// A row that does not say which way is better is read by its name, as the Metrics card guesses it. A hold ("keep our 3
// paying users") can lose too, through churn, so an equal target stands when the ask says keep, hold or retain.
export function cannotLose(metric: string, target: number, reading: Reading, ask = ''): string | null {
  if (reading.value === null) return null;
  const lower = (reading.better ?? guessBetter(metric)) === 'down';
  if (lower ? target < reading.value : target > reading.value) return null;
  if (target === reading.value && holds(ask, metric, target)) return null;
  const where = /read from (the \w+ (?:card|brief))/.exec(reading.said)?.[1] ?? 'its card';
  const way = lower ? `${metric.charAt(0).toUpperCase()}${metric.slice(1)} is better lower: propose a target below ${reading.value}` : `Propose a target above ${reading.value}`;
  return `"${metric}" is ${reading.value} now, read from ${where}: a target of ${target} cannot lose. ${way}, one this bet could miss, and tell the founder the number it starts from.`;
}

// A bet's check is due from its check day on, while nobody has said how it went.
export const betDue = (bet: Bet, today: string) => bet.status === 'open' && !bet.result && isDay(bet.checkDate) && bet.checkDate <= today;

// What the ledger has waiting for the founder: bets to take or leave, and bets whose day has come, each with the
// number as it stands now.
// A proposed bet that builds the thing a weak team verdict pauses says so in its row, with the verdict quoted, so the
// founder takes it knowing.
export async function betsAttention(bets: Bet[], stage: Stage, workspace: string, today: string, verdict?: TeamVerdict | null): Promise<Attention[]> {
  const found: Attention[] = [];
  for (const bet of bets) {
    if (bet.status === 'proposed') {
      const against = verdict && isWeak(verdict) && BUILDS.test(`${bet.what} ${bet.hypothesis}`) ? ` The team's verdict is ${verdictName(verdict)}: this bet builds before it.` : '';
      // Only the brief holds its number: taking it adds the card, so the founder adds nothing by hand.
      const partner = stage.rooms.find((room) => room.partner)?.name ?? 'your partner';
      const brief = bet.brief && (await readMetric(workspace, stage, bet.metric)).value === null
        ? ` ${BRIEF_CARD}: taking it adds a Metrics card with ${bet.brief.label} at ${formatValue(bet.brief.value, bet.brief.unit as Unit | undefined)}, wired to ${partner}.` : '';
      found.push({ id: `proposed-bet:${bet.id}`, kind: 'proposed-bet', title: bet.what, at: bet.at, ...(bet.proposedBy ? { who: bet.proposedBy } : {}), ...(bet.roomId ? { roomId: bet.roomId } : {}),
        detail: `${bare(bet.hypothesis) ? `${bare(bet.hypothesis)}. ` : ''}Measured by "${bet.metric}" on ${cardOf(bet.metric)}: ${bet.target} by ${bet.checkDate}.${brief}${against}` });
    } else if (betDue(bet, today)) {
      const reading = await readMetric(workspace, stage, bet.metric);
      found.push({ id: `bet-check:${bet.id}`, kind: 'bet-check', title: `Check the bet: ${bet.what}`, at: new Date(`${bet.checkDate}T00:00:00`).getTime(),
        detail: `The target was ${bet.target} by ${bet.checkDate}. Now: ${reading.said}.` });
    }
  }
  return found;
}

// What the partner posts in their own room on a bet's check day, with the number as it was read in code.
export const checkLine = (bet: Bet, reading: Reading) => `**Check the bet:** ${bare(bet.what)}. The target was ${bet.target} by ${bet.checkDate}; now ${reading.said}. Did it work? Say so here, or in Needs you.`;

export const closedLine = (bet: Bet) => `Closed "${bet.what}": it ${VERDICT_WORDS[bet.result!.verdict]}; ${bet.metric} was ${bet.result!.value ?? 'unread'} against ${bet.target}.`;
