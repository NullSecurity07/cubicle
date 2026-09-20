// The plain model both sides agree on. The client maps it to React Flow; the server stores it.
export type Box = { x: number; y: number; w: number; h: number };
// `model` is a name from server/models.json; absent or 'auto' lets the server choose.
export type Room = Box & { id: string; name: string; role: string; accent: string; brief: string; model?: string };
// `pinned` makes a doc company-wide: every person reads it, wired or not. Writing it still needs a wire.
export type Doc = Box & { id: string; title: string; pinned?: boolean };
// Resource cards that are not docs. `browser` is a live browser a wired person can drive; `project` is a code folder a wired person may hand to a coding agent; `board` holds tasks that wired people may propose and the founder runs.
// `headed` shows the card's Chrome as a real window, for the founder to sign in or pass a human check by hand.
export type Card = Box & { id: string } & ({ kind: 'browser'; headed?: boolean } | { kind: 'project'; path: string } | { kind: 'board' }
  // Small things that are context when wired to a person: a note's words, a picture (for models that can see), a web page's text.
  // A picture card starts empty — the founder drops a file on it, or wires it to the studio whose work it shows.
  | { kind: 'note'; text: string; color?: string } | { kind: 'image'; path?: string } | { kind: 'link'; url: string; title?: string }
  // Studios: the founder, or a wired person, says what they want and the server makes it. Only what was asked for lives
  // on the card; what came out lives in a sidecar the server owns.
  | { kind: 'imagegen'; prompt?: string; shape?: Shape } | { kind: 'voicegen'; text?: string; voice?: string }
  // `silent` rather than a narrate flag: `fromFlow` drops a false, so a switch the founder turned off has to be the true one.
  // The switches that can be on, off *or* whatever the purpose says are words rather than flags, for the same reason.
  | { kind: 'videogen'; brief?: string; format?: Shape; look?: VideoLook; silent?: boolean;
    purpose?: string; length?: number; pace?: 'calm' | 'punchy'; music?: string; voice?: string;
    captions?: Switch; sfx?: Switch; ai?: Switch; address?: string; person?: Switch });
// The six looks a film can wear. `clean` and `sketch` are the originals, `brand` takes the wired product's colours,
// and `creator`, `editorial` and `neon` are the three a motion designer reaches for.
export type VideoLook = 'clean' | 'creator' | 'editorial' | 'neon' | 'sketch' | 'brand';
export type Switch = 'on' | 'off';
export const SHAPES = ['square', 'wide', 'tall'] as const;
export type Shape = (typeof SHAPES)[number];
export const MEDIA_KINDS = ['imagegen', 'voicegen', 'videogen'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
// One thing a studio made. `prompt` is what was asked for: a picture prompt, the words to say, a video brief.
// `music` credits the bed a film was made with, because a track's terms travel with the file it is in.
export type MediaResult = { path: string; prompt: string; at: number; poster?: string; music?: MediaCredit };
export type MediaCredit = { title: string; by: string; licence: string; source: string };
// Something the founder dropped on a studio card for it to build with: their own footage, a photograph, a music track.
// `name` is what a storyboard calls it in `asset`; `path` is where it really is in the shared files.
export type MediaAsset = { name: string; path: string; kind: 'video' | 'image' | 'audio'; at: number; bytes: number; seconds?: number; thumb?: string };
// A studio card's sidecar, which the server owns: how the job in flight is going, the last dozen results, newest
// first, and whatever the founder dropped on the card for it to work with.
export type Media = { state: 'idle' | 'making' | 'failed'; log: string[]; problem?: string; results: MediaResult[]; assets?: MediaAsset[] };
// What a studio's feed carries: a line while something is being made, and a nudge after every change.
export type MediaEvent = { id: string; line: string } | { id: string; changed: true };
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

// One thing waiting for the founder. `lapsed`: the approval belonged to a turn that ended with the app; it can only be asked again.
export type AttentionKind = 'approval' | 'run-approval' | 'proposed-task' | 'proposed-decision' | 'run-failed' | 'missed' | 'review-due';
export type Attention = {
  id: string; kind: AttentionKind; title: string; detail?: string; at: number; who?: string;
  roomId?: string; cardId?: string; taskId?: string; decisionId?: string; event?: ToolEvent; lapsed?: boolean;
};

// One conversation as the messages view lists it: a person's room, or the consults between two people.
// A consult thread carries its messages (they are picked out of a room's chat); a room thread is read from the room.
export type Thread = {
  id: string; kind: 'room' | 'consult'; title: string; accents: string[]; count: number; live?: boolean;
  last?: { text: string; at: number; by: string }; hit?: string; messages?: ChatMessage[];
};

// One decision of the founder's, kept as a markdown file. People propose (context, options, what they would pick);
// only the founder decides. `review` is a date (YYYY-MM-DD) on which it comes back to be looked at again.
export type Decision = {
  id: string; title: string; status: 'proposed' | 'decided'; proposedBy?: string; at: number; decidedAt?: number;
  context: string; options: string[]; recommendation?: string; chosen?: string; why?: string; effect?: string; review?: string;
};

// One thing recall found. `kind` and `id` say where it lives (a doc, a room's chat or memory, a decision, a shared file,
// a link card's page); `roomId` is set for what belongs to one person.
export type Hit = { kind: 'doc' | 'chat' | 'memory' | 'decision' | 'file' | 'link'; id: string; title: string; text: string; score: number; roomId?: string; at?: number };

// One step of the first-run list. `done` is worked out from what the workspace holds, never from what was clicked.
export type Mission = { id: string; title: string; tip: string; done: boolean };

export const isHeaded = (card?: Card) => card?.kind === 'browser' && !!card.headed;

// The image studio feeding a picture card, when the founder joined the two up and left the card empty. A picture
// card wired to a studio is somebody saying "show me what that draws", so it shows the studio's newest picture —
// on the stage, to a person who can see, and to a film. Both ends of this live in one place so the card, the
// person and the film can never disagree about what is in it.
export function studioBehind(stage: { wires?: Wire[]; cards?: Card[] }, cardId: string): string | null {
  const ends = new Set((stage.wires ?? []).flatMap((wire) => (wire.from === cardId ? [wire.to] : wire.to === cardId ? [wire.from] : [])));
  return (stage.cards ?? []).find((card) => card.kind === 'imagegen' && ends.has(card.id))?.id ?? null;
}
export type Wire = { id: string; from: string; fromHandle: string; to: string; toHandle: string };
export type Stage = { rooms: Room[]; docs: Doc[]; wires: Wire[]; cards?: Card[] };
export type Usage = { input: number; output: number };
// What a tool run changed on the stage, for the client to mirror.
export type ToolEffect = { kind: 'doc-changed'; id: string } | { kind: 'doc-created'; id: string; title: string } | { kind: 'browser-moved'; id: string } | { kind: 'project-progress'; id: string; line: string } | { kind: 'chat-changed'; id: string } | { kind: 'memory-changed'; id: string }
  | { kind: 'media-progress'; id: string; line: string } | { kind: 'media-made'; id: string };
// One tool call inside a reply. `ok` is absent while the tool is still running; `waiting` means it needs the founder's yes first.
export type ToolEvent = { id: string; name: string; args: Record<string, unknown>; waiting?: boolean; question?: string; ok?: boolean; result?: string; effect?: ToolEffect };
// A file the founder attached to a message; it lives in the shared files folder.
export type Attachment = { path: string; type: string; size: number };
export type ChatMessage = {
  id: string; role: 'user' | 'assistant'; text: string; at: number;
  // Set when the words came from a colleague's consult, not from the founder: the colleague's name.
  from?: string;
  provider?: string; model?: string; usage?: Usage; tools?: ToolEvent[]; stopped?: boolean; attachments?: Attachment[];
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
