import type { Stage, ToolEvent } from '../../shared/model.ts';
import type { CodeTools } from '../sandbox.ts';
import type { Seams } from '../seams.ts';
import { runTool, type Tool, type ToolContext } from '../tools/registry.ts';

// A run of code is one step of a turn, so twenty calls out of it is already a lot; past that the code has to print
// what it has. One result a person reads in their reply is capped at 6,000 characters, and there can be twenty of
// these in a single step, so each is held well under that: what the code prints stays the bigger half of the reply.
export const CALL_LIMIT = 20;
export const RESULT_CHARS = 4000;
// Two tools code never reaches: itself, and a hand-over, which takes longer than the sandbox is allowed to live.
const NEVER = new Set(['run_code', 'delegate_task']);

// The person's own tools, as their code may reach them. Every call goes the way a call in a turn goes — the same
// offered list, the same `tool:before` and `tool:after` — so nothing that watches a turn is blind to what code did.
// Anything the founder has to say yes to is refused here: an approval belongs to a step they can read, not to a line
// buried in somebody's script.
export function createCodeTools(deps: { toolsFor: (stage: Stage, roomId: string) => Tool[]; seams?: Seams }) {
  return (context: ToolContext): CodeTools | null => {
    const offered = deps.toolsFor(context.stage, context.roomId).filter((tool) => !NEVER.has(tool.name));
    if (!offered.length) return null;
    const names = offered.map((tool) => tool.name);
    let made = 0;

    return {
      names,
      async call(name, args) {
        if (made >= CALL_LIMIT) return { ok: false, text: `That is ${CALL_LIMIT} tool calls from one piece of code, which is the limit. Work with what you have and print it.` };
        made += 1;
        const tool = offered.find((candidate) => candidate.name === name);
        if (!tool) return { ok: false, text: `no such tool: ${name}. From code you can call: ${names.join(', ')}.` };
        if (tool.approval) return { ok: false, text: `${name} needs the founder's yes, so it cannot run from code. Ask for it as a step of your own.` };
        const id = `code-${made}`;
        let sent = args;
        let refusal = tool.ready?.() ?? null;
        if (deps.seams) {
          const checked = await deps.seams.run('tool:before', { roomId: context.roomId, call: { id, name, args }, ...(refusal ? { refusal } : {}) });
          if (checked.call.args !== sent) sent = checked.call.args;
          refusal = refusal || checked.refusal || null;
        }
        const ran = refusal ? { text: refusal, ok: false, args: sent, effect: undefined } : await runTool(offered, name, JSON.stringify(sent), context);
        let event: ToolEvent = { id, name, args: ran.args, ok: ran.ok, result: ran.text.slice(0, RESULT_CHARS), effect: ran.effect };
        if (deps.seams) event = (await deps.seams.run('tool:after', { roomId: context.roomId, event })).event;
        // Whatever the call moved on the stage moves there now, under the run_code receipt the founder is watching.
        if (event.effect) context.report?.(event.effect);
        return { ok: !!event.ok, text: event.result ?? '' };
      },
    };
  };
}

// Said once in the turn, to whoever is offered run_code: what the tools in their code are and what they cost.
export const CODE_TOOLS_HINT = 'Inside run_code you can call your own tools: tools.call("read_file", {"path": "notes.md"}) in JavaScript, '
  + 'tools.call("read_file", {"path": "notes.md"}) in Python. It hands back the tool\'s own words, or raises what went wrong; tools.names lists what you may call. '
  + `At most ${CALL_LIMIT} calls in one run, and anything the founder has to approve has to be a step of its own, not a line in a script. `
  + 'Print what you want to see: only what the code printed comes back to you.';
