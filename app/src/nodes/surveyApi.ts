import { surveyChannel, type SurveyEvent } from '../../shared/survey';
import { feed } from '../feed';

// The Survey card's own calls. Kept beside the card rather than in `api.ts`, so the card is its own few files.
async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `${response.status} ${path}`);
  return response.json() as Promise<T>;
}
const base = (cardId: string) => `/api/surveys/${cardId}`;

export type Imported = { imported: number; already: number; skipped: string[]; matched: { question: string; header: string }[]; unmatchedQuestions: string[]; unmatchedColumns: string[] };
export const getSurvey = (cardId: string) => call<SurveyEvent>(base(cardId));
export const importSurvey = (cardId: string, text: string, name: string) => call<Imported>(`${base(cardId)}/import`, 'POST', { text, name });
export const clearSurvey = (cardId: string) => call(base(cardId), 'DELETE');

// The answers as the server says them, the newest revision winning, read once as well as heard. The first read is
// tried again for a few seconds: a card just added may be asked about a moment before the server has heard of it.
export const watchSurvey = (cardId: string, onEvent: (event: SurveyEvent) => void) => {
  let seen = -1;
  let gone = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const newer = (event: SurveyEvent) => { if (event.rev < seen) return; seen = event.rev; onEvent(event); };
  const stop = feed<SurveyEvent>(surveyChannel(cardId), newer);
  const first = (tries: number) => void getSurvey(cardId).then(newer, () => {
    if (!gone && seen < 0 && tries < 12) timer = setTimeout(() => first(tries + 1), 250 + tries * 150);
  });
  first(0);
  return () => { gone = true; clearTimeout(timer); stop(); };
};
