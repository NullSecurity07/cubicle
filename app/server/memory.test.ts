import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../shared/model.ts';
import { createMemory, recent } from './memory.ts';
import { createStore } from './store.ts';

const message = (index: number, chars = 900): ChatMessage => ({ id: `m${index}`, role: index % 2 ? 'assistant' : 'user', text: `turn ${index} ${'x'.repeat(chars)}`, at: index });
const fresh = async () => createStore(await mkdtemp(join(tmpdir(), 'memory-')));

describe('recent', () => {
  it('keeps what fits, newest last, and never fewer than the last two', () => {
    const history = Array.from({ length: 20 }, (_, index) => message(index));
    const kept = recent(history);
    expect(kept.at(-1)!.id).toBe('m19');
    expect(kept.length).toBeGreaterThan(3);
    expect(kept.length).toBeLessThan(8);
    expect(recent([message(0, 9000), message(1, 9000)]).map((one) => one.id)).toEqual(['m0', 'm1']);
    expect(recent([])).toEqual([]);
  });
});

describe('memory', () => {
  it('folds talk that slid out of the window into the summary, once, and only when enough has piled up', async () => {
    const store = await fresh();
    const asked: string[] = [];
    const memory = createMemory(store, async (messages) => { asked.push(messages[1].content); return 'Launch is on 14 October. The founder wants short emails.'; });
    for (let index = 0; index < 4; index += 1) await store.appendChat('marketing', message(index));
    expect(await memory.fold('marketing')).toBe(false);
    for (let index = 4; index < 16; index += 1) await store.appendChat('marketing', message(index));
    expect(await memory.fold('marketing')).toBe(true);
    expect(asked[0]).toContain('Founder: turn 0');
    expect(asked[0]).toContain('You: turn 1');
    expect(asked[0]).not.toContain('turn 15');
    expect((await memory.read('marketing')).summary).toContain('14 October');
    expect(await memory.fold('marketing')).toBe(false);
    for (let index = 16; index < 28; index += 1) await store.appendChat('marketing', message(index));
    expect(await memory.fold('marketing')).toBe(true);
    expect(asked[1]).toContain('Memory so far:\nLaunch is on 14 October.');
    expect(asked[1]).not.toContain('Founder: turn 0 ');
  });

  it('keeps notes once each, stops when they are full, and lets the founder rewrite everything', async () => {
    const store = await fresh();
    const memory = createMemory(store, async () => '');
    expect(await memory.remember('build', '  Ship   weekly. ')).toBe('Remembered.');
    expect(await memory.remember('build', 'Ship weekly.')).toBe('Already remembered.');
    expect((await memory.read('build')).notes).toBe('- Ship weekly.');
    await memory.write('build', { notes: '- Ship daily.', summary: 'Edited by the founder.' });
    expect(await memory.read('build')).toMatchObject({ notes: '- Ship daily.', summary: 'Edited by the founder.' });
    await memory.write('build', { notes: 'x'.repeat(3990) });
    await expect(memory.remember('build', 'one more fact that does not fit')).rejects.toThrow(/notes are full/);
  });

  it('sends a removed person\'s memory to trash with their conversation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-'));
    const store = createStore(dir);
    const stage = await store.loadStage();
    await createMemory(store, async () => '').remember('build', 'x');
    await store.appendChat('build', message(0));
    await store.saveStage({ ...stage, rooms: stage.rooms.filter((room) => room.id !== 'build') });
    expect((await readdir(join(dir, 'trash'))).filter((name) => name.includes('build')).length).toBe(2);
  });
});
