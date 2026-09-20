import type { ToolEvent, Usage } from '../shared/model.ts';
import type { ModelMessage } from './prompt.ts';
import { complete, retryAfter, type Failure, type ModelClient } from './providers.ts';
import type { Answer } from './approvals.ts';
import type { Seams, Source } from './seams.ts';
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
  // Asks the founder about one outward call. Absent (nobody is there to ask) means no.
  approve?: (event: ToolEvent, signal?: AbortSignal) => Promise<Answer>;
  // Where the extras plug in, and what set this turn off. Without seams the turn runs exactly as it always did.
  seams?: Seams; source?: Source; query?: string;
}): Promise<TurnResult> {
  const { tools, context, usage, events, signal, seams } = input;
  const { roomId } = context;
  const source = input.source ?? 'chat';
  const query = input.query ?? '';
  let messages = [...input.messages];
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

  if (seams) messages = (await seams.run('turn:before', { roomId, source, query, messages })).messages;

  for (let step = 1; step <= MAX_STEPS && !signal?.aborted; step += 1) {
    if (seams) messages = (await seams.run('step:before', { roomId, step, messages })).messages;
    const offered = step < MAX_STEPS ? tools : [];
    const gap = text && !/\s$/.test(text) ? '\n\n' : '';
    let first = true;
    const ask = () => complete(messages, {
      tools: offered, signal,
      onToken: (token) => { const piece = first ? gap + token : token; first = false; text += piece; events.token(piece); },
    }, clients, onFailure);
    // A step every model refused — usually because the prompt outgrew them — gets one more chance: whatever listens
    // here shortens it and says so, and we ask again with what it left.
    const turn = seams ? await ask().catch(async (error: Error) => {
      const again = await seams.run('step:error', { roomId, step, messages, error: error.message });
      if (!again.retry) throw error;
      messages = again.messages;
      return ask();
    }) : await ask();

    if (failed.length) events.notice?.(`${failed.splice(0).join('; ')}, so ${turn.client.name} answers.`);
    // Words already shown stay; the founder is told they stop short. (A cut reply with no words moved to the next model already.)
    if (turn.cut) events.notice?.(`${turn.client.name} hit its length limit, so this reply is cut short. Ask for the rest, or for a shorter answer.`);
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
      const tool = tools.find((candidate) => candidate.name === call.name);
      let rawArgs = call.args;
      let refusal = tool?.ready?.() ?? null;
      // The founder may have said yes in advance to calls that reach exactly this far. It only skips the asking.
      let approved = false;
      if (seams) {
        const checked = await seams.run('tool:before', { roomId, call: { id: call.id, name: call.name, args }, ...(refusal ? { refusal } : {}) });
        // Only a rewrite is taken as one: the raw text the model wrote goes on untouched otherwise.
        if (checked.call.args !== args) { args = checked.call.args; rawArgs = JSON.stringify(args); }
        refusal = refusal || checked.refusal || null;
        approved = checked.approved === true;
      }
      const question = refusal || !tool?.approval ? null : typeof tool.approval === 'function' ? await tool.approval(args, context).catch(() => 'Allow this step?') : '';
      if (question !== null && !approved) {
        const asking: ToolEvent = { id: call.id, name: call.name, args, waiting: true, ...(question ? { question } : {}) };
        events.tool(asking);
        // An approval that fails is a no, not the end of the turn: the founder still gets their reply.
        const answer: Answer = input.approve ? await input.approve(asking, signal).catch(() => ({ ok: false })) : { ok: false };
        if (!answer.ok) refusal = signal?.aborted ? 'Stopped by the founder.' : 'The founder said no to this. Do not try it again; ask what they want changed.';
        // The founder may have edited what goes out. Only fields the person proposed can change; nothing new is added.
        else if (answer.args) { args = { ...args, ...Object.fromEntries(Object.entries(answer.args).filter(([key, value]) => key in args && typeof value === typeof args[key])) }; rawArgs = JSON.stringify(args); }
      }
      events.tool({ id: call.id, name: call.name, args });
      context.signal = signal;
      context.report = (effect) => events.tool({ id: call.id, name: call.name, args, effect });
      // A tool that runs a turn of its own inside itself asks the founder on this turn's path, not on one of its own.
      context.approve = input.approve;
      const ran = refusal ? { text: refusal, ok: false, args, effect: undefined } : await runTool(tools, call.name, rawArgs, context);
      let event: ToolEvent = { id: call.id, name: call.name, args: ran.args, ok: ran.ok, result: ran.text.slice(0, RESULT_CHARS), effect: ran.effect };
      if (seams) event = (await seams.run('tool:after', { roomId, event })).event;
      done.push(event);
      events.tool(event);
      messages.push({ role: 'tool', tool_call_id: call.id, content: event.result ?? '' });
    }
  }

  const reply: TurnResult = { text, tools: done, provider: answered?.name ?? '', model: answered?.model ?? '', usage: total, stopped: !!signal?.aborted };
  // Whatever watches a finished turn watches it afterwards: the founder waits for nothing here.
  if (seams) void seams.run('turn:after', { roomId, source, query, reply }).catch(() => {});
  return reply;
}
