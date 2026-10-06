import type { TurnResult } from '../loop.ts';
import { readCall, renderCall, callShape, type GoalDay, type PartnerCall, type Decision } from './call.ts';
import { changedLine, changedSince, economicsBlock, type Changed, type Economics, type EconomicsState, type Field, type Inputs, type Snapshot } from './economics.ts';
import type { Goal } from './goal.ts';

// A verdict is a call on the numbers as they stood that day. Journey 13's "keep going" was made at 3 paying offices;
// a week on, with a price changed or a fourth office paying, nobody looked at it again unless the founder asked.
// Journey 16: the stored call kept 14 paying and a monthly price after the founder put both right, and the next
// morning's refresh, with no number changed, said "stop, assess winding down" for a cash-positive company. So the call
// keeps only what was decided and the INPUTS it was made on (economics.ts `Snapshot`); any input that changed since (a
// correction, a brief edit, a reading) makes it stale. The partner refreshes it unasked only when it is stale, its
// goal's day passed, or seven days went by; it quotes the old call and the inputs that changed, and works every figure
// from the one state. When it is due is worked out here in code; the model only makes the new call, and a stop or a
// wind-down is not its to reach while the company is cash-positive or has more than six months (holdStop).

export const WEEK = 7;
// What a fake run's partner says when asked to make the call again: the call and the move, the kill signal kept.
export const FAKE_REFRESH = 'My call: keep going\nWhy: the numbers as they stand now, worked out below.\nThis week: ask the subscribers who do not pay yet what would make them pay.';
const DAY = 86_400_000;

export type Held = PartnerCall & { at: number; day: string; roomId: string; snapshot?: Snapshot; basis?: Inputs };

const between = (from: string, to: string) => Math.round((new Date(`${to}T12:00`).getTime() - new Date(`${from}T12:00`).getTime()) / DAY);

// A call kept before the snapshot: its monthly figures, read as a snapshot of month-priced inputs.
const OLD: Record<keyof Inputs, Field> = { price: 'price', cost: 'cost', fixed: 'burn', net: 'net', cash: 'cash', paying: 'paying' };
export const snapshotOfBasis = (basis: Inputs): Snapshot => Object.fromEntries(Object.entries(basis).filter(([, value]) => value !== undefined).map(([key, value]) => [OLD[key as keyof Inputs], { value: value as number, ...(key === 'cash' || key === 'paying' ? {} : { period: 'month' as const }) }]));
// Every input that changed since the call: the call is stale while this has anything in it.
export function staleOf(call: Pick<Held, 'snapshot' | 'basis'> | undefined, state: EconomicsState | null | undefined): Changed[] {
  if (!call || !state) return [];
  const then = call.snapshot ?? (call.basis ? snapshotOfBasis(call.basis) : null);
  if (!then) return [];
  // A month-priced old basis against a state that gives no period is the same figure.
  return changedSince(then, state).filter((one) => !(one.from && one.to && Math.abs(one.from.value - one.to.value) < 1e-9 && !call.snapshot && (one.to.period ?? 'month') === 'month'));
}

export type Why = 'moved' | 'goal' | 'week';
// `goal`: the Company brief's dated goal (server/partner/goal.ts), due a look once its day passed after the call.
export type Due = { why: Why; changed: Changed[]; goal?: Goal };
// Whether the call is due a fresh look today, and why: it is stale, the goal's day passed, or a week went by.
export function refreshDue(call: Held | undefined, state: EconomicsState | null | undefined, today: string, on: { goal?: Goal } = {}): Due | null {
  if (!call?.decision) return null;
  const changed = staleOf(call, state);
  if (changed.length) return { why: 'moved', changed };
  if (on.goal && on.goal.by < today && call.day <= on.goal.by) return { why: 'goal', changed: [], goal: on.goal };
  return between(call.day, today) >= WEEK ? { why: 'week', changed: [] } : null;
}

const shortDay = (day: string) => new Date(`${day}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// "On 6 Oct I said keep going at 14 paying subscribers; now break-even is 8 paying subscribers and the company has 11,
// cash-positive. Since then: paying subscribers 14 → 11 (founder: "…")."
export function refreshOpening(call: Held, state: EconomicsState | null | undefined, changed: Changed[]): string {
  const unit = state?.unit ?? 'paying customers';
  const was = call.snapshot?.paying?.value ?? call.basis?.paying;
  const then = was !== undefined ? ` at ${was} ${unit}` : '';
  const even = state?.breakEven();
  const evenLine = even === undefined ? '' : Number.isFinite(even) ? `break-even is ${even} ${unit}` : 'each one loses money, so no count breaks even';
  const have = state?.current() !== undefined ? `the company has ${state!.current()}` : '';
  const cash = state?.cashPositive() ? 'cash-positive' : '';
  const nowLine = [[evenLine, have].filter(Boolean).join(' and '), cash].filter(Boolean).join(', ');
  return `On ${shortDay(call.day)} I said ${call.decision}${then}${nowLine ? `; now ${nowLine}` : ''}.${changed.length ? ` Since then: ${changed.map((one) => changedLine(one, state?.currency ?? '')).join('; ')}.` : ''}`;
}

// What the partner is asked to answer, with the old call and the working now in front of it.
const WHY_SAID = (due: Pick<Due, 'why' | 'goal'>) => (due.why === 'moved' ? 'The numbers behind your verdict changed since you made it.'
  : due.why === 'goal' ? `The Company brief's goal, ${due.goal!.what} by ${due.goal!.said} (${due.goal!.by}), has passed its day.`
    : 'A week has passed since your verdict.');
export function refreshAsk(call: Held, opening: string, economics: Economics | null, today: string, why: Why | Pick<Due, 'why' | 'goal'>): string {
  const due = typeof why === 'string' ? { why } : why;
  const { working: _working, ...said } = call;
  return `${WHY_SAID(due)} Make the call again, unasked, on the numbers as they stand now: the working below, never a figure from your verdict then.${due.why === 'goal' ? ' Never move the goal\'s day yourself: if it should move, say so and why, and the founder decides.' : ''}\n`
    + `Your verdict then:\n${renderCall(said)}\n\n${opening}\n\n${callShape(today, !!economics, 'goal' in due && due.goal ? [due.goal] : [])}${economics ? `\n\n${economicsBlock(economics)}` : ''}`;
}

// The refresh as the founder reads it: the old call quoted and what changed, "still" or "now" the call, then the four lines.
export function refreshText(opening: string, old: Decision | undefined, fresh: PartnerCall): string {
  const [first, changes] = opening.split(/(?<=\.) (?=Since then:)/);
  const head = fresh.decision ? `${first.replace(/\.$/, '')}: ${fresh.decision === old ? 'still' : 'now'} ${fresh.decision}.${changes ? ` ${changes}` : ''}` : opening;
  return `${head}\n\n${renderCall(fresh)}`;
}

// The new call read from the reply, held to the same four lines as an asked verdict; null when it has no call at all.
// A kill signal that could not fail from where the company stands (deadSignal) is not taken: the one standing stays.
export function readRefresh(reply: Pick<TurnResult, 'text'>, today: string, evidence: string, economics: Economics | null, numbers = '', goals: GoalDay[] = []): PartnerCall | null {
  const read = readCall(reply.text, today, `${evidence}\n${(economics?.working ?? []).map((one) => one.line).join('\n')}`, economics, numbers, goals);
  if (!read.decision) return null;
  return {
    decision: read.decision, ...(read.why && !read.unsourced.length ? { why: read.why } : {}), ...(read.signal ? { signal: read.signal } : {}), ...(read.move ? { move: read.move } : {}),
    ...(read.closes ? { gap: read.closes } : {}), ...(economics?.working.length ? { working: economics.working.map((one) => one.line) } : {}),
  };
}

// ---------------------------------------------------------------- no stop for a company that is not running out

// Journey 16: "Pause operations and plan an orderly wind-down" at 11 paying against a break-even of 8, cash-positive.
// A stop, or a move to wind down, is not the partner's to reach while the company is cash-positive or has more than
// six months of runway, unless the founder's own words asked for it: the call stays (or becomes "change course") and
// the line says why.
export const SAFE_MONTHS = 6;
const WIND_DOWN = /\bwind(?:ing)?[- ]?(?:it\s+)?down\b|\bshut(?:ting)?\s+(?:it\s+|the company\s+|operations\s+)?down\b|\bpause\s+(?:all\s+)?operations\b|\bclose\s+(?:down\s+)?(?:the\s+)?(?:company|business)\b|\bstop\s+operations\b|\bcease\b/i;
export const windsDown = (text: string) => WIND_DOWN.test(text);
export const asksToStop = (said: string) => /\b(?:i|we)\s+(?:really\s+)?(?:want|have decided|decided|need|am going|are going|'m going|'re going)\s+to\s+(?:stop|quit|wind (?:it )?down|shut (?:it )?down|close (?:it|the company))\b|\blet'?s\s+(?:stop|quit|wind (?:it )?down|shut (?:it )?down)\b|\b(?:i'm|i am|we're|we are)\s+(?:thinking (?:of|about)|considering)\s+(?:stopping|quitting|winding (?:it )?down|shutting (?:it )?down|closing)\b/i.test(said);
export function holdStop(call: PartnerCall, state: EconomicsState | null | undefined, founder: string[], held?: Decision): { call: PartnerCall; note?: string } {
  const runway = state?.runway();
  if (!runway || (Number.isFinite(runway.value) && runway.value <= SAFE_MONTHS) || founder.some(asksToStop)) return { call };
  const stops = call.decision === 'stop';
  const winds = !!call.move && windsDown(call.move);
  if (!stops && !winds) return { call };
  const decision: Decision | undefined = stops ? (held && held !== 'stop' ? held : 'change course') : call.decision;
  const { move: _move, ...rest } = call;
  const next: PartnerCall = { ...(winds ? rest : call), ...(decision ? { decision } : {}) };
  const money = (value: number) => `${state!.currency ?? ''}${(Math.round(value * 100) / 100).toLocaleString('en-US')}`;
  const why = !Number.isFinite(runway.value)
    ? `the company is cash-positive (${money(state!.mrr() ?? 0)} a month comes in against ${money(state!.monthly('burn') ?? 0)} of burn)`
    : `runway is ${runway.display} months`;
  return { call: next, note: `*Not a stop: ${why}, so stopping or winding down is yours to raise, not mine.${winds ? ` The move "${call.move!.replace(/[\s.]+$/, '')}" was dropped.` : ''}*` };
}

const STEMS = (text: string) => text.toLowerCase().replace(/\d+/g, ' ').split(/[^a-z]+/).filter((word) => word.length > 3).map((word) => word.replace(/s$/, ''));
// The line of what changed since yesterday that slips on the goal: a promise slipped, a number moved the wrong way or
// a check overdue, about what the goal counts.
export function slipOn(goal: Goal | undefined, since: string[]): string | undefined {
  if (!goal) return undefined;
  const words = STEMS(goal.what);
  return since.find((line) => /^(?:Slipped:|Kill-signal check overdue:)|\(worse\)\.?$/.test(line) && STEMS(line).some((word) => words.includes(word)));
}
