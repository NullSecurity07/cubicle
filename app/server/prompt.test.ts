import { describe, expect, it } from 'vitest';
import { STANCE, seedStage, type Stage } from '../shared/model.ts';
import { buildMessages, wiredDocIds } from './prompt.ts';

const docs = { 'brand-doc': 'We sell calm.', other: 'SECRET' };
const stage: Stage = { ...seedStage, docs: [...seedStage.docs, { id: 'other', title: 'Other', x: 0, y: 0, w: 1, h: 1 }] };

describe('prompt', () => {
  it('finds docs wired to a room in either direction', () => {
    expect(wiredDocIds(stage, 'marketing')).toEqual(['brand-doc']);
    const reversed: Stage = { ...stage, wires: [{ id: 'w', from: 'brand-doc', fromHandle: 'l', to: 'build', toHandle: 'r' }] };
    expect(wiredDocIds(reversed, 'build')).toEqual(['brand-doc']);
    expect(wiredDocIds(reversed, 'marketing')).toEqual([]);
  });

  it('puts the persona, the stance and only wired docs in the system message', () => {
    const [system, ...rest] = buildMessages(stage, 'marketing', docs, [{ role: 'user', text: 'hi', at: 1 }]);
    expect(system.role).toBe('system');
    expect(system.content).toContain('Maya');
    expect(system.content).toContain(STANCE);
    expect(system.content).toContain('We sell calm.');
    expect(system.content).not.toContain('SECRET');
    expect(rest).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('tells a person with no docs that they have no background, and never to invent facts', () => {
    const [system] = buildMessages(stage, 'build', docs, []);
    expect(system.content).toContain('no written background');
    expect(system.content).toContain('Do not invent such facts');
  });

  it('keeps only the most recent turns', () => {
    const history = Array.from({ length: 60 }, (_, i) => ({ role: 'user' as const, text: `m${i}`, at: i }));
    const messages = buildMessages(stage, 'build', docs, history);
    expect(messages).toHaveLength(1 + 24);
    expect(messages.at(-1)!.content).toBe('m59');
  });

  it('throws for an unknown room', () => {
    expect(() => buildMessages(stage, 'nope', docs, [])).toThrow(/room/);
  });
});
