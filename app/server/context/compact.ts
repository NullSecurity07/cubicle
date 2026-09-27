import type { ModelMessage } from '../prompt.ts';
import { complete, promptSize, type ModelClient } from '../providers.ts';
import { route } from '../router.ts';
import type { Handler } from '../seams.ts';
import type { UsageBook } from '../usage.ts';

export type Shrinking = { clients: ModelClient[]; usage: UsageBook };

// Four fifths of the smallest prompt any configured model will hold. The fifth left over is the room the answer and
// the step after it need, and the smallest is the one that counts: a turn that has to change model half way round
// must still fit the one it lands on.
const SHARE = 0.8;
const RESULT_CHARS = 200;
const ROUNDS = 2;
const HEAD = 3;
const TAIL = 20;
const SUMMARY_CHARS = 1500;
const EACH_CHARS = 1200;
const MATERIAL_CHARS = 40_000;
const OPENS = 'Earlier in this piece of work, in short:';
const TOO_BIG = /too large|too long|too many tokens|context length|maximum context/i;

const ASK = 'You are shortening the middle of one person\'s piece of work so they can carry on with it. What follows is what they were asked, '
  + 'what their tools answered and what they wrote back. Write what somebody picking the work up now would need: what was asked for, what has been '
  + `done, what came back, and what is still open. Plain sentences, no preamble, at most ${SUMMARY_CHARS} characters.`;

// The side model never answers a turn, so its small window is no turn's limit.
export const budgetOf = (clients: ModelClient[]) => Math.min(...clients.filter((client) => !client.side).map((client) => client.maxPromptChars)) * SHARE;

// Where each of an assistant's rounds of tool calls begins. A call and the results that answer it are one thing:
// providers refuse a result whose call they cannot see, so the two travel together or they go together.
const roundsOf = (messages: ModelMessage[]) => messages.flatMap((message, at) => (message.role === 'assistant' && message.tool_calls?.length ? [at] : []));
// A boundary that landed on a result steps back to the call above it, so no round is ever cut in half.
const wholeAt = (messages: ModelMessage[], at: number) => {
  let from = at;
  while (from > 0 && messages[from].role === 'tool') from -= 1;
  const call = messages[from];
  return call?.role === 'assistant' && call.tool_calls?.length ? from : at;
};

// The pass that costs nothing: results from all but the last two rounds are cut to a line, saying what went with them.
export function trimResults(messages: ModelMessage[], keep = ROUNDS, cap = RESULT_CHARS): ModelMessage[] {
  const rounds = roundsOf(messages);
  const recent = rounds.length > keep ? rounds[rounds.length - keep] : 0;
  return messages.map((message, at) => (message.role === 'tool' && at < recent && message.content.length > cap
    ? { ...message, content: `${message.content.slice(0, cap)}\n… (${message.content.length - cap} characters cut to make room; ask again if you need them)` }
    : message));
}

// What stays word for word: the system message, the opening of the work and the last stretch of it. Everything
// between the two is what a summary would stand in for.
export function edges(messages: ModelMessage[]) {
  const system = messages[0]?.role === 'system' ? 1 : 0;
  let head = Math.min(system + HEAD, messages.length);
  if (messages[head]?.role === 'tool') head = wholeAt(messages, head);
  let tail = Math.max(head, messages.length - TAIL);
  if (messages[tail]?.role === 'tool') tail = Math.max(head, wholeAt(messages, tail));
  return { head, tail };
}

// One message as the model summarising it reads it. A tool call is named rather than spelled out: what it was for
// is in the words around it, and its arguments are the bulkiest thing in a long turn.
const said = (message: ModelMessage) => {
  const who = message.role === 'user' ? 'Founder' : message.role === 'tool' ? 'Tool result' : 'They';
  const calls = message.role === 'assistant' && message.tool_calls?.length ? ` (used ${message.tool_calls.map((call) => call.function.name).join(', ')})` : '';
  return `${who}${calls}: ${message.content.slice(0, EACH_CHARS)}`;
};

// The second pass, which costs one small call: the middle becomes one note. The model that writes it is whichever
// the router ranks first for a call without tools, and what it spends is written down like anything else.
async function noteOf(middle: ModelMessage[], deps: Shrinking): Promise<string> {
  const material = middle.map(said).join('\n\n').slice(0, MATERIAL_CHARS);
  const messages: ModelMessage[] = [{ role: 'system', content: ASK }, { role: 'user', content: material }];
  const { order } = route(deps.clients, deps.usage, { promptChars: promptSize(messages), tools: false, kind: 'side' });
  const reply = await complete(messages, { onToken: () => {}, onRestart: () => {} }, order);
  if (!reply.reported) deps.usage.record(reply.client.name, reply.usage, reply.quota, 'compaction');
  return reply.text.trim().slice(0, SUMMARY_CHARS);
}

// Both passes, in order, stopping as soon as the prompt is inside the budget. A summary that cannot be written
// leaves the free pass standing: shortening a piece of work must never be the thing that ends it.
export async function squeeze(messages: ModelMessage[], deps: Shrinking, budget: number): Promise<ModelMessage[]> {
  const trimmed = trimResults(messages);
  if (promptSize(trimmed) <= budget) return trimmed;
  const { head, tail } = edges(trimmed);
  if (tail - head < 2) return trimmed;
  try {
    const note = await noteOf(trimmed.slice(head, tail), deps);
    if (!note) return trimmed;
    return [...trimmed.slice(0, head), { role: 'user', content: `${OPENS}\n${note}` }, ...trimmed.slice(tail)];
  } catch { return trimmed; }
}

// A piece of work that outgrew the model it is running on, shortened inside the turn rather than refused.
export function createCompaction(deps: Shrinking) {
  return {
    before: (async (payload, next) => {
      const budget = budgetOf(deps.clients);
      if (promptSize(payload.messages) <= budget) return next(payload);
      return next({ ...payload, messages: await squeeze(payload.messages, deps, budget) });
    }) satisfies Handler<'step:before'>,

    // Every model refused this step. When it was the size they refused, shorten as far as both passes go and say the
    // step is worth asking again; anything else (a provider down, a key spent) is not ours to answer.
    error: (async (payload, next) => {
      if (!TOO_BIG.test(payload.error)) return next(payload);
      const messages = await squeeze(payload.messages, deps, 0);
      if (promptSize(messages) >= promptSize(payload.messages)) return next(payload);
      return next({ ...payload, messages, retry: true });
    }) satisfies Handler<'step:error'>,
  };
}
