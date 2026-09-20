import { readdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Stage } from '../shared/model.ts';
import type { createApprovals } from './approvals.ts';
import type { AttentionBook } from './attention.ts';
import type { Boards } from './boards.ts';
import type { Decisions } from './decisions.ts';
import type { Founder } from './founder.ts';
import type { Own } from './guard.ts';
import type { createMemory } from './memory.ts';
import type { ModelMessage } from './prompt.ts';
import type { ModelClient } from './providers.ts';
import type { createRecall } from './recall.ts';
import type { createRuns, Notify } from './runs.ts';
import type { Seams } from './seams.ts';
import type { Skills } from './skills.ts';
import type { Store } from './store.ts';
import type { Tool } from './tools/registry.ts';
import type { UsageBook } from './usage.ts';

export type Runs = ReturnType<typeof createRuns>;

// Everything a feature dropped into `server/slices` may reach for. All of it is handed over by reference, so a slice
// works on the same workspace, the same people and the same books as everything that was here before it.
export type Deps = {
  workspace: string; root: string; fake: boolean;
  store: Store; seams: Seams; clients: ModelClient[]; usage: UsageBook;
  approvals: ReturnType<typeof createApprovals>; attention: AttentionBook; boards: Boards;
  recall: ReturnType<typeof createRecall>; skills: Skills; founder: Founder; memory: ReturnType<typeof createMemory>; decisions: Decisions;
  busy: Set<string>; notify: Notify;
  promptFor: (stage: Stage, roomId: string, toolNames: string[], fresh?: boolean) => Promise<ModelMessage[]>;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  body: (req: IncomingMessage) => Promise<any>;
  // The ports this launch owns and the token a script must hold: a slice that answers a path needs this to tell the
  // founder's own page from anything else, the way `guard` does.
  own: Own;
  // Late-bound on purpose — see `lateRuns` below.
  runs: Runs;
  // What one person is offered for one turn, after every slice has had its say. Late-bound for the same reason: the
  // list is only final once every slice is in. Call it from a tool, a route or a tick, never while installing.
  toolsFor: (stage: Stage, roomId: string) => Tool[];
};

// What a slice gives back. Everything is optional: a slice may only add a tool, or only answer a path.
// `route` returns true when it has answered the request; false leaves it to whoever comes next.
// `offer` narrows which of the installed tools one person is offered for one turn. Several `offer`s compose, each
// narrowing what the one before it left, and none of them may add a tool: a person is never offered something that
// was never installed.
export type Installed = {
  tools?: Tool[];
  route?(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
  tick?(): Promise<void>;
  offer?(tools: Tool[], stage: Stage, roomId: string): Tool[];
  close?(): Promise<void>;
};

// One file in `server/slices`, default-exported. `order` decides who installs first and, with it, who narrows first
// and whose route is tried first; everything without one sits at 100 and sorts by file name.
export type Slice = { name: string; order?: number; install(deps: Deps): Installed | Promise<Installed> };

const ORDER = 100;

// The knot to untie: a slice may want to start a task, but the runner is built from the final tool list, and that
// list is not final until every slice has added its own. So the runner is handed over as this stand-in, made before
// the slices are installed and filled the moment `createRuns` returns. Nothing calls it while installing — by then
// there is no board task to start — and every call after that goes straight through to the real one.
export function lateRuns() {
  let real: Runs | null = null;
  const ready = () => {
    if (!real) throw new Error('the runner is not ready yet: start a task from a route, a tick or a tool, not while installing');
    return real;
  };
  // `async` so a call made too early comes back as a refusal the caller can catch, not a throw out of nowhere.
  const runs: Runs = {
    start: async (boardId, taskId, by) => ready().start(boardId, taskId, by),
    stop: (taskId) => ready().stop(taskId),
    note: async (roomId, text) => ready().note(roomId, text),
    tick: async () => ready().tick(),
  };
  return { runs, fill: (runner: Runs) => { real = runner; } };
}

// Every slice in a folder, in the order they will run. A file that will not import is named on the console and left
// out: a broken extra must never stop the app from starting.
export async function loadSlices(dir: string, onError: (name: string, error: Error) => void = (name, error) => console.error(`slice ${name}: ${error.message}`)): Promise<Slice[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const found: Slice[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file.endsWith('.d.ts')) continue;
    try {
      const slice = (await import(pathToFileURL(resolve(dir, file)).href)).default as Slice | undefined;
      if (!slice?.install) throw new Error('no slice is exported as `default`');
      found.push({ ...slice, name: slice.name || file.replace(/\.ts$/, '') });
    } catch (error) { onError(file.replace(/\.ts$/, ''), error as Error); }
  }
  return found.sort((one, other) => (one.order ?? ORDER) - (other.order ?? ORDER) || one.name.localeCompare(other.name));
}

// Installs them and gives back the one handle the app holds: their tools, the way they narrow a turn, their routes,
// their share of the half-minute tick, and the way out. A slice that throws on the way in is named and left out.
export async function installSlices(slices: Slice[], deps: Deps, onError: (name: string, error: Error) => void = (name, error) => console.error(`slice ${name}: ${error.message}`)) {
  const parts: { name: string; part: Installed }[] = [];
  for (const slice of slices) {
    try { parts.push({ name: slice.name, part: await slice.install(deps) }); }
    catch (error) { onError(slice.name, error as Error); }
  }

  return {
    names: parts.map((one) => one.name),
    tools: parts.flatMap((one) => one.part.tools ?? []),
    // Filtering the list we already have is what keeps an `offer` honest: whatever it hands back, only tools that
    // were installed survive. One that throws narrows nothing, because a broken extra must never cost a turn.
    offer(all: Tool[], stage: Stage, roomId: string): Tool[] {
      let left = all;
      for (const { name, part } of parts) {
        if (!part.offer) continue;
        try { const kept = new Set(part.offer(left, stage, roomId)); left = left.filter((tool) => kept.has(tool)); }
        catch (error) { onError(name, error as Error); }
      }
      return left;
    },
    // First slice to answer wins. A route that throws is left to the server's own catch, the same as a built-in one.
    async route(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
      for (const { part } of parts) if (part.route && await part.route(req, res, path)) return true;
      return false;
    },
    async tick(): Promise<void> {
      for (const { name, part } of parts) if (part.tick) await part.tick().catch((error: Error) => onError(name, error));
    },
    async close(): Promise<void> {
      for (const { name, part } of parts) if (part.close) await part.close().catch((error: Error) => onError(name, error));
    },
  };
}
