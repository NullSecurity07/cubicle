import { describe, expect, it } from 'vitest';
import { createSeams, SAFETY_FAILED, withSystem, type SeamName } from './seams.ts';

const turn = (query = 'go') => ({ roomId: 'build', source: 'chat' as const, query, messages: [{ role: 'user' as const, content: query }] });
const call = (args: Record<string, unknown> = {}) => ({ roomId: 'build', call: { id: 'c1', name: 'web_search', args } });

describe('seams', () => {
  it('hands the payload through the handlers in turn, each free to rewrite it', async () => {
    const seams = createSeams();
    const order: string[] = [];
    seams.on('turn:before', async (payload, next) => { order.push('first'); return next({ ...payload, query: `${payload.query} one` }); });
    seams.on('turn:before', async (payload, next) => { order.push('second'); return next({ ...payload, query: `${payload.query} two` }); });
    const out = await seams.run('turn:before', turn());
    expect(out.query).toBe('go one two');
    expect(order).toEqual(['first', 'second']);
  });

  it('lets a handler see what the ones after it made of the payload', async () => {
    const seams = createSeams();
    seams.on('step:before', async (payload, next) => ({ ...(await next(payload)), step: 9 }));
    seams.on('step:before', async (payload, next) => next({ ...payload, messages: [] }));
    const out = await seams.run('step:before', { roomId: 'build', step: 1, messages: [{ role: 'user', content: 'go' }] });
    expect(out).toEqual({ roomId: 'build', step: 9, messages: [] });
  });

  it('stops the chain where a handler does not pass it on', async () => {
    const seams = createSeams();
    let ran = false;
    seams.on('turn:before', async (payload) => ({ ...payload, query: 'stopped' }));
    seams.on('turn:before', async (payload, next) => { ran = true; return next(payload); });
    expect((await seams.run('turn:before', turn())).query).toBe('stopped');
    expect(ran).toBe(false);
  });

  it('skips a handler that throws and runs the rest', async () => {
    const seen: [SeamName, string][] = [];
    const seams = createSeams((name, error) => seen.push([name, error.message]));
    seams.on('turn:before', async () => { throw new Error('broken'); });
    seams.on('turn:before', async (payload, next) => next({ ...payload, query: 'still here' }));
    expect((await seams.run('turn:before', turn())).query).toBe('still here');
    expect(seen).toEqual([['turn:before', 'broken']]);
  });

  it('keeps what the rest of the chain did when a handler throws after passing it on', async () => {
    const seams = createSeams();
    seams.on('turn:before', async (payload, next) => { await next({ ...payload, query: 'rewritten' }); throw new Error('late'); });
    expect((await seams.run('turn:before', turn())).query).toBe('rewritten');
  });

  it('refuses the call when a check before a tool throws', async () => {
    const seams = createSeams();
    seams.on('tool:before', async () => { throw new Error('the check itself failed'); });
    seams.on('tool:before', async (payload, next) => next({ ...payload, refusal: 'never reached' }));
    expect((await seams.run('tool:before', call())).refusal).toBe(SAFETY_FAILED);
  });

  it('leaves a refusal already set alone when a later check throws', async () => {
    const seams = createSeams();
    seams.on('tool:before', async (payload, next) => next({ ...payload, refusal: 'the founder said no' }));
    seams.on('tool:before', async () => { throw new Error('broken'); });
    expect((await seams.run('tool:before', call())).refusal).toBe('the founder said no');
  });

  it('gives back what it was given when nobody is listening, and forgets a handler that was taken off', async () => {
    const seams = createSeams();
    const payload = { roomId: 'build', event: { id: 'c1', name: 'write_doc', args: {}, ok: true, result: 'done' } };
    expect(await seams.run('tool:after', payload)).toBe(payload);
    const off = seams.on('tool:after', async (one, next) => next({ ...one, event: { ...one.event, result: 'rewritten' } }));
    expect((await seams.run('tool:after', payload)).event.result).toBe('rewritten');
    off();
    expect((await seams.run('tool:after', payload)).event.result).toBe('done');
  });
});

describe('withSystem', () => {
  it('adds a paragraph to the system prompt and leaves a payload without one as it came', () => {
    const payload = { roomId: 'r', messages: [{ role: 'system' as const, content: 'You are Ana.' }, { role: 'user' as const, content: 'hi' }] };
    expect(withSystem(payload, 'Notes.').messages).toEqual([{ role: 'system', content: 'You are Ana.\n\nNotes.' }, { role: 'user', content: 'hi' }]);
    expect(payload.messages[0].content).toBe('You are Ana.');
    const bare = { messages: [{ role: 'user' as const, content: 'hi' }] };
    expect(withSystem(bare, 'Notes.')).toBe(bare);
  });
});
