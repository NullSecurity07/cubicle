import { describe, expect, it } from 'vitest';
import { ALREADY_RAN, createGuards } from './guards.ts';
import { createSeams, type Seams } from './seams.ts';

const begin = (seams: Seams, roomId: string) => seams.run('turn:before', { roomId, source: 'chat', query: 'go', messages: [] });
const ask = (seams: Seams, roomId: string, name: string, args: Record<string, unknown>) => seams.run('tool:before', { roomId, call: { id: 'c1', name, args } });
const ran = (seams: Seams, roomId: string, name: string, args: Record<string, unknown>, ok = true) => seams.run('tool:after', { roomId, event: { id: 'c1', name, args, ok, result: 'whatever it said' } });

function setup() {
  const seams = createSeams();
  const guards = createGuards();
  seams.on('turn:before', guards.reset);
  seams.on('tool:before', guards.before);
  seams.on('tool:after', guards.after);
  return seams;
}

describe('guards', () => {
  it('refuses a call it already made and answered this turn', async () => {
    const seams = setup();
    await begin(seams, 'build');
    expect((await ask(seams, 'build', 'web_search', { queries: ['pricing'] })).refusal).toBeUndefined();
    await ran(seams, 'build', 'web_search', { queries: ['pricing'] });
    expect((await ask(seams, 'build', 'web_search', { queries: ['pricing'] })).refusal).toBe(ALREADY_RAN);
    // Asking something else, or asking the same thing of another tool, is not a repeat.
    expect((await ask(seams, 'build', 'web_search', { queries: ['churn'] })).refusal).toBeUndefined();
    expect((await ask(seams, 'build', 'read_page', { queries: ['pricing'] })).refusal).toBeUndefined();
  });

  it('lets a call that failed be tried again', async () => {
    const seams = setup();
    await begin(seams, 'build');
    await ran(seams, 'build', 'write_doc', { doc: 'Brand doc' }, false);
    expect((await ask(seams, 'build', 'write_doc', { doc: 'Brand doc' })).refusal).toBeUndefined();
  });

  it('forgets last turn, and never mixes two people working at once', async () => {
    const seams = setup();
    await begin(seams, 'build');
    await begin(seams, 'marketing');
    await ran(seams, 'build', 'web_search', { queries: ['pricing'] });
    expect((await ask(seams, 'marketing', 'web_search', { queries: ['pricing'] })).refusal).toBeUndefined();
    await begin(seams, 'build');
    expect((await ask(seams, 'build', 'web_search', { queries: ['pricing'] })).refusal).toBeUndefined();
  });

  it('leaves a refusal that was already there in the words it was given', async () => {
    const seams = setup();
    await begin(seams, 'build');
    await ran(seams, 'build', 'web_search', { queries: ['pricing'] });
    const refused = await seams.run('tool:before', { roomId: 'build', call: { id: 'c1', name: 'web_search', args: { queries: ['pricing'] } }, refusal: 'no browser is set up' });
    expect(refused.refusal).toBe('no browser is set up');
  });
});
