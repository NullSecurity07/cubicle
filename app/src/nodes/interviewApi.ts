import { interviewChannel, type Interview, type InterviewEvent, type InterviewRecording } from '../../shared/interviews';
import { feed } from '../feed';

// The Interview card's own calls. Kept beside the card rather than in `api.ts`, so the card is its own few files.
async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `${response.status} ${path}`);
  return response.json() as Promise<T>;
}
const base = (cardId: string) => `/api/interviews/${cardId}`;

export const getInterview = (cardId: string) => call<InterviewEvent>(base(cardId));
export const setConsent = (cardId: string, yes: boolean) => call<Interview>(`${base(cardId)}/consent`, 'POST', { yes });
export const retryInterview = (cardId: string) => call(`${base(cardId)}/retry`, 'POST', {});
export const removeRecording = (cardId: string, index: number) => call(`${base(cardId)}/recordings/${index}`, 'DELETE');
export const askedForInsights = (cardId: string, docId: string, roomId: string) => call<Interview>(`${base(cardId)}/insights`, 'POST', { docId, roomId });
export const soundUrl = (cardId: string, index: number) => `${base(cardId)}/recordings/${index}`;

// The sound goes up as it is, in one request, and is written straight to disk on the other side.
export async function uploadRecording(cardId: string, blob: Blob, name: string): Promise<InterviewRecording> {
  const response = await fetch(`${base(cardId)}/recordings?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `the recording could not be saved (${response.status})`);
  return response.json() as Promise<InterviewRecording>;
}

// The card's sidecar as the server says it, the newest revision winning, read once as well as heard. The first read
// is tried again for a few seconds: a card just added may be asked about a moment before the server has heard of it.
export const watchInterview = (cardId: string, onEvent: (event: InterviewEvent) => void) => {
  let seen = -1;
  let gone = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const newer = (event: InterviewEvent) => { if (event.rev < seen) return; seen = event.rev; onEvent(event); };
  const stop = feed<InterviewEvent>(interviewChannel(cardId), newer);
  const first = (tries: number) => void getInterview(cardId).then(newer, () => {
    if (!gone && seen < 0 && tries < 12) timer = setTimeout(() => first(tries + 1), 250 + tries * 150);
  });
  first(0);
  return () => { gone = true; clearTimeout(timer); stop(); };
};
