import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Installed } from '../install.ts';
import { saidNoFor } from '../partner/saidno.ts';
import { stubDeps } from '../slice-stubs.ts';
import saidno from './saidno.ts';

const ROOT = resolve(import.meta.dirname, '../../..');

// Journey 15: the founder's "Don't propose cold outreach to more makers this week" kept no entry and no reason.
describe('a no said in chat', () => {
  it('keeps a standing no with its reason, even when nothing was proposed just before it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'saidno-slice-'));
    const deps = stubDeps(workspace, ROOT);
    const part = (await saidno.install(deps)) as Installed;
    const stage = await deps.store.loadStage();
    const roomId = stage.rooms[0].id;
    await deps.seams.run('turn:before', { roomId, source: 'chat', query: 'No to the task of contacting 10 more makers, because we are at 9 jobs. Don\'t propose cold outreach to more makers this week.', messages: [] });
    const kept = await saidNoFor(workspace).list();
    expect(kept.map((one) => [one.tool, one.subject, one.reason])).toEqual(expect.arrayContaining([
      ['chat', 'contacting 10 more makers', 'we are at 9 jobs'],
      ['chat', 'cold outreach to more makers', 'we are at 9 jobs'],
    ]));
    expect(await saidNoFor(workspace).ruledOut('Contact 40 more local makers to secure the remaining 6 print jobs.')).toMatchObject({ subject: expect.stringMatching(/makers/) });
    await part.close?.();
  });
});
