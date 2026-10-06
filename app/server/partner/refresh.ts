import type { TurnResult } from '../loop.ts';
import { readCall, renderCall, callShape, type PartnerCall, type Decision } from './call.ts';
import { economicsBlock, type Economics, type Inputs } from './economics.ts';

// A verdict is a call on the numbers as they stood that day. Journey 13's "keep going" was made at 3 paying offices;
// a week on, with a price changed or a fourth office paying, nobody looked at it again unless the founder asked. The
// partner refreshes its own call, unasked: when the Company brief's economics (price, cost per unit, fixed costs, cash,
// net burn, the paying count) moved more than a tenth from where they stood at the call, or seven days passed. It
// quotes the old call and what changed, makes the call again on the numbers now, and moves the kill signal when the
// new call names another one. When it is due is worked out here in code; the model only makes the new call.

export const MOVE = 0.1;
export const WEEK = 7;
const DAY = 86_400_000;
const LABELS: Record<keyof Inputs, string> = { price: 'price', cost: 'cost per unit', fixed: 'fixed costs', net: 'net burn', cash: 'cash', paying: 'paying' };

export type Held = PartnerCall & { at: number; day: string; roomId: string; basis?: Inputs };
export type Moved = { field: keyof Inputs; from?: number; to?: number };

const between = (from: string, to: string) => Math.round((new Date(`${to}T12:00`).getTime() - new Date(`${from}T12:00`).getTime()) / DAY);

// Each figure that moved more than a tenth, or came or went, since the call.
export function movedSince(basis: Inputs, now: Inputs): Moved[] {
  return (Object.keys(LABELS) as (keyof Inputs)[]).flatMap((field): Moved[] => {
    const [from, to] = [basis[field], now[field]];
    if (from === undefined && to === undefined) return [];
    if (from === undefined || to === undefined) return [{ field, from, to }];
    if (from === to) return [];
    return Math.abs(to - from) > Math.abs(from) * MOVE || from === 0 ? [{ field, from, to }] : [];
  });
}

// Whether the call is due a fresh look today, and why: the numbers moved, or a week went by.
export function refreshDue(call: Held | undefined, now: Inputs | undefined, today: string): { why: 'moved' | 'week'; moved: Moved[] } | null {
  if (!call?.decision) return null;
  const moved = call.basis && now ? movedSince(call.basis, now) : [];
  if (moved.length) return { why: 'moved', moved };
  return between(call.day, today) >= WEEK ? { why: 'week', moved: [] } : null;
}

const shortDay = (day: string) => new Date(`${day}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const money = (value: number, currency = '') => `${currency}${Math.round(value * 100) / 100 === Math.round(value) ? Math.round(value).toLocaleString('en-US') : (Math.round(value * 100) / 100).toLocaleString('en-US')}`;
const said = (field: keyof Inputs, value: number | undefined, economics: Pick<Economics, 'currency' | 'unit'>) => (value === undefined ? 'not given'
  : field === 'paying' ? String(value) : money(value, economics.currency ?? ''));

// "On 1 Oct I said keep going at 3 paying offices; now 34 needed to break even and 4 paying offices." with what moved.
export function refreshOpening(call: Held, economics: Economics | null, moved: Moved[]): string {
  const unit = economics?.unit ?? 'paying customers';
  const then = call.basis?.paying !== undefined ? ` at ${call.basis.paying} ${unit}` : '';
  const even = economics?.breakEven !== undefined ? Number.isFinite(economics.breakEven) ? `${economics.breakEven} needed to break even` : 'each one loses money, so no count breaks even' : '';
  const have = economics?.current !== undefined ? `${economics.current} ${unit}` : '';
  const nowLine = [even, have].filter(Boolean).join(' and ');
  const changes = moved.map((one) => `${one.field === 'paying' ? unit : LABELS[one.field]} ${said(one.field, one.from, economics ?? {})} to ${said(one.field, one.to, economics ?? {})}`);
  return `On ${shortDay(call.day)} I said ${call.decision}${then}${nowLine ? `; now ${nowLine}` : ''}.${changes.length ? ` Since then: ${changes.join(', ')}.` : ''}`;
}

// What the partner is asked to answer, with the old call and the working now in front of it.
export function refreshAsk(call: Held, opening: string, economics: Economics | null, today: string, why: 'moved' | 'week'): string {
  return `${why === 'moved' ? 'The numbers behind your verdict moved.' : 'A week has passed since your verdict.'} Make the call again, unasked, on the numbers as they stand now.\n`
    + `Your verdict then:\n${renderCall(call)}\n\n${opening}\n\n${callShape(today, !!economics)}${economics ? `\n\n${economicsBlock(economics)}` : ''}`;
}

// The refresh as the founder reads it: the old call quoted and what changed, "still" or "now" the call, then the four lines.
export function refreshText(opening: string, old: Decision | undefined, fresh: PartnerCall): string {
  const [first, changes] = opening.split(/(?<=\.) (?=Since then:)/);
  const head = fresh.decision ? `${first.replace(/\.$/, '')}: ${fresh.decision === old ? 'still' : 'now'} ${fresh.decision}.${changes ? ` ${changes}` : ''}` : opening;
  return `${head}\n\n${renderCall(fresh)}`;
}

// The new call read from the reply, held to the same four lines as an asked verdict; null when it has no call at all.
export function readRefresh(reply: Pick<TurnResult, 'text'>, today: string, evidence: string, economics: Economics | null): PartnerCall | null {
  const read = readCall(reply.text, today, `${evidence}\n${(economics?.working ?? []).map((one) => one.line).join('\n')}`, economics);
  if (!read.decision) return null;
  return {
    decision: read.decision, ...(read.why && !read.unsourced.length ? { why: read.why } : {}), ...(read.signal ? { signal: read.signal } : {}), ...(read.move ? { move: read.move } : {}),
    ...(read.closes ? { gap: read.closes } : {}), ...(economics?.working.length ? { working: economics.working.map((one) => one.line) } : {}),
  };
}
