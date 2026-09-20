import type { Founder } from '../founder.ts';
import { text, type Tool } from './registry.ts';

// The one thing everybody knows about the person they work for. It stays in the workspace and the founder reads and
// edits every line of it, so it needs no approval; it is small, so a full profile is answered with "replace a line".
export function founderTools(founder: Founder): Tool[] {
  return [{
    name: 'note_founder',
    perTurn: 2,
    description: 'Keep one lasting line about the founder themselves, which every person here will see: how they like to be answered, what they always ask for, what they have told you twice. Not about the product, the customers or a piece of work — those go in remember. One short line. To correct a line that is already there, pass "replace" with a few words from it.',
    parameters: { type: 'object', properties: { fact: { type: 'string' }, replace: { type: 'string', description: 'A few words from the line this one replaces' } }, required: ['fact'] },
    run: async (args) => ({ text: await founder.note(text(args, 'fact', 300), typeof args.replace === 'string' ? args.replace : '') }),
  }];
}
