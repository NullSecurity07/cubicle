import type { AppPreset } from './apps.ts';
import type { CoderAsk, GraphMark } from './coder.ts';
import type { Gender } from './voices.ts';

// The plain model both sides agree on. The client maps it to React Flow; the server stores it.
export type Box = { x: number; y: number; w: number; h: number };
// `model` is a name from server/models.json; absent or 'auto' lets the server choose.
// `gender` and `voice` are how this person sounds. Both are absent on a stage saved before people had voices of
// their own, and `shared/voices.ts` then works them out from the name and the id until one is written down here.
// `framework` is there when this person landed as part of a saved team: which framework they came from and which of
// its people they are. It is what lets their side panel say what they were written from and what they scored on the
// founder's own test cases, and it is the only thing on the stage that points back at a framework.
export type Room = Box & {
  id: string; name: string; role: string; accent: string; brief: string;
  model?: string; gender?: Gender; voice?: string; framework?: { id: string; key: string };
};
// `pinned` makes a doc company-wide: every person reads it, wired or not. Writing it still needs a wire.
export type Doc = Box & { id: string; title: string; pinned?: boolean };
// Resource cards that are not docs. `browser` is a live browser a wired person can drive; `project` is the coder card, a running OpenCode in one code folder that the founder or a wired person drives; `board` holds tasks that wired people may propose and the founder runs.
// A coder card keeps the `model` the founder picked (`provider/model`, absent for the default) and the `session` it is in, so the same conversation carries on after a restart.
// `headed` shows the card's Chrome as a real window, for the founder to sign in or pass a human check by hand.
// `app` makes the card a named app the founder is signed in to, such as LinkedIn; a plain browser card has none.
export type Card = Box & { id: string } & ({ kind: 'browser'; headed?: boolean; app?: AppPreset } | { kind: 'project'; path: string; model?: string; session?: string; graph?: GraphMark } | { kind: 'board' }
  // Small things that are context when wired to a person: a note's words, a picture (for models that can see), a web page's text.
  // A picture card starts empty — the founder drops a file on it, or wires it to the studio whose work it shows.
  | { kind: 'note'; text: string; color?: string } | { kind: 'image'; path?: string } | { kind: 'link'; url: string; title?: string }
  // A note out of the founder's library. The words live in `<workspace>/library`; the card only says which note it is,
  // and a person wired to it is given the passages of that note which answer the question in front of them.
  | { kind: 'library'; noteId: string }
  // A website the founder trusts, with a line on what it holds. Every person knows the list and searches inside one
  // with search_source when the line fits the question.
  | { kind: 'source'; url: string; about: string; title?: string }
  // The founder's leads, a light CRM. The leads themselves live in `<workspace>/leads/<id>.json`, owned by the server.
  | { kind: 'leads' }
  // Studios: the founder, or a wired person, says what they want and the server makes it. Only what was asked for lives
  // on the card; what came out lives in a sidecar the server owns.
  | { kind: 'imagegen'; prompt?: string; shape?: Shape }
  // `engine` is the founder's own switch: left unset it is Kokoro. OmniVoice says each line in a voice `design`ed from
  // a few words, or in the voice of the recording named in `clone`, in `language` when one is set.
  | { kind: 'voicegen'; text?: string; voice?: string; engine?: VoiceEngine; design?: string; clone?: string; language?: string }
  // `silent` rather than a narrate flag: `fromFlow` drops a false, so a switch the founder turned off has to be the true one.
  // The switches that can be on, off *or* whatever the purpose says are words rather than flags, for the same reason.
  | { kind: 'videogen'; brief?: string; format?: Shape; look?: VideoLook; silent?: boolean;
    purpose?: string; length?: number; pace?: 'calm' | 'punchy'; music?: string; voice?: string;
    // A film is read by Kokoro unless the founder sets this. OmniVoice's weights are non-commercial, and the film says so.
    engine?: VoiceEngine; design?: string;
    captions?: Switch; sfx?: Switch; ai?: Switch; address?: string; person?: Switch;
    // Left unset it is the full film. 'draft' is the quick one to look at first: fewer, smaller pictures and nothing moving.
    speed?: 'draft' });
// The seven looks a film can wear. `clean` and `sketch` are the originals, `brand` takes the wired product's
// colours, `creator`, `editorial` and `neon` are the three a motion designer reaches for, and `documentary` is the
// long-form one: a serif on a letterboxed frame, held shots and a measured grade that is the format rather than a
// filter over it.
export type VideoLook = 'clean' | 'creator' | 'editorial' | 'neon' | 'documentary' | 'sketch' | 'brand';
export type Switch = 'on' | 'off';
export const VOICE_ENGINES = ['kokoro', 'omnivoice'] as const;
export type VoiceEngine = (typeof VOICE_ENGINES)[number];
// The words that go wherever OmniVoice does: beside its entry in the picker, on its files, and in the log. They live
// here because the card and the server both say them.
export const NONCOMMERCIAL = 'not for commercial use (its weights are CC-BY-NC)';
export const OMNI_PICKER_LINE = `clones and designs voices, 600 languages, ${NONCOMMERCIAL}`;
export const PERMISSION_LINE = 'Only clone a voice you have permission to use.';
export const SHAPES = ['square', 'wide', 'tall'] as const;
export type Shape = (typeof SHAPES)[number];
export const MEDIA_KINDS = ['imagegen', 'voicegen', 'videogen'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
// One thing a studio made. `prompt` is what was asked for: a picture prompt, the words to say, a video brief.
// `music` credits the bed a film was made with, because a track's terms travel with the file it is in.
// `noncommercial` is set when the file's own licence forbids selling it, and `credits` is where the words of that
// licence were written beside it.
export type MediaResult = { path: string; prompt: string; at: number; poster?: string; music?: MediaCredit; by?: string; noncommercial?: true; credits?: string; mlt?: string };
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
// When a task repeats, in the founder's local time. The founder types this in words; `shared/automation.ts` reads the
// sentence and works out the next moment. The first three shapes are the ones that were saved before words were
// allowed, and they still load and run untouched: 'week' uses `weekday` (0 = Sunday), 'days' several of them.
export type Repeat =
  | { every: 'day' | 'weekdays' | 'week'; time: string; weekday?: number }
  | { every: 'days'; time: string; weekdays: number[] }
  | { every: 'minutes'; minutes: number }
  | { every: 'once'; at: number };
// Work that is a script rather than a person: it runs in the same sandbox `run_code` uses, and no model is called.
export type TaskScript = { language: 'javascript' | 'python'; code: string };
// One background run of a task. `approval` is the outward step waiting for the founder while `state` is 'waiting';
// 'blocked' is a run that never started, because something it needs was missing and nothing should be spent finding out.
export type TaskRun = {
  state: 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'blocked'; startedAt: number; finishedAt?: number;
  log: string[]; result?: string; approval?: ToolEvent; provider?: string; model?: string; usage?: Usage;
};
export type Task = {
  id: string; title: string; detail: string; column: Column; createdAt: number;
  assignee?: string; proposedBy?: string; repeat?: Repeat; nextRun?: number; missed?: boolean; run?: TaskRun;
  // What the board does on its own. `onMissed` is this task's answer to a run that fell due while the app was closed;
  // `skill` is one from the playbook to put in front of the work; `after` is the task this one waits for, and `from`
  // is what that task came back with, waiting here until this one starts; `fails` counts failures in a row.
  // `from.at` is when that earlier run finished, so "what changed since then" has a boundary; a board saved before
  // this was carried across has none, and then nothing is said about when.
  script?: TaskScript; skill?: string; onMissed?: 'once' | 'skip'; after?: string;
  from?: { task: string; title: string; result: string; at?: number }; fails?: number;
};
// What a board streams to its card: the tasks after every change, and stage effects from runs that the client must mirror.
export type BoardEvent = { tasks: Task[] } | { effect: ToolEffect; roomId: string };

// One thing waiting for the founder. `lapsed`: the approval belonged to a turn that ended with the app; it can only be asked again.
export type AttentionKind = 'approval' | 'run-approval' | 'proposed-task' | 'proposed-decision' | 'run-failed' | 'missed' | 'review-due' | 'proposed-source' | 'page-changed';
export type Attention = {
  id: string; kind: AttentionKind; title: string; detail?: string; at: number; who?: string;
  roomId?: string; cardId?: string; taskId?: string; decisionId?: string; event?: ToolEvent; lapsed?: boolean;
  // A proposed source: which proposal, the site and the line on what it holds, for the founder to add as it is.
  sourceId?: string; url?: string; about?: string;
  // A coder's question: what it wants to do, for the founder to allow once, for good, or not at all.
  coder?: CoderAsk;
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
// a link card's page, a skill in the playbook); `roomId` is set for what belongs to one person.
export type Hit = { kind: 'doc' | 'chat' | 'memory' | 'decision' | 'file' | 'link' | 'skill' | 'library'; id: string; title: string; text: string; score: number; roomId?: string; at?: number };

// One thing the people learned to do, written by whoever learned it and kept in the one playbook everybody shares.
// `off` is the founder switching it out of every prompt; `stale` is the curator setting aside what nobody has used.
export type SkillState = 'active' | 'off' | 'stale';
// Where the lesson came from: a board run, a conversation, or the founder saying "learn this". `ref` is the task or the room.
export type SkillSource = { kind: 'run' | 'chat' | 'taught'; ref: string };
// What a skill said before its last change, so the founder can put it back with one press.
export type SkillVersion = { name: string; when: string; procedure: string[]; pitfalls: string[]; verify: string; at: number };
export type Skill = {
  id: string; name: string; when: string; procedure: string[]; pitfalls: string[]; verify: string;
  state: SkillState; by: { roomId: string; name: string }; source: SkillSource;
  uses: number; patches: number; createdAt: number; usedAt?: number; editedByFounder?: boolean; history: SkillVersion[];
};
// What the playbook's feed carries: the whole list after every change, and the quiet line when something was just learned.
export type SkillEvent = { skills: Skill[] } | { learned: { roomId: string; name: string; action: 'create' | 'patch' } };

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
// A note a person kept after a conversation without being asked to carries this mark, so the founder can tell those
// lines from the ones they asked for and throw a wrong one out. `MEMORY_CHANNEL` says a room's memory changed when no
// tool call was there to carry the news.
export const KEPT_MARK = '(kept on its own)';
export const MEMORY_CHANNEL = 'memory';
// What a tool run changed on the stage, for the client to mirror.
export type ToolEffect = { kind: 'doc-changed'; id: string } | { kind: 'doc-created'; id: string; title: string } | { kind: 'browser-moved'; id: string } | { kind: 'chat-changed'; id: string } | { kind: 'memory-changed'; id: string }
  | { kind: 'media-progress'; id: string; line: string } | { kind: 'media-made'; id: string };
// One tool call inside a reply. `ok` is absent while the tool is still running; `waiting` means it needs the founder's yes first.
export type ToolEvent = { id: string; name: string; args: Record<string, unknown>; waiting?: boolean; question?: string; ok?: boolean; result?: string; effect?: ToolEffect };
// A file the founder attached to a message; it lives in the shared files folder.
export type Attachment = { path: string; type: string; size: number };
// The founder is not always at the stage. When their words came in some other way, the message says which, so the
// card can tell them where they were standing when they said it. Absent means this window.
export type ChatVia = 'phone' | 'call';
export type ChatMessage = {
  id: string; role: 'user' | 'assistant'; text: string; at: number;
  // Set when the words came from a colleague's consult, not from the founder: the colleague's name.
  from?: string; via?: ChatVia;
  provider?: string; model?: string; usage?: Usage; tools?: ToolEvent[]; stopped?: boolean; attachments?: Attachment[];
};
// `turn` names the turn this stream is; the same name goes out on the rooms feed, so the window that asked for a
// reply can tell its own turn from one it is only watching.
export type ChatEvent = { turn: string } | { token: string } | { tool: ToolEvent } | { notice: string } | { done: true; message: ChatMessage } | { error: string };
// What the rooms feed carries, to every open window rather than only the one that started something: a conversation
// changed (by anybody at all — the phone, a colleague, another window), and a turn from its first word to its last.
export type RoomEvent = { roomId: string } & (
  { chat: 'changed' } | { turn: string; started: { via?: ChatVia } } | { turn: string; token: string }
  | { turn: string; tool: ToolEvent } | { turn: string; ended: true });
// One configured model as the client sees it: `left` is the share of today's free quota still there, 0 to 1.
export type ModelInfo = { name: string; model: string; ready: boolean; left: number; requests: number; tokens: number };

export const newMessageId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export const newTurnId = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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
