import { describe, expect, it } from 'vitest';
import { labelOf } from './RoomSide';

// Cards as the stage really holds them: put down by the founder, some not filled in yet.
const node = (type: string, data: Record<string, unknown>) => ({ id: 'n', type, position: { x: 0, y: 0 }, data }) as unknown as Parameters<typeof labelOf>[0];

describe('labelOf', () => {
  it('names a note card by its title in the library, and says so when the library has not answered yet', () => {
    expect(labelOf(node('library', { noteId: 'yc' }), [{ id: 'yc', title: 'YC notes' }])).toBe('YC notes');
    expect(labelOf(node('library', { noteId: 'yc' }))).toBe('Note from the library');
  });
  it('names a card that has nothing in it yet, instead of throwing and taking the window down', () => {
    expect(labelOf(node('image', {}))).toBe('Picture');
    expect(labelOf(node('project', {}))).toBe('Project');
    expect(labelOf(node('note', {}))).toBe('Note');
    expect(labelOf(node('link', {}))).toBe('Link');
  });

  it('names a filled card by what is in it', () => {
    expect(labelOf(node('image', { path: 'media/launch.png' }))).toBe('launch.png');
    expect(labelOf(node('project', { path: '/home/me/code/shop/' }))).toBe('shop');
    expect(labelOf(node('note', { text: '  Ship on Friday\nnot before' }))).toBe('Ship on Friday');
  });
});
