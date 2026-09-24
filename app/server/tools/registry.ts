import type { Stage, ToolEffect, ToolEvent } from '../../shared/model.ts';
import type { Answer } from '../approvals.ts';
import type { ToolSpec } from '../providers.ts';
import type { Store } from '../store.ts';

// What a tool may see and touch: the stage as the turn began, whose turn it is, and the workspace.
// `granted` holds docs this person made during the turn, which no wire covers yet.
// `calls` counts how often each tool ran this turn, for tools that cap it.
// `report` shows progress while a long tool runs; `signal` ends it when the founder stops the turn.
// `approve` is the turn's own way of putting a question to the founder, for the one tool that runs a turn inside
// itself: what a colleague wants to send still goes out under the founder's yes, asked on the asker's path.
// `query` is what set this turn off in the founder's own words, for a tool that has to tell what the founder asked
// for from what the model made up — a year in a search query is the founder's when they typed it and nobody else's.
export type ToolContext = { stage: Stage; roomId: string; store: Store; granted: Map<string, string>; calls?: Map<string, number>; query?: string; report?: (effect: ToolEffect) => void; signal?: AbortSignal; approve?: (event: ToolEvent, signal?: AbortSignal) => Promise<Answer> };
// The person a tool is running for: the room whose turn this is.
export const speaker = (context: Pick<ToolContext, 'stage' | 'roomId'>) => context.stage.rooms.find((room) => room.id === context.roomId);
type ToolResult = { text: string; effect?: ToolEffect };
// `perTurn` stops a person from looping on a costly tool: past it, the tool answers with a nudge to use what it has.
// `approval` makes the turn wait for the founder's yes. `ready` returns why the tool cannot work yet, before anyone is asked.
// `approval` may also be a function, for tools where only some calls reach outward: it returns the question to put to the founder, or null.
export type Tool = ToolSpec & { perTurn?: number; approval?: boolean | ((args: Record<string, unknown>, context: ToolContext) => Promise<string | null>); ready?: () => string | null; run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> };

export const text = (args: Record<string, unknown>, key: string, max = 200_000) => {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${key}" is missing`);
  if (value.length > max) throw new Error(`"${key}" is too long (${value.length} characters, limit ${max})`);
  return value;
};

// Runs one call and never throws: a tool's failure is something the person reads and reacts to.
export async function runTool(tools: Tool[], name: string, rawArgs: string, context: ToolContext): Promise<ToolResult & { ok: boolean; args: Record<string, unknown> }> {
  let args: Record<string, unknown> = {};
  try {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    const calls = (context.calls ??= new Map());
    const count = (calls.get(name) ?? 0) + 1;
    calls.set(name, count);
    if (tool.perTurn && count > tool.perTurn) throw new Error(`${name} already ran ${tool.perTurn} times this turn. Work with what you have, or tell the founder what is still missing.`);
    return { ...(await tool.run(args, context)), ok: true, args };
  } catch (error) {
    return { text: `Failed: ${(error as Error).message}`, ok: false, args };
  }
}
