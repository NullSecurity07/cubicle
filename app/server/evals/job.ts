import type { Deps } from '../install.ts';
import type { ModelMessage } from '../prompt.ts';
import { complete, type ModelClient } from '../providers.ts';
import { fakeJudge, type Judge } from './score.ts';
import { autoevalsJudge, judgeClientsOf, readyEnough } from './scorers.ts';

// What the evals and the forge share about a long job the founder watches: its lines, the one model call that comes
// back as words, the judge, and how it fails. Each slice keeps its own job shape; these only need the parts below.
export type Held = { state: string; lines: string[]; calls: number; error?: string; models: Set<string>; stop: AbortController };
export const MOST_LINES = 400;

// A line the founder reads while they wait: kept on the job for whoever asks afterwards, and said at once on the
// window's one live feed (by `tell`) for whoever is watching now.
export function jobLines<J extends Held>(tell: (held: J, line: string) => void, most = MOST_LINES) {
  return (held: J, line: string) => {
    held.lines = [...held.lines, line].slice(-most);
    tell(held, line);
  };
}

// One model call that comes back as words, counted on the job and in the usage table. Tagged 'eval' for both the
// evals and the forge: a 'forge' kind of its own would belong in usage.ts.
export async function askWords(deps: Pick<Deps, 'usage'>, held: Held, messages: ModelMessage[], order: ModelClient[]): Promise<string> {
  const reply = await complete(messages, { onToken: () => {}, signal: held.stop.signal }, order);
  held.calls += 1;
  held.models.add(reply.client.name);
  deps.usage.record(reply.client.name, reply.usage, reply.quota, 'eval');
  return reply.text;
}

// The judge. In fake mode nothing is asked of any model: the scores come from the case's own id, so a browser journey
// and the unit tests run offline and say the same thing twice. Otherwise the `autoevals` scorers through the keys this
// app already holds, every provider that can judge, best first, so a rate limit on one moves the scoring to the next;
// a 429 lets that provider cool. With no provider that speaks the OpenAI API, `ask` writes the one prompt of our own.
export function judgeFor(deps: Pick<Deps, 'fake' | 'clients' | 'usage'>, held: Held, ask: (messages: ModelMessage[]) => Promise<string>): Judge {
  if (deps.fake) return fakeJudge;
  const clients = judgeClientsOf(deps.clients, readyEnough(deps.usage));
  if (!clients.length) return ({ messages }) => ask(messages);
  held.models.add(clients[0].name);
  return autoevalsJudge({
    clients, onCall: () => { held.calls += 1; },
    onLimited: (name, milliseconds) => { deps.usage.cool(name, milliseconds); },
  });
}

// A job that went wrong says so on its last line, unless another job has taken its place meanwhile.
export function failWith<J extends Held>(current: () => J | null, say: (held: J, line: string) => void) {
  return (held: J, error: Error) => {
    if (current() !== held) return;
    held.state = 'failed';
    held.error = error.message;
    say(held, error.message);
  };
}
