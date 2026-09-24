import { hashOf } from './hash.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// What a film remembers between two makings of itself.
//
// The picture cache files a picture under the exact words it was drawn from, and it was never once hit on a second
// run, because those words are written by a model and a model never writes the same sentence twice. So the cache
// was sound and useless. Two small memories in front of it are what make it work:
//
//   - **The storyboard of the draft.** A founder who watches a draft and then asks for the film in full is asking
//     for *that* film, not for a second opinion. The full run films the storyboard the draft was made from. Pressing
//     Make again at the same speed is still what it always was: a new film.
//   - **What was put under a line.** The subject written for a phrase is remembered under the phrase, so the same
//     line in the same style gets the same picture — and the same picture is one the cache already holds.
//
// Both are a kindness and never a requirement: a memory that cannot be read or written costs a film nothing.

const hash = (...parts: unknown[]): string => hashOf(32, ...parts);

// Everything that decides what a film says. Not the speed, which is the one thing allowed to differ between a draft
// and the film made from it; and not how its moving shots are made, which a draft never has.
export const storyboardKey = (ask: { brief: string; told: unknown; lines: string[]; assets: string[] }): string =>
  hash(ask.brief.trim(), ask.told, ask.lines, ask.assets);

export const subjectKey = (one: { line: string; kind: string; room: string }, bible: string): string =>
  hash(one.line.trim().toLowerCase(), one.kind, one.room, bible);

export type KeptStoryboard<T> = { key: string; speed: 'draft' | 'full'; directed: T };
export type KeptSubject = { subject: string; metaphor?: string };
// Enough for every film a founder makes in a month, and small enough to read whole every time.
export const MOST_SUBJECTS = 600;

const safe = (cardId: string) => cardId.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'card';

export function filmMemory(dir: string | undefined) {
  const read = async <T>(file: string): Promise<T | null> => {
    if (!dir) return null;
    try { return JSON.parse(await readFile(join(dir, file), 'utf8')) as T; } catch { return null; }
  };
  const write = async (file: string, value: unknown): Promise<void> => {
    if (!dir) return;
    await mkdir(dir, { recursive: true }).then(() => writeFile(join(dir, file), JSON.stringify(value))).catch(() => {});
  };
  return {
    // The storyboard to film again: only ever a draft's, only for a full run, and only while nothing that decides
    // what the film says has changed.
    async storyboard<T>(cardId: string | undefined, key: string, speed: 'draft' | 'full'): Promise<T | null> {
      if (!cardId || speed !== 'full') return null;
      const kept = await read<KeptStoryboard<T>>(`storyboard-${safe(cardId)}.json`);
      return kept && kept.key === key && kept.speed === 'draft' && kept.directed ? kept.directed : null;
    },
    async keepStoryboard<T>(cardId: string | undefined, kept: KeptStoryboard<T>): Promise<void> {
      if (cardId) await write(`storyboard-${safe(cardId)}.json`, kept);
    },
    async subjects(keys: string[]): Promise<Map<string, KeptSubject>> {
      const all = (await read<Record<string, KeptSubject>>('subjects.json')) ?? {};
      return new Map(keys.flatMap((key) => (all[key]?.subject ? [[key, all[key]] as [string, KeptSubject]] : [])));
    },
    async keepSubjects(fresh: [string, KeptSubject][]): Promise<void> {
      if (!fresh.length) return;
      const all = (await read<Record<string, KeptSubject>>('subjects.json')) ?? {};
      // Written again so the newest are last, which is what makes "the oldest" the front of the object.
      for (const [key, one] of fresh) { delete all[key]; all[key] = one; }
      const names = Object.keys(all);
      for (const gone of names.slice(0, Math.max(0, names.length - MOST_SUBJECTS))) delete all[gone];
      await write('subjects.json', all);
    },
  };
}
export type FilmMemory = ReturnType<typeof filmMemory>;
