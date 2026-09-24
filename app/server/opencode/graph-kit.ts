import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { coderChannel, type CoderEvent, type CoderLine } from '../../shared/coder.ts';
import { hub } from '../events.ts';
import { which } from '../which.ts';
import type { CardRef } from './cards.ts';

export type { CardRef };

// The pieces of the Graphify map that the coder needs too: where a folder's map is, how Graphify's tool server is
// started, and where map lines are written. Kept apart from the map slice so the coder slice imports no slice.

// The Graphify this app is tested with. Installed by the founder as a uv tool, never by the app.
export const PIN = '0.9.66';
export const INSTALL = `uv tool install graphifyy==${PIN}`;
export const NOT_HERE = `Graphify is not on this machine: ${INSTALL}`;
export const NO_MAP = 'This folder has no map yet: run map_folder first.';
// What the coder is told when its folder has a map. One sentence, only then.
export const GRAPH_HINT = 'This folder has a knowledge graph: use the graphify tools (query_graph, get_neighbors, shortest_path...) before reading many files.';

// The map's tools by name: offered only to a person with a coder card wired to them.
export const GRAPH_TOOLS = ['map_folder', 'ask_graph', 'affected_by'] as const;

// Where a folder's map is kept: in the app's own workspace, never in the founder's folder. Graphify writes wherever
// GRAPHIFY_OUT says, so the project stays exactly as the founder left it.
export function mapDir(workspace: string, folder: string): string {
  const name = basename(folder).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'folder';
  return join(workspace, 'graphs', `${name}-${createHash('sha1').update(resolve(folder)).digest('hex').slice(0, 10)}`, 'graphify-out');
}
export const graphJson = (workspace: string, folder: string) => join(mapDir(workspace, folder), 'graph.json');

// A program in ~/.local/bin (where uv puts its tools) or on the PATH. The app may be started from a desktop entry
// whose PATH never had ~/.local/bin in it, so that folder is looked in first. Only the environment given is read.
export function findTool(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return which(name, { env, extra: env.HOME ? [join(env.HOME, '.local/bin')] : [] });
}

// How the coder's opencode starts Graphify's own tool server for one map. graphify-mcp needs its `mcp` part: when the
// installed tool has it, it runs as it is; when it does not, uvx runs the same pinned version with that part, in uv's
// own cache, without touching the founder's install. Neither there: no tool server, and the coder simply reads files.
export function mcpCommand(graph: string, env: NodeJS.ProcessEnv = process.env): string[] | null {
  const server = findTool('graphify-mcp', env);
  if (server && hasMcpPart(server)) return [server, graph];
  const uvx = findTool('uvx', env);
  return uvx ? [uvx, '--from', `graphifyy[mcp]==${PIN}`, 'graphify-mcp', graph] : null;
}
// Whether the Python behind a uv tool's script can import `mcp`: its first line names that Python, and the package is
// a folder beside it. Looked at, never run.
export function hasMcpPart(script: string): boolean {
  try {
    const python = /^#!\s*(\S+)/.exec(readFileSync(script, 'utf8').split('\n', 1)[0])?.[1];
    if (!python) return false;
    const lib = join(dirname(dirname(python)), 'lib');
    return readdirSync(lib).some((version) => existsSync(join(lib, version, 'site-packages', 'mcp')));
  } catch { return false; }
}

// Where map lines go: the coder card's own log. The coder slice points this at the coder, so a window opened later
// still finds them; until then they go straight to the card's channel.
export const cardLog: { add(card: CardRef, line: Omit<CoderLine, 'at'>): void } = {
  add: (card, line) => hub.say(coderChannel(card.id), { line: { ...line, at: Date.now() } } satisfies CoderEvent),
};

