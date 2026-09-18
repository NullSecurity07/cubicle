import { colleagueIds } from '../prompt.ts';
import { text, type Tool, type ToolContext } from './registry.ts';

// Puts a question to a colleague and returns their answer. The server supplies it, because it needs the model and both chats.
export type Consult = (input: { fromRoomId: string; toRoomId: string; question: string; signal?: AbortSignal }) => Promise<string>;

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
      const answer = await consult({ fromRoomId: context.roomId, toRoomId: target.id, question: text(args, 'question', 4000), signal: context.signal });
      return { text: `${target.name} answered:\n${answer}`, effect: { kind: 'chat-changed', id: target.id } };
    },
  }];
}
