import { describe, expect, it } from 'vitest';
import { seedStage, type ChatMessage } from '../shared/model.ts';
import { threadsOf } from './threads.ts';

const say = (id: string, role: 'user' | 'assistant', text: string, at: number, from?: string): ChatMessage => ({ id, role, text, at, ...(from ? { from } : {}) });
const chats = {
  marketing: [say('a', 'user', 'Draft a tagline', 10), say('b', 'assistant', 'Calm software for busy founders.', 11)],
  build: [
    say('c', 'user', 'How long for the landing page?', 20, 'Maya'), say('d', 'assistant', 'Two days with the current stack.', 21),
    say('e', 'user', 'Plan the sprint', 30), say('f', 'assistant', 'Three tickets, in this order.', 31),
  ],
};

describe('threadsOf', () => {
  it('lists every room and every pair that consulted, newest first, with the last line and who said it', () => {
    const threads = threadsOf(seedStage, chats, new Set(['build']));
    expect(threads.map((thread) => thread.id)).toEqual(['build', 'marketing~build', 'marketing']);
    expect(threads[0]).toMatchObject({ kind: 'room', title: 'Dev', live: true, count: 4, last: { text: 'Three tickets, in this order.', by: 'Dev' } });
    expect(threads[1]).toMatchObject({ kind: 'consult', title: 'Maya ↔ Dev', count: 2, last: { by: 'Dev', text: 'Two days with the current stack.' } });
    expect(threads[1].messages?.map((message) => message.id)).toEqual(['c', 'd']);
    expect(threads[2].last?.by).toBe('Maya');
    expect(threads[2].messages).toBeUndefined();
  });

  it('a room nobody has talked in is still listed, last', () => {
    const threads = threadsOf(seedStage, { marketing: chats.marketing }, new Set());
    expect(threads.map((thread) => thread.id)).toEqual(['marketing', 'build']);
    expect(threads[1]).toMatchObject({ count: 0 });
    expect(threads[1].last).toBeUndefined();
  });

  it('search keeps the threads where the words were said, with the line that matched', () => {
    const threads = threadsOf(seedStage, chats, new Set(), 'LANDING page');
    expect(threads.map((thread) => thread.id)).toEqual(['build', 'marketing~build']);
    expect(threads[0].hit).toContain('How long for the landing page?');
    expect(threadsOf(seedStage, chats, new Set(), 'dev').map((thread) => thread.id)).toContain('build');
  });

  it('a consult from someone who has left the stage keeps their name', () => {
    const threads = threadsOf(seedStage, { build: [say('x', 'user', 'Old question', 5, 'Rio'), say('y', 'assistant', 'Old answer', 6)] }, new Set());
    expect(threads.find((thread) => thread.kind === 'consult')).toMatchObject({ id: 'Rio~build', title: 'Rio ↔ Dev' });
  });
});
