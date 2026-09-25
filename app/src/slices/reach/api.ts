import type { ReachState, ReachUpdates } from '../../../shared/reach';
import { request, send as sent } from '../../api';

// This slice's own paths, kept beside the screens that use them.
const send = (body: unknown, method = 'POST') => sent(method, body);

export type Made = { id: string; secret: string; url: string };

export const getReach = () => request<ReachState>('/api/reach');
export const putReach = (patch: { on?: boolean; token?: string; voice?: boolean; cloudSpeech?: boolean; updates?: Partial<ReachUpdates> }) => request<ReachState>('/api/reach', send(patch, 'PUT'));
export const newPairing = () => request<ReachState>('/api/reach/pair', { method: 'POST' });
export const forgetChat = (chatId: number) => request<ReachState>(`/api/reach/chats/${chatId}`, { method: 'DELETE' });
export const speakTo = (chatId: number, speak: boolean) => request<ReachState>(`/api/reach/chats/${chatId}`, send({ speak }, 'PUT'));
export const forgetGroup = () => request<ReachState>('/api/reach/group', { method: 'DELETE' });
export const makeHook = (hook: { name: string; boardId: string; assignee?: string }) => request<Made>('/api/reach/hooks', send(hook));
export const dropHook = (id: string) => request<ReachState>(`/api/reach/hooks/${id}`, { method: 'DELETE' });

// What was said, written down. The samples go up as they are: plain numbers, one channel, 16 kHz.
export const listen = (samples: Float32Array) => request<{ text: string }>('/api/reach/listen', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Blob([new Uint8Array(samples.buffer as ArrayBuffer, samples.byteOffset, samples.byteLength)]) });

// A reply said out loud. `who` is the person whose reply it is, so it arrives in their voice; a voice named outright
// is the person form letting the founder hear one before they give it to somebody.
// The answer is the sound itself, not json, so it is fetched rather than requested.
export async function speaking(text: string, who: { roomId: string } | { voice: string }): Promise<Blob> {
  const response = await fetch('/api/reach/speak', send({ text, ...who }));
  if (!response.ok) throw new Error((await response.json().catch(() => null) as { error?: string } | null)?.error ?? 'that could not be said out loud');
  return response.blob();
}
