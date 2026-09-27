import { fitHistory, providerOf, wireTools, type ModelClient, type ToolSpec } from './providers.ts';
import type { ModelMessage } from './prompt.ts';
import type { UsageBook } from './usage.ts';

// With only Groq set up (or with every model that holds a room prompt refused or spent for the day), the whole prompt
// fits nobody: Groq's free tier holds 18k characters, and a room with its documents, playbook and talk is 25-40k. Cutting
// the oldest talk is not enough when the documents alone are over, so the turn failed with "prompt too large". It is
// built again short instead: each document's title and opening, no playbook, only the latest talk (prompt.ts), and the
// founder is told why the answer may know less.

// True when no model that could take this turn holds its prompt, even with the oldest talk cut. A small model on this
// machine counts only when no hosted one is set up, as in `complete`; a key refused or spent for the day does not count.
export function needsSlim(clients: ModelClient[], usage: Pick<UsageBook, 'dead' | 'spent'>, messages: ModelMessage[], tools: ToolSpec[]): boolean {
  const toolChars = tools.length ? JSON.stringify(wireTools(tools)).length : 0;
  const hosted = clients.filter((client) => !client.side && !client.local);
  const able = (hosted.length ? hosted : clients.filter((client) => !client.side))
    .filter((client) => (!tools.length || client.tools) && !usage.dead(client.name) && !(client.sharedPool && usage.spent(client)));
  return able.length > 0 && !able.some((client) => fitHistory(messages, client.maxPromptChars - toolChars) !== null);
}

const title = (name: string) => name[0].toUpperCase() + name.slice(1);
export const slimNotice = (client: Pick<ModelClient, 'name'>) =>
  `${title(providerOf(client.name))} answers with a short prompt: the documents' titles and openings only, no playbook, and only the latest talk.`;
