// The coder card, as both sides see it: a running OpenCode session inside one project folder.

// One step in the card's log. `ask` is what somebody told the coder, `tool` a step it took (`edit src/x.ts`), `reply`
// what it said back, `diff` what the folder looks like now (`+12 −3 in 2 files`), `note` the app's own word
// (allowed, stopped, undone), `error` something that went wrong. `file` is set on a step that touched one file.
// `detail` is the end of what a step printed (a command's output, or why it failed), kept for the founder who wants to
// look; `took` is how long the step ran, in milliseconds, when opencode said both when it began and when it ended.
export type CoderLineKind = 'ask' | 'tool' | 'reply' | 'diff' | 'note' | 'error';
export type CoderLine = { kind: CoderLineKind; text: string; at: number; file?: string; by?: string; detail?: string; took?: number };

// What the coder is doing right now, while it works: whether it is thinking, each step still running (with the end of
// what a command has printed so far), the reply as it is being written, and how far along it is (which step, since
// when, how many tokens and how much money so far). It goes when the work is over; the log keeps what was finished.
export type CoderLiveTool = { id: string; tool: string; what: string; file?: string; since: number; output?: string };
export type CoderLive = {
  since: number; step: number; thinking: boolean; text: string; tools: CoderLiveTool[];
  tokens: { input: number; output: number; reasoning: number; cache: number }; cost: number;
};

// idle: nothing to do. working: the coder is on it. waiting: it asked the founder something. stopped: the last piece of
// work ended early (Stop, no progress, an error) and the card says why in its log.
export type CoderState = 'idle' | 'working' | 'waiting' | 'stopped';

// The coder asking before a step: what kind of step (bash, edit), the command or the file, and the wider pattern the
// founder may allow for good (`ls *`).
export type CoderAsk = { id: string; tool: string; what: string; always: string[]; at: number };

// What the card's channel carries: the whole log on opening (`lines`), one more step (`line`), and whatever changed of
// the rest. A field that is absent did not change; `permission: null` means the question went.
// `permission` is the question being shown; `waiting` counts the ones asked at the same time that wait behind it.
// `graph` is the folder's map as it stands after a mapping (null: gone), `mapping` whether one is being made now.
// `live` is what the coder is doing this moment (null: the work is over and nothing is live).
export type CoderEvent = { lines?: CoderLine[]; line?: CoderLine; state?: CoderState; permission?: CoderAsk | null; waiting?: number; session?: string; model?: string; graph?: GraphMark | null; mapping?: boolean; live?: CoderLive | null };
export const coderChannel = (cardId: string) => `coder:${cardId}`;

// The model picker's groups, in the order the founder reads them. `id` is `provider/model`. `provider` is said on a
// model of the founder's own keys, where one model is often sold by several.
export type CoderModel = { id: string; name: string; provider?: string };
export type CoderModels = { groups: { name: string; models: CoderModel[] }[]; default: string | null };

// One file the coder changed, with its patch, for the card opened large.
export type CoderPatch = { file: string; patch: string; additions: number; deletions: number };

// How much changed, the way the log says it: `+12 −3 in 2 files`.
export function diffLine(files: { additions: number; deletions: number }[]): string {
  const added = files.reduce((sum, one) => sum + (one.additions || 0), 0);
  const removed = files.reduce((sum, one) => sum + (one.deletions || 0), 0);
  return `+${added} −${removed} in ${files.length} file${files.length === 1 ? '' : 's'}`;
}

export const CODER_TOOLS = ['code_task', 'code_reply', 'code_stop', 'code_status'];

// The folder's map, made by Graphify from the code alone: when, and how big. Kept on the card, so it reads
// "Mapped 3 minutes ago · 412 nodes · 38 groups" without opening anything.
export type GraphMark = { at: number; nodes: number; edges: number; communities: number };
// What the card reads about its map. `report` is the start of Graphify's own report; `page` opens the drawing.
export type GraphView = { mapped: boolean; mapping: boolean; at?: number; nodes?: number; edges?: number; communities?: number; report?: string; html?: string; page?: string };
export const GRAPH_TOOLS = ['map_folder', 'ask_graph', 'affected_by'];
