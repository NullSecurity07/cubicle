import { colleagueIds } from '../prompt.ts';
import { text, type Tool, type ToolContext } from './registry.ts';

// Puts a question to a colleague and returns their answer. The server supplies it, because it needs the model and both chats.
export type Consult = (input: { fromRoomId: string; toRoomId: string; question: string; signal?: AbortSignal }) => Promise<string>;

// A colleague's side turn on a small model sometimes answers with a tool call written out as text, in one of the
// shapes models are trained on: `<tool_call>`, `<function=name>`, a bare {"name", "arguments"} object (fenced or not),
// or gpt-oss's **name**{...}. Passed on as the answer, a live run had the asker read it as the colleague's reply and
// then write the colleague's section itself. So it is not an answer. A whole reply that is such an object is taken as
// a call even when a colleague meant it as an example; that is rare, and the retry gives them a second chance.
export function proseCall(said: string): boolean {
  const text = said.trim();
  // At the start of the reply or of a line: a colleague who mentions the tags mid-sentence is still answering.
  if (/(^|\n)\s*(<\|?tool_call\|?>|<function\s*=)/i.test(text)) return true;
  if (/^\*\*[a-z_][a-z0-9_]*\*\*\s*\{/i.test(text)) return true;
  const bare = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!/^[[{]/.test(bare)) return false;
  try {
    const value: unknown = JSON.parse(bare);
    return (Array.isArray(value) ? value : [value]).some((one) => !!one && typeof one === 'object' && typeof (one as Record<string, unknown>).name === 'string'
      && ('arguments' in one || 'parameters' in one));
  } catch { return false; }
}

// A wire between two people lets each consult the other, inside a turn the founder started. The colleague answers from
// their own documents and conversation, without tools, and cannot pass the question on: no chains, no loops.
export function teamTools(consult: Consult): Tool[] {
  return [{
    name: 'ask_person',
    perTurn: 2,
    description: 'Ask a colleague connected to your room one question and get their answer. They know their own documents and conversation, not yours: put what they need into the question.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'The colleague\'s name' }, question: { type: 'string' } }, required: ['name', 'question'] },
    async run(args, context: ToolContext) {
      const wanted = text(args, 'name', 80).trim().toLowerCase();
      const colleagues = colleagueIds(context.stage, context.roomId).map((id) => context.stage.rooms.find((room) => room.id === id)!);
      const target = colleagues.find((room) => room.name.trim().toLowerCase() === wanted);
      if (!target) throw new Error(`no colleague called "${args.name}" is connected to your room. Connected: ${colleagues.map((room) => room.name).join(', ') || 'nobody'}. The founder connects people by drawing a wire between them.`);
      const question = { fromRoomId: context.roomId, toRoomId: target.id, question: text(args, 'question', 4000), signal: context.signal };
      // One more try when the first reply was a tool call in words; a second such reply is no answer at all.
      let answer = await consult(question);
      if (proseCall(answer)) answer = await consult(question);
      if (proseCall(answer)) throw new Error(`${target.name} did not answer: their reply came back as a tool call instead of words. Do not write their part yourself; work from what you have, or tell the founder you are waiting on ${target.name}.`);
      return { text: `${target.name} answered:\n${answer}`, effect: { kind: 'chat-changed', id: target.id } };
    },
  }];
}
