import type { ToolEvent, Usage } from '../shared/model.ts';
import type { ModelMessage } from './prompt.ts';
import { complete, retryAfter, type Failure, type ModelClient } from './providers.ts';
import { runTool, type Tool, type ToolContext } from './tools/registry.ts';
import type { UsageBook } from './usage.ts';

const MAX_STEPS = 8;
const RESULT_CHARS = 6000;

export type TurnEvents = { token(token: string): void; tool(event: ToolEvent): void; notice?(text: string): void };
export type TurnResult = { text: string; tools: ToolEvent[]; provider: string; model: string; usage: Usage; stopped: boolean };

// One turn of one person: ask the model, run the tools it calls, hand the results back, until it answers in words.
// The last allowed step offers no tools, so a turn always ends in words. A stop keeps whatever was said so far.
export async function runTurn(input: {
  messages: ModelMessage[]; tools: Tool[]; context: ToolContext; clients: ModelClient[];
  usage: UsageBook; events: TurnEvents; signal?: AbortSignal;
}): Promise<TurnResult> {
  const { tools, context, usage, events, signal } = input;
  const messages = [...input.messages];
  let clients = input.clients;
  const done: ToolEvent[] = [];
  const total: Usage = { input: 0, output: 0 };
  let text = '';
  let answered: ModelClient | undefined;
  const failed: string[] = [];

  // When the model that should have answered could not, the founder hears which one stepped in and why.
  const onFailure = ({ client, error }: Failure) => {
    const status = (error as { status?: number }).status;
    failed.push(`${client.name} could not answer (${status === 429 ? 'free limit reached' : (error.message || 'error').slice(0, 120)})`);
    if (status === 429) usage.cool(client.name, retryAfter(error));
  };

  for (let step = 1; step <= MAX_STEPS && !signal?.aborted; step += 1) {
    const offered = step < MAX_STEPS ? tools : [];
    const gap = text && !/\s$/.test(text) ? '\n\n' : '';
    let first = true;
    const turn = await complete(messages, {
      tools: offered, signal,
      onToken: (token) => { const piece = first ? gap + token : token; first = false; text += piece; events.token(piece); },
    }, clients, onFailure);

    if (failed.length) events.notice?.(`${failed.splice(0).join('; ')}, so ${turn.client.name} answers.`);
    usage.record(turn.client.name, turn.usage, turn.quota);
    total.input += turn.usage?.input ?? 0;
    total.output += turn.usage?.output ?? 0;
    answered = turn.client;
    // Stay with the model that is already in the middle of this turn; the others remain as a net.
    clients = [turn.client, ...clients.filter((client) => client !== turn.client)];
    if (!turn.calls.length || signal?.aborted) break;

    messages.push({
      role: 'assistant', content: turn.text,
      tool_calls: turn.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.args || '{}' }, ...(call.extra === undefined ? {} : { extra_content: call.extra }) })),
    });
    for (const call of turn.calls) {
      let args: Record<string, unknown> = {};
      try { args = call.args.trim() ? JSON.parse(call.args) : {}; } catch { /* runTool reports it */ }
      events.tool({ id: call.id, name: call.name, args });
      const ran = await runTool(tools, call.name, call.args, context);
      const event: ToolEvent = { id: call.id, name: call.name, args: ran.args, ok: ran.ok, result: ran.text.slice(0, RESULT_CHARS), effect: ran.effect };
      done.push(event);
      events.tool(event);
      messages.push({ role: 'tool', tool_call_id: call.id, content: event.result! });
    }
  }

  return { text, tools: done, provider: answered?.name ?? '', model: answered?.model ?? '', usage: total, stopped: !!signal?.aborted };
}
