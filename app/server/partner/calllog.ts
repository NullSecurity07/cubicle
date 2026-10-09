import { thresholdOf, type Decision, type KillSignal } from './call.ts';

// Journey 21: asked for exact recall, the partner said "Kill line set then: Paying cafés below 4"; day one was "below
// 6", and "below 4" came on 10 Oct. Only the latest call was kept, so the model recalled the first from the chat. Each
// call and each kill line is kept in order as it is set, and a recall is answered from that record.
export type CallEntry = { day: string; at: number; decision?: Decision; signal?: KillSignal };
export const MOST_CALLS = 30;

// The record with the call as it stands now added, when its verdict or its kill line is new.
export function logCall(log: CallEntry[], call: { day: string; at: number; decision?: Decision; signal?: KillSignal } | undefined): CallEntry[] {
  if (!call || (!call.decision && !call.signal)) return log;
  const last = log.at(-1);
  if (last && last.decision === call.decision && last.signal?.what === call.signal?.what && last.signal?.by === call.signal?.by) return log;
  return [...log, { day: call.day, at: call.at, ...(call.decision ? { decision: call.decision } : {}), ...(call.signal ? { signal: { what: call.signal.what, by: call.signal.by } } : {}) }].slice(-MOST_CALLS);
}

const line = (one: CallEntry) => `- ${one.day}: ${one.decision ? `call "${one.decision}"` : 'call unchanged'}${one.signal ? `, kill line "${one.signal.what}" by ${one.signal.by}` : ''}`;
// What the partner is told before a recall: every call and kill line in the order they were set.
export const callRecord = (log: CallEntry[]) => (log.length
  ? `Your calls and kill lines on record, in the order they were set (the first is your day-one call; quote these, never the chat):\n${log.map(line).join('\n')}`
  : '');

// A question about what was called or set before.
export const asksRecall = (query: string) => /\b(?:day[- ]one|day 1|first (?:call|verdict|kill)|set (?:it )?then|back then|exact recall|recall|remind me|what (?:did|was) (?:your|my|our|the) (?:first|original|call|verdict|kill))\b/i.test(query);

// "Kill line set then: Paying cafés below 4" with day one's line "below 6": a line said of day one is day one's own.
const OF_THEN = /\b(?:day[- ]one|day 1|first (?:call|verdict|kill line|line)|set then|back then|then|originally|at first)\b/i;
const LINE = /\b(below|under|above|over|fewer than|less than|more than)\s+(\*\*)?([$€£]?\d[\d,]*(?:\.\d+)?)/gi;
export function holdFirstLine(reply: string, log: CallEntry[]): string {
  const first = log.find((one) => one.signal)?.signal;
  const want = first ? thresholdOf(first.what) : null;
  if (!want) return reply;
  return reply.split('\n').map((row) => row.split(/(?<=[.!?])\s+/).map((sentence) => {
    if (!OF_THEN.test(sentence) || !/\bkill\b|\bline\b/i.test(sentence) || /\b(?:now|today|current(?:ly)?)\b/i.test(sentence)) return sentence;
    return sentence.replace(LINE, (whole, word: string, stars = '', figure: string) => (Number(figure.replace(/[^\d.]/g, '')) === want.value ? whole : `${word} ${stars}${figure.replace(/[\d,.]+/, String(want.value))}`));
  }).join(' ')).join('\n');
}
