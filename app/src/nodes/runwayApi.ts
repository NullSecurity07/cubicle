import { runwayChannel, type Runway, type RunwayEvent } from '../../shared/runway';
import { feed } from '../feed';

// A Runway card's own calls, kept beside it so the shared api file is not one more thing every card edits.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `${response.status} ${path}`);
  return response.json() as Promise<T>;
}
const send = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

export const getRunway = (cardId: string) => request<RunwayEvent>(`/api/runway/${cardId}`);
export const putRunway = (cardId: string, runway: Runway) => request<RunwayEvent>(`/api/runway/${cardId}`, send('PUT', runway));
export const acceptProposal = (cardId: string, proposalId: string) => request<RunwayEvent>(`/api/runway/${cardId}/proposals/${proposalId}`, send('POST'));
export const declineProposal = (cardId: string, proposalId: string) => request<RunwayEvent>(`/api/runway/${cardId}/proposals/${proposalId}`, send('DELETE'));
export const seenAlert = (cardId: string) => request<RunwayEvent>(`/api/runway/${cardId}/seen`, send('POST'));

// The feed, and one read of its own: a card put down after the window connected was not in what the feed opened with.
// `rev` only grows, so whichever of the two arrives last, the newer one stays.
export function watchRunway(cardId: string, onEvent: (event: RunwayEvent) => void) {
  let seen = -1;
  const newer = (event: RunwayEvent) => { if (event.rev < seen) return; seen = event.rev; onEvent(event); };
  const stop = feed<RunwayEvent>(runwayChannel(cardId), newer);
  void getRunway(cardId).then(newer, () => {});
  return stop;
}
