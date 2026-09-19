import type { Attachment, Attention, BoardEvent, ChatEvent, ChatMessage, ModelInfo, Stage, Task, Thread } from '../shared/model';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `${response.status} ${path}`);
  return response.json() as Promise<T>;
}
const put = (body: unknown): RequestInit => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const getStage = () => request<Stage>('/api/stage');
export const putStage = (stage: Stage) => request('/api/stage', put(stage));
export const getDoc = (id: string) => request<{ text: string }>(`/api/docs/${id}`).then((doc) => doc.text);
export const putDoc = (id: string, text: string) => request(`/api/docs/${id}`, put({ text }));
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
// The board's live feed: tasks after every change, and stage effects from background runs.
export function watchBoard(boardId: string, onEvent: (event: BoardEvent) => void) {
  const source = new EventSource(`/api/boards/${boardId}/events`);
  source.onmessage = (message) => onEvent(JSON.parse(message.data) as BoardEvent);
  return () => source.close();
}

export const deleteMessage = (roomId: string, messageId: string) => request<ChatMessage[]>(`/api/rooms/${roomId}/chat/${messageId}`, { method: 'DELETE' });
export const uploadFile = (file: File) => request<Attachment>(`/api/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
export const fileUrl = (path: string) => `/api/files/${path.split('/').map(encodeURIComponent).join('/')}`;
export const refreshLink = (id: string) => request<{ title: string; preview: string }>(`/api/links/${id}`, { method: 'POST' });

// Everything that waits for the founder, pushed whole after every change.
export function watchAttention(onList: (list: Attention[]) => void) {
  const source = new EventSource('/api/attention/events');
  source.onmessage = (message) => onList(JSON.parse(message.data) as Attention[]);
  return () => source.close();
}
export const dismissAttention = (id: string) => request(`/api/attention/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });
export const getThreads = (query = '') => request<Thread[]>(`/api/threads${query ? `?q=${encodeURIComponent(query)}` : ''}`);
