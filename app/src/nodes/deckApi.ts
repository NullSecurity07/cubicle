import { deckChannel, type DeckEvent, type DeckLook, type DeckPurpose } from '../../shared/deck';
import { feed } from '../feed';

// The Deck card's own calls, kept beside it rather than in the shared api file. What people make arrives on the feed.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `${response.status} ${path}`);
  return response.json() as Promise<T>;
}
const post = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export const getDeck = (cardId: string) => request<DeckEvent>(`/api/decks/${cardId}`);
export const makeDeck = (cardId: string, ask: { brief: string; purpose: DeckPurpose; look: DeckLook }) => request(`/api/decks/${cardId}/make`, post(ask));
export const editDeck = (cardId: string, notes: string, version: number) => request(`/api/decks/${cardId}/edit`, post({ notes, version }));
export const stopDeck = (cardId: string) => request(`/api/decks/${cardId}/stop`, post());
export const slideUrl = (cardId: string, version: number, index: number) => `/api/decks/${cardId}/v/${version}/slides/${index}`;

// The feed, and one read of its own: a card put down after the window connected was not there for the opening news.
export const watchDeck = (cardId: string, onEvent: (event: DeckEvent) => void) => {
  let seen = -1;
  const newer = (event: DeckEvent) => { if (event.rev < seen) return; seen = event.rev; onEvent(event); };
  const stop = feed<DeckEvent>(deckChannel(cardId), newer);
  void getDeck(cardId).then(newer, () => {});
  return { stop, again: () => { void getDeck(cardId).then(newer, () => {}); } };
};
