// The plain model both sides agree on. The client maps it to React Flow; the server stores it.
export type Box = { x: number; y: number; w: number; h: number };
// `model` is a name from server/models.json; absent or 'auto' lets the server choose.
export type Room = Box & { id: string; name: string; role: string; accent: string; brief: string; model?: string };
// `pinned` makes a doc company-wide: every person reads it, wired or not. Writing it still needs a wire.
export type Doc = Box & { id: string; title: string; pinned?: boolean };
// Resource cards that are not docs. `browser` is a live browser a wired person can drive; `project` is a code folder a wired person may hand to a coding agent; `board` holds tasks that wired people may propose and the founder runs.
// `headed` shows the card's Chrome as a real window, for the founder to sign in or pass a human check by hand.
export type Card = Box & { id: string } & ({ kind: 'browser'; headed?: boolean } | { kind: 'project'; path: string } | { kind: 'board' });
export const COLUMNS = ['proposed', 'todo', 'doing', 'review', 'done'] as const;
export type Column = (typeof COLUMNS)[number];
// When a task repeats, in the founder's local time. `weekday` (0 = Sunday) is used by 'week' only.
export type Repeat = { every: 'day' | 'weekdays' | 'week'; time: string; weekday?: number };
// One background run of a task. `approval` is the outward step waiting for the founder while `state` is 'waiting'.
export type TaskRun = {
  state: 'running' | 'waiting' | 'done' | 'failed' | 'stopped'; startedAt: number; finishedAt?: number;
  log: string[]; result?: string; approval?: ToolEvent; provider?: string; model?: string; usage?: Usage;
};
export type Task = {
  id: string; title: string; detail: string; column: Column; createdAt: number;
  assignee?: string; proposedBy?: string; repeat?: Repeat; nextRun?: number; missed?: boolean; run?: TaskRun;
};
// What a board streams to its card: the tasks after every change, and stage effects from runs that the client must mirror.
export type BoardEvent = { tasks: Task[] } | { effect: ToolEffect; roomId: string };

export const isHeaded = (card?: Card) => card?.kind === 'browser' && !!card.headed;
export type Wire = { id: string; from: string; fromHandle: string; to: string; toHandle: string };
export type Stage = { rooms: Room[]; docs: Doc[]; wires: Wire[]; cards?: Card[] };
export type Usage = { input: number; output: number };
// What a tool run changed on the stage, for the client to mirror.
export type ToolEffect = { kind: 'doc-changed'; id: string } | { kind: 'doc-created'; id: string; title: string } | { kind: 'browser-moved'; id: string } | { kind: 'project-progress'; id: string; line: string } | { kind: 'chat-changed'; id: string } | { kind: 'memory-changed'; id: string };
// One tool call inside a reply. `ok` is absent while the tool is still running; `waiting` means it needs the founder's yes first.
export type ToolEvent = { id: string; name: string; args: Record<string, unknown>; waiting?: boolean; question?: string; ok?: boolean; result?: string; effect?: ToolEffect };
export type ChatMessage = {
  id: string; role: 'user' | 'assistant'; text: string; at: number;
  // Set when the words came from a colleague's consult, not from the founder: the colleague's name.
  from?: string;
  provider?: string; model?: string; usage?: Usage; tools?: ToolEvent[]; stopped?: boolean;
};
export type ChatEvent = { token: string } | { tool: ToolEvent } | { notice: string } | { done: true; message: ChatMessage } | { error: string };
// One configured model as the client sees it: `left` is the share of today's free quota still there, 0 to 1.
export type ModelInfo = { name: string; model: string; ready: boolean; left: number; requests: number; tokens: number };

export const newMessageId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const STANCE =
  'You work for the founder. You boost the founder; you do not run the company. Be concise. Offer options when '
  + 'there is a real choice. Ask when the request is unclear. Act only through your tools, and never claim an action that a tool result '
  + 'does not confirm. '
  + 'You know about the founder, the product, the customers and the numbers only what this chat and the connected '
  + 'documents say. Do not invent such facts; when you need one, ask for it.';

export const seedStage: Stage = {
  rooms: [
    { id: 'marketing', name: 'Maya', role: 'Marketing', accent: '#ee8a72', brief: 'You are the marketing lead: positioning, copy, launch, audience.', x: 0, y: 0, w: 380, h: 440 },
    { id: 'build', name: 'Dev', role: 'Build', accent: '#4e8cff', brief: 'You are the engineering lead: architecture, scope, build order, technical risk.', x: 0, y: 500, w: 380, h: 440 },
  ],
  docs: [
    { id: 'brand-doc', title: 'Brand doc', x: 520, y: 40, w: 340, h: 300 },
    { id: 'company-brief', title: 'Company brief', pinned: true, x: 520, y: 400, w: 340, h: 300 },
  ],
  wires: [{ id: 'marketing-brand-doc', from: 'marketing', fromHandle: 'r', to: 'brand-doc', toHandle: 'l' }],
  cards: [],
};

export const seedDocs: Record<string, string> = {
  'brand-doc': '# Brand\n\nWhat we are building:\n\nWho it is for:\n\nVoice:\n',
  'company-brief': '# Company brief\n\nEveryone on the stage reads this.\n\nWhat the company does:\n\nStage and goals this quarter:\n\nHow we work:\n',
};
