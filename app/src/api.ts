import type { ChatEvent, ChatMessage, ModelInfo, Stage } from '../shared/model';

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
export const getChat = (roomId: string) => request<ChatMessage[]>(`/api/rooms/${roomId}/chat`);

// Posts one message and feeds every server-sent event to onEvent until the stream ends. Aborting the signal stops the reply.
export async function sendChat(roomId: string, text: string, onEvent: (event: ChatEvent) => void, signal?: AbortSignal) {
  const response = await fetch(`/api/rooms/${roomId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal });
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
