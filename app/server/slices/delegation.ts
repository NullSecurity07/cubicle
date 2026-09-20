import { CODE_TOOLS_HINT, createCodeTools } from '../delegation/codetools.ts';
import { delegationTools } from '../delegation/delegate.ts';
import type { Slice } from '../install.ts';
import { colleagueIds } from '../prompt.ts';
import { offerToolsToCode } from '../sandbox.ts';
import type { Handler } from '../seams.ts';

// Real delegation: a person hands a whole piece of work to a wired colleague and gets back what they did, and code in
// the sandbox reaches the person's own tools without the sandbox gaining a single new way out.
export default {
  name: 'delegation',
  install(deps) {
    // Both of these ask `toolsFor` only when a call arrives: the offered list is not final until every slice is in.
    offerToolsToCode(createCodeTools({ toolsFor: deps.toolsFor, seams: deps.seams }));
    // What a person needs to know about calling tools from code goes in front of them, and only when they have the
    // tool it is about.
    deps.seams.on('turn:before', (async (payload, next) => {
      const [system, ...rest] = payload.messages;
      if (system?.role !== 'system' || !/You can act with these tools:[^.]*\brun_code\b/.test(system.content)) return next(payload);
      return next({ ...payload, messages: [{ ...system, content: `${system.content}\n\n${CODE_TOOLS_HINT}` }, ...rest] });
    }) satisfies Handler<'turn:before'>);

    return {
      tools: delegationTools({
        store: deps.store, clients: deps.clients, usage: deps.usage, busy: deps.busy, seams: deps.seams,
        promptFor: deps.promptFor, toolsFor: deps.toolsFor,
      }),
      // Nobody to hand work to, nothing to describe: the same rule `ask_person` lives by.
      offer: (tools, stage, roomId) => (colleagueIds(stage, roomId).length ? tools : tools.filter((tool) => tool.name !== 'delegate_task')),
      async close() { offerToolsToCode(null); },
    };
  },
} satisfies Slice;
