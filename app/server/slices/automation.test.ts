import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { automation } from '../automation/run.ts';
import { stubDeps } from '../slice-stubs.ts';
import slice from './automation.ts';

describe('the automation slice', () => {
  it('hands the run path its automation while installed, and takes it back on close', async () => {
    const deps = stubDeps(await mkdtemp(join(tmpdir(), 'automation-')), resolve(import.meta.dirname, '../../..'));
    expect(automation()).toBeNull();
    const part = await slice.install(deps);
    expect(automation()).not.toBeNull();
    await part.close!();
    expect(automation()).toBeNull();
  });
});
