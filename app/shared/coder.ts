// The coder card, as both sides see it: a running OpenCode session inside one project folder.

// One step in the card's log. `ask` is what somebody told the coder, `tool` a step it took (`edit src/x.ts`), `reply`
// what it said back, `diff` what the folder looks like now (`+12 −3 in 2 files`), `note` the app's own word
// (allowed, stopped, undone), `error` something that went wrong. `file` is set on a step that touched one file.
export type CoderLineKind = 'ask' | 'tool' | 'reply' | 'diff' | 'note' | 'error';
export type CoderLine = { kind: CoderLineKind; text: string; at: number; file?: string; by?: string };

// idle: nothing to do. working: the coder is on it. waiting: it asked the founder something. stopped: the last piece of
// work ended early (Stop, no progress, an error) and the card says why in its log.
export type CoderState = 'idle' | 'working' | 'waiting' | 'stopped';

// The coder asking before a step: what kind of step (bash, edit), the command or the file, and the wider pattern the
// founder may allow for good (`ls *`).
export type CoderAsk = { id: string; tool: string; what: string; always: string[]; at: number };

// What the card's channel carries: the whole log on opening (`lines`), one more step (`line`), and whatever changed of
// the rest. A field that is absent did not change; `permission: null` means the question went.
export type CoderEvent = { lines?: CoderLine[]; line?: CoderLine; state?: CoderState; permission?: CoderAsk | null; session?: string; model?: string };
export const coderChannel = (cardId: string) => `coder:${cardId}`;

// The model picker's groups, in the order the founder reads them. `id` is `provider/model`.
export type CoderModel = { id: string; name: string };
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
