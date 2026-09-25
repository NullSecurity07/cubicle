import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Card, Stage } from '../shared/model.ts';
import { createStore } from './store.ts';
import { attachedTo, createPromptFor } from './turn-prompt.ts';

async function setup(page: (url: string) => Promise<{ title: string; text: string }>) {
  const store = createStore(await mkdtemp(join(tmpdir(), 'turn-prompt-')));
  const reads: string[] = [];
  const counted = { ...store, readChat: async (id: string) => { reads.push(id); return store.readChat(id); } };
  const promptFor = createPromptFor({
    store: counted, browser: { page },
    media: { read: async () => ({ results: [] }) },
    decisions: { list: async () => [] },
    memory: { read: async () => ({ notes: '', summary: '' }) },
    founder: { read: async () => '' },
  });
  const link = { id: 'link-a', kind: 'link', url: 'https://example.test/a', x: 0, y: 0, w: 300, h: 200 } as Card;
  const base = await store.loadStage();
  const stage: Stage = { ...base, cards: [link], wires: [...base.wires, { id: 'w-link', from: 'build', fromHandle: 'r', to: 'link-a', toHandle: 'l' }] };
  return { store, promptFor, stage, reads };
}

describe('a turn prompt', () => {
  it('keeps a link card it read, and tries one that failed again next turn', async () => {
    let fail = true;
    const { store, promptFor, stage } = await setup(async () => {
      if (fail) throw new Error('timeout');
      return { title: 'A page', text: 'What the page says.' };
    });
    const first = await promptFor(stage, 'build', []);
    expect(first[0].content).toContain('could not be read: timeout');
    expect(await store.readPage('link-a')).toBeNull();
    fail = false;
    await promptFor(stage, 'build', []);
    expect(await store.readPage('link-a')).toMatchObject({ title: 'A page', text: 'What the page says.' });
  });

  it('reads the person\'s own conversation once, and not at all for a fresh start', async () => {
    const { promptFor, stage, reads } = await setup(async () => ({ title: 't', text: 'x' }));
    await promptFor(stage, 'build', []);
    expect(reads.filter((id) => id === 'build')).toHaveLength(1);
    reads.length = 0;
    await promptFor(stage, 'build', [], true);
    expect(reads.filter((id) => id === 'build')).toHaveLength(0);
  });

  it('carries what was attached, text as text and pictures as pictures', async () => {
    const { store } = await setup(async () => ({ title: 't', text: 'x' }));
    await store.saveFileBytes('uploads/notes.md', Buffer.from('# Notes'));
    await store.saveFileBytes('uploads/shot.png', Buffer.from([1, 2, 3]));
    const attached = await attachedTo(store, [{ id: 'm1', role: 'user', text: 'see', at: 1, attachments: [
      { path: 'uploads/notes.md', type: 'text/markdown', size: 7 }, { path: 'uploads/shot.png', type: 'image/png', size: 3 }, { path: 'uploads/gone.md', type: 'text/markdown', size: 1 },
    ] }]);
    expect(attached.texts).toEqual({ 'uploads/notes.md': '# Notes' });
    expect(Object.keys(attached.images)).toEqual(['uploads/shot.png']);
    expect(attached.images['uploads/shot.png']).toMatch(/^data:image\/png;base64,/);
  });
});
