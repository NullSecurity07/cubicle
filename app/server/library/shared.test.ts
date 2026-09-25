import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Deps } from '../install.ts';

// Counts every recall made, so the test can say how many indexes the four slices that read the library built.
const made = vi.hoisted(() => ({ count: 0 }));
vi.mock('../recall.ts', async (real) => {
  const actual = await real<typeof import('../recall.ts')>();
  return { ...actual, createRecall: (...args: Parameters<typeof actual.createRecall>) => { made.count += 1; return actual.createRecall(...args); } };
});

const { libraryFor } = await import('./notes.ts');
const { wordEmbedder } = await import('../recall.ts');
const slices = await Promise.all(['library', 'evals', 'forge', 'frameworks'].map(async (name) => (await import(`../slices/${name}.ts`)).default));

describe('one library per workspace', () => {
  it('is the same library and the same recall whoever asks for it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'library-shared-'));
    const one = libraryFor(workspace, wordEmbedder);
    expect(libraryFor(workspace, wordEmbedder)).toBe(one);
    expect(libraryFor(await mkdtemp(join(tmpdir(), 'library-other-')), wordEmbedder)).not.toBe(one);
  });

  // Three recalls over one folder once each embedded a new note and wrote the same index file, racing each other.
  it('builds one recall for the library, the evals, the forge and the frameworks together', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'library-slices-'));
    const before = made.count;
    const deps = { workspace, root: workspace, fake: true, store: { loadStage: async () => ({ rooms: [], docs: [], wires: [], cards: [] }) }, json: () => {}, body: async () => ({}) } as unknown as Deps;
    const parts = [];
    for (const slice of slices) parts.push(await slice.install(deps));
    expect(made.count - before).toBe(1);
    const { library } = libraryFor(workspace, wordEmbedder);
    await library.add({ title: 'Pricing', text: 'Charge for the value.' });
    // The evals and the forge see the note the library slice was given, because it is the one library.
    expect((await libraryFor(workspace, wordEmbedder).recall.search('value')).map((hit) => hit.title)).toEqual(['Pricing']);
    for (const part of parts) await part.close?.();
  });
});
