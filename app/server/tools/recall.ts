import { mayRecall, type createRecall } from '../recall.ts';
import { text, type Tool } from './registry.ts';

const WHERE: Record<string, string> = { doc: 'Doc', chat: 'Conversation', memory: 'Your memory', decision: 'Decision', file: 'Shared file', link: 'Web page' };

// Looking things up by meaning, inside the same limits as everything else: a person finds only what they may read.
export function recallTools(recall: ReturnType<typeof createRecall>): Tool[] {
  return [{
    name: 'recall',
    perTurn: 3,
    description: 'Search by meaning through what you are allowed to read: your whole conversation with the founder (also what was said long ago and is no longer in front of you), your memory, the documents connected to you, the founder\'s decisions, shared files and connected web pages. Use it when the founder refers to something you cannot see in this conversation, or before you say you do not know a fact about the company. Ask in a full sentence.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What you are looking for, as a question or a sentence' } }, required: ['query'] },
    async run(args, context) {
      // The question just asked is already saved in this room and would always match itself best: leave it out.
      const asked = (await context.store.readChat(context.roomId).catch(() => [])).findLast((message) => message.role === 'user')?.text.trim().slice(0, 120);
      const may = mayRecall(context.stage, context.roomId);
      const hits = await recall.search(text(args, 'query', 400), { allow: (piece) => may(piece) && !(asked && piece.kind === 'chat' && piece.text.includes(asked) && piece.text.length < asked.length + 400) });
      if (!hits.length) return { text: 'Nothing found. It may never have been written down: ask the founder rather than guess.' };
      const note = recall.mode() === 'words' ? 'Matched by words only (the meaning model is not ready yet).\n\n' : '';
      return { text: `${note}${hits.map((hit) => `[${WHERE[hit.kind]}: ${hit.title}]\n${hit.text}`).join('\n\n---\n\n')}` };
    },
  }];
}
