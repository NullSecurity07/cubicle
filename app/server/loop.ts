import type { ToolEvent, Usage } from '../shared/model.ts';
import type { ModelMessage } from './prompt.ts';
import { complete, type Failure, type ModelClient } from './providers.ts';
import type { Answer } from './approvals.ts';
import { limitWords } from './breaker.ts';
import { resultCap } from './context/shrink.ts';
import type { Offered } from './playbook.ts';
import type { Payloads, Seams, Source } from './seams.ts';
import { runTool, type Tool, type ToolContext } from './tools/registry.ts';
import { ANSWER_IN_WORDS, CALL_THE_TOOL, checkReply, HELD_BACK, proseToolCall } from './truth.ts';
import type { UsageBook } from './usage.ts';

const MAX_STEPS = 8;
// What the founder's receipt keeps of a result. The model is handed the whole of it: a five-page read, the last of
// several searches and the error at the end of a long run all sit past this, and the shrinker at the door knows how
// to make a long result small without throwing its end away.
const RESULT_CHARS = 6000;
// The most any one result may take of a prompt when nothing else has made it smaller: no shrinker listening, or a
// JSON answer that could not lose whole entries. Only a turn with no model limit at all ever reaches this.
const RESULT_CEILING = 60_000;
const CUT = '\n… (cut) …\n';

// A long text cut to `cap`, keeping its start and its last block: the end of a result is where a run's error, a
// search's list of sources and the founder's Undo line all are.
function cutKeepingEnd(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const lastBlock = text.slice(text.lastIndexOf('\n\n') + 1);
  const tail = lastBlock.length <= cap / 4 ? lastBlock : text.slice(-Math.floor(cap / 4));
  return `${text.slice(0, Math.max(0, cap - tail.length - CUT.length))}${CUT}${tail}`;
}

// Every tool result in the prompt held under the cap once whatever listens before a step has had its turn at them.
const bounded = (messages: ModelMessage[], cap: number) => messages.some((message) => message.role === 'tool' && message.content.length > cap)
  ? messages.map((message) => (message.role === 'tool' && message.content.length > cap ? { ...message, content: cutKeepingEnd(message.content, cap) } : message))
  : messages;

// Said to a model that ran tools and then answered with nothing: once, with no tools, so it can only answer in words.
export const SAY_SOMETHING = 'You called tools and said nothing. In two or three sentences tell the founder what you found, what you could not do, and what you need.';

// The reply of last resort, built from the receipts alone when the model still says nothing: which tool ran, whether
// it worked, and the first line of what it said. The founder is never left with an empty bubble under the chips.
export function receiptSummary(done: ToolEvent[], why?: string): string {
  const lines = done.map((event) => {
    const first = (event.result ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';
    return `- ${event.name.replace(/_/g, ' ')}: ${event.ok ? 'worked' : 'failed'}${first ? `. ${first.slice(0, 200)}` : ''}`;
  });
  return `${why ?? 'I ran these steps but gave no answer'}, so here is what they said:\n\n${lines.join('\n')}`;
}

type TurnEvents = { token(token: string): void; tool(event: ToolEvent): void; notice?(text: string): void };
// `flags`: the truth net's lines under this reply, the same ones appended to its text, for whoever wants them apart.
export type TurnResult = { text: string; tools: ToolEvent[]; provider: string; model: string; usage: Usage; stopped: boolean; flags?: string[] };

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
  let unanswered = '';
  // What this turn really read, for the truth net: the prompt as sent and the whole of every tool result.
  const results: string[] = [];
  // Why the stream broke off mid-reply, when it did; whether a tool call came back as text and was already asked about
  // once; whether it came back so twice and was held back; whether the reply had to be made from the receipts.
  let broke = '';
  let nudged = false;
  let held = false;
  let summarised = false;

  // When the model that should have answered could not, the founder hears which one stepped in and why.
  const onFailure = ({ client, error }: Failure) => {
    const status = (error as { status?: number }).status;
    failed.push(`${client.name} could not answer (${status === 429 ? limitWords(error) : (error.message || 'error').slice(0, 120)})`);
    // A 429 rests the key, five breakdowns in a row open its breaker; either way its siblings serve meanwhile.
    usage.failed(client.name, error);
  };

  // What this turn offers rides along for the playbook, which leaves out procedures that need anything else.
  const before: Payloads['turn:before'] & Offered = { roomId, source, query, messages, offered: tools.map((tool) => tool.name) };
  if (seams) messages = (await seams.run('turn:before', before)).messages;
  const inputs = messages;

  for (let step = 1; step <= MAX_STEPS && !signal?.aborted; step += 1) {
    if (seams) messages = (await seams.run('step:before', { roomId, step, messages })).messages;
    messages = bounded(messages, Math.min(resultCap(clients), RESULT_CEILING));
    const offered = step < MAX_STEPS ? tools : [];
    const stepStart = text.length;
    const gap = text && !/\s$/.test(text) ? '\n\n' : '';
    let first = true;
    const ask = () => complete(messages, {
      tools: offered, signal,
      onToken: (token) => { const piece = first ? gap + token : token; first = false; text += piece; events.token(piece); },
    }, clients, onFailure, (client) => usage.admit(client.name));
    // A step every model refused — usually because the prompt outgrew them — gets one more chance: whatever listens
    // here shortens it and says so, and we ask again with what it left.
    const asked = seams ? ask().catch(async (error: Error) => {
      const again = await seams.run('step:error', { roomId, step, messages, error: error.message });
      if (!again.retry) throw error;
      messages = again.messages;
      return ask();
    }) : ask();
    // Once tools have run, a step no model could answer (every one empty, limited or down) no longer ends the turn in
    // an error that loses the receipts: the founder is told, and the reply is built from what the tools said.
    const turn = await asked.catch((error: Error) => {
      if (!done.length || signal?.aborted) throw error;
      // Models that answered with nothing at all are asked once more below; models that could not answer are not.
      if (!/empty reply/.test(error.message)) unanswered = error.message;
      return null;
    });
    if (!turn) break;

    if (failed.length) events.notice?.(`${failed.splice(0).join('; ')}, so ${turn.client.name} answers.`);
    // Words already shown stay; the founder is told they stop short. (A cut reply with no words moved to the next model already.)
    if (turn.cut && !turn.broke) events.notice?.(`${turn.client.name} hit its length limit, so this reply is cut short. Ask for the rest, or for a shorter answer.`);
    usage.record(turn.client.name, turn.usage, turn.quota);
    total.input += turn.usage?.input ?? 0;
    total.output += turn.usage?.output ?? 0;
    answered = turn.client;
    // Stay with the model that is already in the middle of this turn; the others remain as a net.
    clients = [turn.client, ...clients.filter((client) => client !== turn.client)];
    if (turn.broke) broke = turn.broke;
    // A tool call written out as words is not an answer. The words come out of the reply (the saved one replaces what
    // was streamed), the model is told once to make the call, and a second time the founder gets a clean line instead.
    const spoke = text.slice(stepStart);
    if (!turn.calls.length && !turn.broke && !signal?.aborted && proseToolCall(spoke, tools.map((tool) => tool.name))) {
      text = text.slice(0, stepStart);
      if (!nudged && step < MAX_STEPS) {
        nudged = true;
        messages.push({ role: 'assistant', content: spoke }, { role: 'user', content: offered.length ? CALL_THE_TOOL : ANSWER_IN_WORDS });
        continue;
      }
      held = true;
      const line = `${text.trim() ? '\n\n' : ''}${HELD_BACK}`;
      text += line;
      events.token(line);
      break;
    }
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
      context.query = query;
      context.report = (effect) => events.tool({ id: call.id, name: call.name, args, effect });
      // A tool that runs a turn of its own inside itself asks the founder on this turn's path, not on one of its own.
      context.approve = input.approve;
      const ran = refusal ? { text: refusal, ok: false, args, effect: undefined } : await runTool(tools, call.name, rawArgs, context);
      // Whatever rewrites a result (the secrets taken out, the Undo line put on) sees all of it, and the model gets
      // all of what comes back; only the receipt the founder keeps is cut.
      let event: ToolEvent = { id: call.id, name: call.name, args: ran.args, ok: ran.ok, result: ran.text, effect: ran.effect };
      if (seams) event = (await seams.run('tool:after', { roomId, event })).event;
      const full = event.result ?? '';
      if (full.length > RESULT_CHARS) event = { ...event, result: cutKeepingEnd(full, RESULT_CHARS) };
      done.push(event);
      events.tool(event);
      messages.push({ role: 'tool', tool_call_id: call.id, content: full });
      results.push(full);
    }
  }

  // Tools ran and nothing was said: asked once more with no tools, then, if still nothing, the receipts speak.
  if (done.length && !text.trim() && !signal?.aborted) {
    if (!unanswered) {
      messages.push({ role: 'user', content: SAY_SOMETHING });
      const said = await complete(messages, { tools: [], signal, onToken: (token) => { text += token; events.token(token); } }, clients, onFailure, (client) => usage.admit(client.name))
        .catch((error: Error) => { if (!/empty reply/.test(error.message)) unanswered = error.message; return null; });
      if (said) {
        if (failed.length) events.notice?.(`${failed.join('; ')}, so ${said.client.name} answers.`);
        usage.record(said.client.name, said.usage, said.quota);
        total.input += said.usage?.input ?? 0;
        total.output += said.usage?.output ?? 0;
        answered = said.client;
        if (said.broke) broke = said.broke;
      }
      failed.splice(0);
    }
    if (!text.trim() && !signal?.aborted) {
      if (unanswered) events.notice?.(`No model could answer after the tools ran (${unanswered.slice(0, 160)}), so this reply is made from their receipts.`);
      const summary = receiptSummary(done, unanswered ? 'No model could answer after these steps' : undefined);
      text = summary;
      summarised = true;
      events.token(summary);
    }
  } else if (unanswered && !signal?.aborted) events.notice?.(`No model could go on after the tools ran (${unanswered.slice(0, 160)}), so this reply stops here.`);

  // The truth net: a reply that claims an action no receipt backs, or gives figures nothing this turn read, keeps its
  // words and gets a line under them saying so. A reply the stream broke off says it was cut, and, when tools ran, what
  // they did, since the words that would have said it never came.
  let flags: string[] = [];
  if (!signal?.aborted && !held && !summarised && text.trim()) {
    flags = checkReply({ reply: text, receipts: done, sources: [...inputs.map((message) => message.content), ...results, query] });
    const tail = [...(broke ? [`(reply cut short: ${broke})`] : []), ...(broke && done.length ? [receiptSummary(done, 'The reply broke off after these steps')] : []), ...flags];
    if (tail.length) {
      const line = `${/\s$/.test(text) ? '' : '\n\n'}${tail.join('\n\n')}`;
      text += line;
      events.token(line);
    }
    if (flags.length) events.notice?.(flags.join(' '));
  }

  const reply: TurnResult = { text, tools: done, provider: answered?.name ?? '', model: answered?.model ?? '', usage: total, stopped: !!signal?.aborted, ...(flags.length ? { flags } : {}) };
  // Whatever watches a finished turn watches it afterwards: the founder waits for nothing here.
  if (seams) void seams.run('turn:after', { roomId, source, query, reply }).catch(() => {});
  return reply;
}
