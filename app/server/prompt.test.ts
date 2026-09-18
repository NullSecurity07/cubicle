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
    const [system, ...rest] = buildMessages(stage, 'marketing', docs, [{ id: 'a', role: 'user', text: 'hi', at: 1 }]);
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
    const history = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, role: 'user' as const, text: `m${i}`, at: i }));
    const messages = buildMessages(stage, 'build', docs, history);
    expect(messages).toHaveLength(1 + 24);
    expect(messages.at(-1)!.content).toBe('m59');
  });

  it('replays an earlier tool call the way it happened, with a short result', () => {
    const history = [{ id: 'a', role: 'assistant' as const, text: 'Done.', at: 1, tools: [{ id: 'c1', name: 'write_doc', args: { doc: 'Brand doc' }, ok: true, result: 'x'.repeat(900) }] }];
    const [, call, result, words] = buildMessages(stage, 'marketing', docs, history, ['write_doc']);
    expect(call).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'write_doc', arguments: '{"doc":"Brand doc"}' } }] });
    expect(result).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(result.content).toHaveLength(300);
    expect(words).toEqual({ role: 'assistant', content: 'Done.' });
  });

  it('names the tools only when there are some', () => {
    expect(buildMessages(stage, 'build', docs, [], ['write_doc'])[0].content).toContain('write_doc');
    expect(buildMessages(stage, 'build', docs, [])[0].content).not.toContain('You can act');
  });

  it('throws for an unknown room', () => {
    expect(() => buildMessages(stage, 'nope', docs, [])).toThrow(/room/);
  });
});
