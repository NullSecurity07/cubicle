import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunksOf, createRecall, mayRecall, wordEmbedder, type Piece } from './recall.ts';
import { seedStage, type Stage } from '../shared/model.ts';

const pieces: Piece[] = [
  { kind: 'doc', id: 'brand-doc', title: 'Brand doc', text: 'Voice: calm, plain words, no hype.\n\nWe sell focus to busy founders.' },
  { kind: 'doc', id: 'secret-doc', title: 'Salaries', text: 'Dev earns a fixed monthly salary plus equity.' },
  { kind: 'chat', id: 'marketing', roomId: 'marketing', title: 'Maya', text: 'You: Draft a tagline about focus.\n\nMaya: Calm software for busy founders.', at: 5 },
  { kind: 'chat', id: 'build', roomId: 'build', title: 'Dev', text: 'You: How long for the landing page?\n\nDev: Two days with the current stack.', at: 6 },
  { kind: 'decision', id: '2026-09-19-launch-channel', title: 'Launch channel', text: 'Chosen: Hacker News. Why: our first fifty users came from there.' },
];

describe('recall', () => {
  it('finds the passage that answers, and says where it lives', async () => {
    const recall = createRecall({ dir: await mkdtemp(join(tmpdir(), 'recall-')), embed: wordEmbedder, gather: async () => pieces });
    const hits = await recall.search('which launch channel was chosen?');
    expect(hits[0]).toMatchObject({ kind: 'decision', title: 'Launch channel' });
    expect(hits[0].text).toContain('Hacker News');
    expect((await recall.search('busy founders focus'))[0].id).toMatch(/brand-doc|marketing/);
  });

  it('a person recalls only what their wires, their own room, the pinned docs and the decisions hold', async () => {
    const stage: Stage = { ...seedStage, docs: [...seedStage.docs, { id: 'secret-doc', title: 'Salaries', x: 0, y: 0, w: 1, h: 1 }] };
    const recall = createRecall({ dir: await mkdtemp(join(tmpdir(), 'recall-')), embed: wordEmbedder, gather: async () => pieces });
    const asMaya = mayRecall(stage, 'marketing');
    expect((await recall.search('monthly salary equity', { allow: asMaya })).some((hit) => hit.id === 'secret-doc')).toBe(false);
    expect((await recall.search('monthly salary equity')).some((hit) => hit.id === 'secret-doc')).toBe(true);
    expect((await recall.search('landing page current stack', { allow: asMaya })).some((hit) => hit.kind === 'chat' && hit.roomId === 'build')).toBe(false);
    expect((await recall.search('tagline focus', { allow: asMaya })).some((hit) => hit.kind === 'chat' && hit.roomId === 'marketing')).toBe(true);
    expect((await recall.search('launch channel', { allow: asMaya }))[0].kind).toBe('decision');
  });

  it('embeds a passage once: a second search reuses the saved vectors, a changed passage is embedded again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recall-'));
    let embedded = 0;
    const counting = async (texts: string[]) => { embedded += texts.length; return wordEmbedder(texts); };
    let current = pieces;
    const recall = createRecall({ dir, embed: counting, gather: async () => current });
    await recall.search('anything');
    const first = embedded;
    expect(first).toBeGreaterThan(pieces.length); // passages plus the question
    await recall.search('anything else');
    expect(embedded).toBe(first + 1);
    // after a restart the vectors come from the file
    await recall.settled();
    embedded = 0;
    await createRecall({ dir, embed: counting, gather: async () => current }).search('again');
    expect(embedded).toBe(1);
    current = [...pieces.slice(1), { ...pieces[0], text: 'Voice: bold and loud.' }];
    embedded = 0;
    const hits = await createRecall({ dir, embed: counting, gather: async () => current }).search('bold loud voice');
    expect(embedded).toBe(2);
    expect(hits[0].text).toContain('bold and loud');
  });

  it('falls back to matching words while the model is not there, and says so', async () => {
    const recall = createRecall({ dir: await mkdtemp(join(tmpdir(), 'recall-')), embed: async () => { throw new Error('model is still downloading'); }, gather: async () => pieces });
    const hits = await recall.search('Hacker News');
    expect(hits[0].kind).toBe('decision');
    expect(recall.mode()).toBe('words');
  });

  it('cuts long text into passages at paragraph ends, keeping each under the limit', () => {
    const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40)}`.trim()).join('\n\n');
    const parts = chunksOf(long, 700);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((part) => part.length <= 700)).toBe(true);
    expect(parts.join(' ')).toContain('Paragraph 11');
  });
});
