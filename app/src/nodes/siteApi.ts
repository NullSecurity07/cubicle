import { siteChannel, type SiteEvent, type SiteLook } from '../../shared/site';
import { feed } from '../feed';

// The Site card's own calls, kept beside it rather than in the shared api file. What is made arrives on the feed.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `${response.status} ${path}`);
  return response.json() as Promise<T>;
}
const post = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export const getSite = (cardId: string) => request<SiteEvent>(`/api/sites/${cardId}`);
export const makeSite = (cardId: string, ask: { brief: string; look: SiteLook }) => request(`/api/sites/${cardId}/make`, post(ask));
export const editSite = (cardId: string, notes: string, version: number) => request(`/api/sites/${cardId}/edit`, post({ notes, version }));
export const stopSite = (cardId: string) => request(`/api/sites/${cardId}/stop`, post());
export const serveSite = (cardId: string, browserId: string, version: number) => request<{ url: string }>(`/api/sites/${cardId}/serve`, post({ browserId, version }));
export const pageUrl = (cardId: string, version: number) => `/api/sites/${cardId}/v/${version}/index.html`;
export const zipUrl = (cardId: string, version: number) => `/api/sites/${cardId}/v/${version}/zip`;

// The feed, and one read of its own: a card put down after the window connected was not there for the opening news.
export const watchSite = (cardId: string, onEvent: (event: SiteEvent) => void) => {
  let seen = -1;
  const newer = (event: SiteEvent) => { if (event.rev < seen) return; seen = event.rev; onEvent(event); };
  const stop = feed<SiteEvent>(siteChannel(cardId), newer);
  void getSite(cardId).then(newer, () => {});
  return { stop, again: () => { void getSite(cardId).then(newer, () => {}); } };
};
