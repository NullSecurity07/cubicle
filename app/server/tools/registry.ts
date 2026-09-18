import type { Stage, ToolEffect } from '../../shared/model.ts';
import type { ToolSpec } from '../providers.ts';
import type { Store } from '../store.ts';

// What a tool may see and touch: the stage as the turn began, whose turn it is, and the workspace.
// `granted` holds docs this person made during the turn, which no wire covers yet.
// `calls` counts how often each tool ran this turn, for tools that cap it.
export type ToolContext = { stage: Stage; roomId: string; store: Store; granted: Map<string, string>; calls?: Map<string, number> };
export type ToolResult = { text: string; effect?: ToolEffect };
// `perTurn` stops a person from looping on a costly tool: past it, the tool answers with a nudge to use what it has.
export type Tool = ToolSpec & { perTurn?: number; run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> };

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
