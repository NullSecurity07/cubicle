import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attention } from '../shared/model.ts';
import { hostOf } from '../shared/sources.ts';

// A website a person proposed as a source. It waits for the founder in Needs you until they add it or drop it.
export type Proposed = { id: string; url: string; about: string; why: string; by: string; at: number };
export type Sources = {
  propose(input: Omit<Proposed, 'id' | 'at'>, existingHosts: string[]): Promise<Proposed>;
  list(): Promise<Proposed[]>;
  drop(id: string): Promise<void>;
  onChange(fn: () => void): void;
};

// The id is the host in plain letters, so a second person proposing the same site finds the first proposal.
const idOf = (host: string) => host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'source';

// Proposals live in one small JSON file. Writes go one after another, so two people proposing at the same moment
// cannot each read the old list and lose the other's proposal.
export function createSources(dir: string, now: () => number = Date.now): Sources {
  const folder = join(dir, 'sources');
  const path = join(folder, 'proposed.json');
  const listeners = new Set<() => void>();
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<Proposed[]> {
    try { const saved = JSON.parse(await readFile(path, 'utf8')); return Array.isArray(saved) ? saved : []; } catch { return []; }
  }
  async function write(all: Proposed[]) {
    await mkdir(folder, { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(all, null, 2));
    await rename(`${path}.tmp`, path);
    for (const tell of listeners) tell();
  }
  // Runs one change after the last has finished, and a failed change does not stop the ones after it.
  const queued = <T>(job: () => Promise<T>): Promise<T> => { const next = queue.then(job); queue = next.catch(() => {}); return next; };

  return {
    list: () => queued(read),
    propose: (input, existingHosts) => queued(async () => {
      const host = hostOf(input.url);
      if (existingHosts.includes(host)) throw new Error(`${host} is already a source on the stage`);
      const all = await read();
      const held = all.find((one) => hostOf(one.url) === host);
      if (held) return held;
      const made: Proposed = { id: idOf(host), url: input.url, about: input.about, why: input.why, by: input.by, at: now() };
      await write([...all, made]);
      return made;
    }),
    drop: (id) => queued(async () => {
      const all = await read();
      if (!all.some((one) => one.id === id)) return;
      await write(all.filter((one) => one.id !== id));
    }),
    onChange(tell) { listeners.add(tell); },
  };
}

// Each proposal is one thing the founder is asked about: add the site to the stage, or drop it.
export const sourceAttention = (sources: Sources) => async (): Promise<Attention[]> => (await sources.list()).map((one) => ({
  id: `proposed-source:${one.id}`, kind: 'proposed-source', title: hostOf(one.url), detail: `${one.about}. ${one.why}`, who: one.by, at: one.at, sourceId: one.id, url: one.url, about: one.about,
}));
