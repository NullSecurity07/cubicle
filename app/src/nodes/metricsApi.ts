import { metricsChannel, type Metric, type MetricsEvent } from '../../shared/metrics';
import { feed } from '../feed';

// The Metrics card's own calls. Kept beside the card rather than in `api.ts`, so the card is its own few files.
async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `${response.status} ${path}`);
  return response.json() as Promise<T>;
}
const base = (cardId: string) => `/api/metrics/${cardId}`;

export const getMetrics = (cardId: string) => call<MetricsEvent>(base(cardId));
export const importMetrics = (cardId: string, text: string, name: string) => call<{ added: number; replaced: number; skipped: string[] }>(`${base(cardId)}/import`, 'POST', { text, name });
export const logMetric = (cardId: string, key: string, value: number, at?: string) => call<Metric>(`${base(cardId)}/log`, 'POST', { key, value, ...(at ? { at } : {}) });
export const changeMetric = (cardId: string, key: string, patch: Partial<Pick<Metric, 'label' | 'better' | 'unit'>> & { northStar?: true; target?: Metric['target'] | null }) => call<Metric>(`${base(cardId)}/numbers/${key}`, 'PATCH', patch);
export const removeMetric = (cardId: string, key: string) => call(`${base(cardId)}/numbers/${key}`, 'DELETE');
export const answerTarget = (cardId: string, proposalId: string, accept: boolean) => call(`${base(cardId)}/proposals/${proposalId}`, 'POST', { accept });
export const dismissMetricAlert = (cardId: string, id: string) => call(`${base(cardId)}/dismiss`, 'POST', { id });

// The card's numbers as the server says them, the newest revision winning, read once as well as heard. The first read
// is tried again for a few seconds: a stage save already on its way can make the flush before it return early, so a
// card just added may be asked about a moment before the server has heard of it.
export const watchMetrics = (cardId: string, onEvent: (event: MetricsEvent) => void) => {
  let seen = -1;
  let gone = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const newer = (event: MetricsEvent) => { if (event.rev < seen) return; seen = event.rev; onEvent(event); };
  const stop = feed<MetricsEvent>(metricsChannel(cardId), newer);
  const first = (tries: number) => void getMetrics(cardId).then(newer, () => {
    if (!gone && seen < 0 && tries < 12) timer = setTimeout(() => first(tries + 1), 250 + tries * 150);
  });
  first(0);
  return () => { gone = true; clearTimeout(timer); stop(); };
};
