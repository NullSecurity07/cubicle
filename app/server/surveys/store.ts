import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Stage } from '../../shared/model.ts';
import { MAX_RESPONSES, readExport, responseKey, type Question, type SurveyEvent, type SurveyResponse } from '../../shared/survey.ts';
import { trashStamp } from '../clock.ts';

export type SurveyCard = Extract<NonNullable<Stage['cards']>[number], { kind: 'survey' }>;
export const surveyCards = (stage: Stage) => (stage.cards ?? []).filter((card): card is SurveyCard => card.kind === 'survey');

export type Imported = { imported: number; already: number; skipped: string[]; matched: { question: string; header: string }[]; unmatchedQuestions: string[]; unmatchedColumns: string[] };
export type Surveys = ReturnType<typeof createSurveys>;

const safe = (id: string) => { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`bad id: ${id}`); return id; };

// One file per Survey card, one response a line, beside the stage. The server owns it: the card only sends what the
// founder pasted or dropped, and every change is said to whoever listens. A line that will not read is left out
// rather than losing the file.
export function createSurveys(dir: string, tell: (cardId: string, event: SurveyEvent) => void = () => {}, now: () => number = Date.now) {
  const folder = join(dir, 'surveys');
  const path = (cardId: string) => join(folder, `${safe(cardId)}.jsonl`);
  const cache = new Map<string, SurveyResponse[]>();
  const revs = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();

  async function load(cardId: string): Promise<SurveyResponse[]> {
    const known = cache.get(cardId);
    if (known) return known;
    let responses: SurveyResponse[] = [];
    try {
      responses = (await readFile(path(cardId), 'utf8')).split('\n').flatMap((line) => {
        if (!line.trim()) return [];
        try { const one = JSON.parse(line) as SurveyResponse; return one && typeof one.id === 'string' && one.answers ? [one] : []; } catch { return []; }
      });
    } catch { /* a new card */ }
    cache.set(cardId, responses);
    revs.set(cardId, Math.max(revs.get(cardId) ?? 0, now()));
    return responses;
  }
  function save(cardId: string) {
    const responses = cache.get(cardId) ?? [];
    const text = responses.map((one) => JSON.stringify(one)).join('\n') + (responses.length ? '\n' : '');
    queue = queue.then(async () => { await mkdir(folder, { recursive: true }); await writeFile(`${path(cardId)}.tmp`, text); await rename(`${path(cardId)}.tmp`, path(cardId)); }).catch(() => {});
    revs.set(cardId, Math.max((revs.get(cardId) ?? 0) + 1, now()));
    tell(cardId, { responses, rev: revs.get(cardId)! });
  }

  return {
    settled: () => queue,
    list: load,
    async read(cardId: string): Promise<SurveyEvent> { const responses = await load(cardId); return { responses, rev: revs.get(cardId)! }; },
    // A CSV exported from Tally or Google Forms, read against the card's questions. A response already here (the same
    // answers at the same moment) is counted as already imported, never twice.
    async importText(cardId: string, text: string, name: string, questions: Question[], product?: string): Promise<Imported> {
      const read = readExport(text, questions, product, now());
      const responses = await load(cardId);
      const known = new Set(responses.map((one) => one.id));
      let imported = 0;
      let already = 0;
      const skipped = [...read.skipped];
      for (const row of read.rows) {
        const id = responseKey(row.at, row.answers);
        if (known.has(id)) { already++; continue; }
        if (responses.length >= MAX_RESPONSES) { skipped.push(`row ${row.row}: the card holds ${MAX_RESPONSES} answers`); continue; }
        known.add(id);
        responses.push({ id, at: row.at, from: name.slice(0, 80) || 'pasted', answers: row.answers });
        imported++;
      }
      responses.sort((one, two) => one.at - two.at);
      if (imported) save(cardId);
      const words = new Map(questions.map((question) => [question.id, question.text]));
      return {
        imported, already, skipped, unmatchedColumns: read.unmatchedColumns,
        matched: read.mapping.map((one) => ({ question: words.get(one.question) ?? one.question, header: one.header })),
        unmatchedQuestions: read.unmatchedQuestions.map((id) => words.get(id) ?? id),
      };
    },
    // Clearing puts the old answers in the trash, never away for good.
    async clear(cardId: string) {
      const responses = await load(cardId);
      if (!responses.length) return;
      const text = responses.map((one) => JSON.stringify(one)).join('\n');
      const stamp = trashStamp(now());
      queue = queue.then(async () => { await mkdir(join(dir, 'trash'), { recursive: true }); await writeFile(join(dir, 'trash', `${stamp}-survey-${cardId}.jsonl`), `${text}\n`); }).catch(() => {});
      cache.set(cardId, []);
      save(cardId);
    },
  };
}
