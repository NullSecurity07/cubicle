import type { createMemory } from '../memory.ts';
import { text, type Tool } from './registry.ts';

// A person's own notebook. Nothing leaves the workspace, so it needs no approval; the founder can read and edit every line.
export function memoryTools(memory: ReturnType<typeof createMemory>): Tool[] {
  return [{
    name: 'remember',
    perTurn: 5,
    description: 'Keep one lasting fact in your notes: a decision, a preference of the founder, a number, a name. One short line. You will see your notes in every later conversation. Do not store what a connected document already says.',
    parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
    run: async (args, context) => ({ text: await memory.remember(context.roomId, text(args, 'fact', 400)), effect: { kind: 'memory-changed', id: context.roomId } }),
  }];
}
