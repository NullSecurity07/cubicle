import type { ModelMessage } from './prompt.ts';
import { complete, type Completion, type ModelClient } from './providers.ts';

// Every instruction that asks for one carries the word "json", because some providers refuse the request without it.
export const JSON_RULE = 'Answer with one json object and nothing else: no fence, no explanation.';

// The first whole JSON value in a reply, fenced or bare, with whatever the model said around it thrown away.
// Braces inside strings are counted as text, so a value that quotes a `}` still comes out whole.
export function firstJson(reply: string): unknown {
  const body = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply)?.[1] ?? reply;
  const start = body.search(/[{[]/);
  if (start < 0) throw new Error('there was no json in the reply');
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = start; at < body.length; at += 1) {
    const letter = body[at];
    if (escaped) escaped = false;
    else if (letter === '\\') escaped = inString;
    else if (letter === '"') inString = !inString;
    else if (inString) continue;
    else if (letter === open) depth += 1;
    else if (letter === close) { depth -= 1; if (!depth) return JSON.parse(body.slice(start, at + 1)); }
  }
  throw new Error('the json in the reply was never closed');
}

// One model call that has to come back as a shape we asked for. `check` returns the typed value or throws the reason
// it is wrong; the model hears that reason once and gets one more go, and a second failure is the caller's to handle.
// No tools are offered: this is a question, not a turn.
export async function completeJson<T>(
  messages: ModelMessage[], check: (value: unknown) => T, clients: ModelClient[],
  options: { signal?: AbortSignal; onReply?: (reply: Completion) => void } = {},
): Promise<T> {
  const history = [...messages];
  let last = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const reply = await complete(history, { onToken: () => {}, signal: options.signal }, clients);
    options.onReply?.(reply);
    try {
      return check(firstJson(reply.text));
    } catch (error) {
      last = (error as Error).message;
      history.push({ role: 'assistant', content: reply.text }, { role: 'user', content: `That was wrong: ${last}. ${JSON_RULE}` });
    }
  }
  throw new Error(`the model did not answer in the shape asked for: ${last}`);
}
