import type { Attachment, Attention, BoardEvent, Decision, Hit, Media, MediaAsset, MediaEvent, Mission, ChatEvent, ChatMessage, ModelInfo, RoomEvent, Skill, SkillEvent, Stage, Task, Thread } from '../shared/model';
import type { Framework, Placed } from '../shared/frameworks';
import type { ForgeJob, ForgeMode, Proposal } from '../shared/forge';
import type { Note } from '../shared/library';
import { feed, snapshot } from './feed';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `${response.status} ${path}`);
  return response.json() as Promise<T>;
}
const put = (body: unknown): RequestInit => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const getStage = () => request<Stage>('/api/stage');
export const putStage = (stage: Stage) => request('/api/stage', put(stage));
export const getDoc = (id: string) => request<{ text: string }>(`/api/docs/${id}`).then((doc) => doc.text);
// `last` is a save made as the page goes away: the browser is asked to finish it even though nobody is left to hear the answer.
export const putDoc = (id: string, text: string, last = false) => request(`/api/docs/${id}`, { ...put({ text }), ...(last ? { keepalive: true } : {}) });
export const getModels = () => request<ModelInfo[]>('/api/models');
export const getBrowser = (id: string) => request<{ port: number; url: string }>(`/api/browsers/${id}`);
export const answerApproval = (id: string, ok: boolean, args?: Record<string, string>) => request(`/api/approvals/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok, args }) });
export const restartBrowser = (id: string) => request<{ port: number; url: string }>(`/api/browsers/${id}/restart`, { method: 'POST' });
export const getMemory = (roomId: string) => request<{ notes: string; summary: string }>(`/api/rooms/${roomId}/memory`);
export const putMemory = (roomId: string, memory: { notes: string; summary: string }) => request(`/api/rooms/${roomId}/memory`, put(memory));
export const getChat = (roomId: string) => request<ChatMessage[]>(`/api/rooms/${roomId}/chat`);

// Posts one message and feeds every server-sent event to onEvent until the stream ends. Aborting the signal stops the reply.
export async function sendChat(roomId: string, text: string, onEvent: (event: ChatEvent) => void, signal?: AbortSignal, extra: { replace?: string; attachments?: Attachment[] } = {}) {
  const response = await fetch(`/api/rooms/${roomId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, ...extra }), signal });
  if (!response.ok || !response.body) throw new Error((await response.json().catch(() => null))?.error ?? `chat failed (${response.status})`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) if (frame.startsWith('data: ')) onEvent(JSON.parse(frame.slice(6)) as ChatEvent);
  }
}

const send = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
export const addTask = (boardId: string, title: string) => request<Task>(`/api/boards/${boardId}/tasks`, send('POST', { title }));
export const changeTask = (boardId: string, taskId: string, patch: Partial<Pick<Task, 'title' | 'detail' | 'column' | 'assignee'>> & { repeat?: Task['repeat'] | null }) => request<Task>(`/api/boards/${boardId}/tasks/${taskId}`, send('PATCH', patch));
export const removeTask = (boardId: string, taskId: string) => request(`/api/boards/${boardId}/tasks/${taskId}`, send('DELETE'));
export const runTask = (boardId: string, taskId: string) => request(`/api/boards/${boardId}/tasks/${taskId}/run`, send('POST'));
export const stopTask = (boardId: string, taskId: string) => request(`/api/boards/${boardId}/tasks/${taskId}/stop`, send('POST'));
export const getBoard = (boardId: string) => request<Task[]>(`/api/boards/${boardId}`);
// The board's live channel: tasks after every change, and stage effects from background runs. A card the founder has
// just put down was not on the stage when the window's connection opened, so it reads its own tasks once.
export const watchBoard = (boardId: string, onEvent: (event: BoardEvent) => void) => {
  const channel = `board:${boardId}`;
  if (snapshot(channel) === undefined) void getBoard(boardId).then((tasks) => onEvent({ tasks }), () => {});
  return feed<BoardEvent>(channel, onEvent);
};

// A studio card: what it has made, and asking it for more. `hint` says why it cannot work yet, when it cannot.
export const getMedia = (id: string) => request<Media & { hint: string | null; drawnHere?: boolean }>(`/api/media/${id}`);
// The server answers the moment the job starts; what it made arrives on the feed, however long it takes.
export const makeMedia = (id: string, ask: { prompt: string } & Record<string, unknown>) => request<{ started: true }>(`/api/media/${id}/make`, send('POST', ask));
export const stopMedia = (id: string) => request(`/api/media/${id}/stop`, send('POST'));
export const getVoices = () => request<{ voices: { id: string; name: string }[] }>('/api/media/voices');
// The founder's own footage, dropped on a studio card. The file goes straight to disk, so it may be far bigger than
// anything else this app takes; what comes back is the card's own name for it.
export const addAsset = (id: string, file: File) => request<MediaAsset>(`/api/media/${id}/assets?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
export const removeAsset = (id: string, name: string) => request(`/api/media/${id}/assets/${encodeURIComponent(name)}`, send('DELETE'));
// One feed for every studio on the stage: a line while something is being made, a nudge after every change.
// A feed that outlives the server restarting: a browser gives up for good on a refused feed, so it is opened again,
// and `onOpen` lets the cards read themselves afresh for whatever they missed meanwhile.
export const watchMedia = (onEvent: (event: MediaEvent) => void, onOpen: () => void = () => {}) => feed<MediaEvent>('media', onEvent, () => onOpen());

// What is happening in every conversation, however it was started. `onOpen` is told whether the feed had been open
// before, because a card that missed a gap has to read its conversation again to find out what was said in it.
export const watchRooms = (onEvent: (event: RoomEvent) => void, onOpen: (again: boolean) => void = () => {}) => feed<RoomEvent>('rooms', onEvent, onOpen);

export const deleteMessage = (roomId: string, messageId: string) => request<ChatMessage[]>(`/api/rooms/${roomId}/chat/${messageId}`, { method: 'DELETE' });
export const uploadFile = (file: File) => request<Attachment>(`/api/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
export const fileUrl = (path: string) => `/api/files/${path.split('/').map(encodeURIComponent).join('/')}`;
export const refreshLink = (id: string) => request<{ title: string; preview: string }>(`/api/links/${id}`, { method: 'POST' });

// Everything that waits for the founder, pushed whole after every change.
export const watchAttention = (onList: (list: Attention[]) => void) => feed<Attention[]>('attention', onList);
export const dismissAttention = (id: string) => request(`/api/attention/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });
export const getThreads = (query = '') => request<Thread[]>(`/api/threads${query ? `?q=${encodeURIComponent(query)}` : ''}`);
export const getDecisions = () => request<Decision[]>('/api/decisions');
export const recordDecision = (decision: Partial<Decision>) => request<Decision>('/api/decisions', send('POST', decision));
export const decide = (id: string, verdict: Pick<Decision, 'chosen' | 'why' | 'effect' | 'review'>) => request<Decision>(`/api/decisions/${id}/decide`, send('POST', verdict));
export const removeDecision = (id: string) => request(`/api/decisions/${id}`, send('DELETE'));
export const search = (query: string, signal?: AbortSignal) => request<{ hits: Hit[]; mode: 'meaning' | 'words' }>(`/api/search?q=${encodeURIComponent(query)}`, { signal });
// The founder's library: the notes they learn from. The index is small — a title, its tags and its size — so cards
// and pickers read the whole of it; the words themselves are fetched only when a note is opened.
export const getNotes = () => request<Note[]>('/api/library');
export const getNote = (id: string) => request<Note & { text: string }>(`/api/library/${id}`);
export const addNote = (note: { title: string; text: string; tags?: string[]; source?: 'file' | 'paste' }) => request<Note>('/api/library', send('POST', note));
export const removeNote = (id: string) => request(`/api/library/${id}`, send('DELETE'));
export const searchNotes = (query: string, signal?: AbortSignal) => request<{ hits: Hit[] }>(`/api/library/search?q=${encodeURIComponent(query)}`, { signal });

// Frameworks: teams the founder does not have to build twice. Placing one hands back a piece of stage with ids of its
// own, which the window merges and saves the way it saves a card it has just added.
export const getFrameworks = () => request<Framework[]>('/api/frameworks');
export const placeFramework = (id: string, at: { x: number; y: number }) => request<Placed>(`/api/frameworks/${id}/place`, send('POST', { at }));
// Two ways to save one: the ids of what is selected on the canvas, or the whole framework back with something changed
// in it (its test cases).
export const saveFramework = (id: string, framework: Framework | { name: string; intent?: string; ids: string[] }) => request<Framework>(`/api/frameworks/${id}`, put(framework));
export const removeFramework = (id: string) => request(`/api/frameworks/${id}`, send('DELETE'));

// The forge: notes and a line of intent go in, a team comes back. Proposing and building both answer at once with
// the job's name and go on working, so the window watches the job rather than holding a request open for a minute.
export const forgePropose = (asked: { noteIds: string[]; intent: string; mode: ForgeMode }) => request<{ jobId: string }>('/api/forge/propose', send('POST', asked));
export const forgeBuild = (asked: { jobId: string; proposal: Proposal; mode: ForgeMode }) => request<{ jobId: string }>('/api/forge/build', send('POST', asked));
export const getForge = (jobId: string) => request<ForgeJob>(`/api/forge/${jobId}`);
export const stopForge = (jobId: string) => request(`/api/forge/${jobId}/stop`, send('POST'));

export const getMissions = () => request<{ dismissed: boolean; missions: Mission[] }>('/api/missions');
export const dismissMissions = () => request('/api/missions/dismiss', { method: 'POST' });

// The one playbook everybody shares, and the page everybody has read about the founder.
export type SkillPatch = Partial<Pick<Skill, 'name' | 'when' | 'procedure' | 'pitfalls' | 'verify' | 'state'>> & { undo?: true };
export const changeSkill = (id: string, patch: SkillPatch) => request<Skill>(`/api/skills/${id}`, send('PATCH', patch));
export const removeSkill = (id: string) => request(`/api/skills/${id}`, send('DELETE'));
export const getFounder = () => request<{ text: string }>('/api/founder').then((profile) => profile.text);
export const putFounder = (text: string) => request('/api/founder', put({ text }));
// The playbook whole after every change, and the one line a birth or an improvement leaves in the room it happened in.
export const watchSkills = (onEvent: (event: SkillEvent) => void) => feed<SkillEvent>('skills', onEvent);
// "Learn this" on a task the founder can see is finished. Nothing worth keeping answers with `learned: null`.
export const learnFromTask = (boardId: string, taskId: string) => request<{ learned: { name: string; action: 'create' | 'patch' } | null }>(`/api/boards/${boardId}/tasks/${taskId}/learn`, send('POST'));
