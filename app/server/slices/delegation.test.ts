import { describe, expect, it } from 'vitest';
import { seedStage } from '../../shared/model.ts';
import { installSlices, type Deps } from '../install.ts';
import { createSeams } from '../seams.ts';
import type { Tool } from '../tools/registry.ts';
import { createUsage } from '../usage.ts';
import slice from './delegation.ts';

const tool = (name: string) => ({ name, description: name, parameters: {}, async run() { return { text: name }; } }) as Tool;
const deps = () => ({ workspace: '/w', clients: [], usage: createUsage(null), busy: new Set(), seams: createSeams(), toolsFor: () => [] }) as unknown as Deps;

describe('the delegation slice', () => {
  it('offers a hand-over only to somebody who has a colleague to hand to', async () => {
    const extras = await installSlices([slice], deps());
    expect(extras.tools.map((one) => one.name)).toContain('delegate_task');
    const all = [tool('web_search'), tool('delegate_task')];
    // Nobody is wired to Maya on the seed stage.
    expect(extras.offer(all, seedStage, 'marketing').map((one) => one.name)).toEqual(['web_search']);
    const together = { ...seedStage, wires: [...seedStage.wires, { id: 'marketing-build', from: 'marketing', fromHandle: 'b', to: 'build', toHandle: 't' }] };
    expect(extras.offer(all, together, 'marketing').map((one) => one.name)).toEqual(['web_search', 'delegate_task']);
  });
});
