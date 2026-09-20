import { describe, expect, it } from 'vitest';
import { seedStage } from '../../shared/model.ts';
import { installSlices, type Deps } from '../install.ts';
import { createSeams } from '../seams.ts';
import type { Tool } from '../tools/registry.ts';
import { createUsage } from '../usage.ts';
import slice from './context.ts';

const tool = (name: string) => ({ name, description: name, parameters: {}, async run() { return { text: name }; } }) as Tool;
const deps = (extra: Partial<Deps> = {}) => ({ workspace: '/w', clients: [], usage: createUsage(null), ...extra }) as unknown as Deps;

describe('the context slice', () => {
  it('narrows a turn to what the room can use, and listens for a step that outgrew the model', async () => {
    const seams = createSeams();
    const extras = await installSlices([slice], deps({ seams }));
    expect(extras.names).toEqual(['context']);
    const all = [tool('web_search'), tool('generate_video'), tool('list_tasks')];
    expect(extras.offer(all, seedStage, 'marketing').map((one) => one.name)).toEqual(['web_search']);
    // Both halves of the turn it has a say in are wired up.
    const step = await seams.run('step:before', { roomId: 'marketing', step: 1, messages: [{ role: 'user', content: 'hello' }] });
    expect(step.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect((await seams.run('step:error', { roomId: 'marketing', step: 1, messages: [], error: 'fetch failed' })).retry).toBeUndefined();
  });

  it('installs without seams rather than not at all, so a check script still sees its offer', async () => {
    const said: string[] = [];
    const extras = await installSlices([slice], deps(), (name, error) => said.push(`${name}: ${error.message}`));
    expect(said).toEqual([]);
    expect(extras.offer([tool('browse')], seedStage, 'marketing')).toEqual([]);
  });
});
