import { shortDay } from '../clock.ts';
import type { Decisions } from '../decisions.ts';
import { text, type Tool } from './registry.ts';

// People lay a decision out; the founder makes it. Nothing here can mark anything as decided.
export function decisionTools(decisions: Decisions): Tool[] {
  return [
    {
      name: 'propose_decision',
      perTurn: 2,
      description: 'Put a real choice in front of the founder: what it is about, two or more options, and which one you would pick and why. It waits in the founder\'s list; only the founder decides. Use it when the work is blocked on a choice that is the founder\'s to make, not for small things you can simply ask in your reply.',
      parameters: { type: 'object', properties: {
        title: { type: 'string', description: 'The choice in a few words' },
        context: { type: 'string', description: 'What led to this and what depends on it, with the facts you have' },
        options: { type: 'array', items: { type: 'string' }, description: 'Two to five options, each one line' },
        recommendation: { type: 'string', description: 'The option you would pick, and why, in a line or two' },
      }, required: ['title', 'context', 'options'] },
      async run(args, context) {
        const me = context.stage.rooms.find((room) => room.id === context.roomId)!;
        const made = await decisions.propose({ title: text(args, 'title', 160), context: text(args, 'context', 4000), options: args.options, recommendation: args.recommendation, proposedBy: me.name });
        return { text: `Proposed "${made.title}" with ${made.options.length} options. It waits for the founder; do not act as if it were decided.` };
      },
    },
    {
      name: 'read_decision',
      description: 'Read one of the founder\'s decisions in full: the day it was made, the options that were on the table, what was chosen and why. Name it by its title. An old decision was made on what was true then, so check its day against today\'s before you lean on it.',
      parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      async run(args) {
        const wanted = text(args, 'title', 160).trim().toLowerCase();
        const all = await decisions.list();
        const found = all.find((one) => one.title.toLowerCase() === wanted) ?? all.find((one) => one.title.toLowerCase().includes(wanted) || one.id === wanted);
        if (!found) throw new Error(`no decision called "${args.title}". Decisions so far: ${all.map((one) => `"${one.title}"`).join(', ') || 'none'}`);
        return { text: [
          // When it was decided matters as much as what was: a choice made on last spring's numbers is not this week's.
          `# ${found.title}`, found.status === 'proposed' ? `NOT DECIDED YET. Proposed by ${found.proposedBy ?? 'someone'} on ${shortDay(found.at)}; the founder has not chosen.` : `Decided on ${shortDay(found.decidedAt ?? found.at)}: ${found.chosen}`,
          found.why ? `Why: ${found.why}` : '', found.effect ? `Expected effect: ${found.effect}` : '', found.review ? `To be looked at again on ${found.review}.` : '',
          found.context ? `Context: ${found.context}` : '', found.options.length ? `Options that were on the table:\n${found.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}` : '',
        ].filter(Boolean).join('\n\n') };
      },
    },
  ];
}
