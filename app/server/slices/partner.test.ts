import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Room, Stage } from '../../shared/model.ts';
import type { Deps, Installed } from '../install.ts';
import { companyDocOf } from '../partner/company.ts';
import { stubDeps } from '../slice-stubs.ts';
import partner from './partner.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const room = (id: string, name: string, extra: Partial<Room> = {}): Room => ({ id, name, role: 'x', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1, ...extra });

// A throwaway workspace with the real stores, and the slice installed on it. `fake: false` is a real run's start.
async function installed(extra: Partial<Deps> = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'partner-'));
  const deps = { ...stubDeps(workspace, ROOT), fake: false, ...extra } as Deps;
  const part = (await partner.install(deps)) as Installed;
  return { deps, part, workspace };
}
const withRooms = async (deps: Deps, rooms: Room[]) => { const stage = await deps.store.loadStage(); await deps.store.saveStage({ ...stage, rooms: [...stage.rooms, ...rooms] } as Stage); };

describe('the partner slice: the Company document', () => {
  it('puts the Company document on the stage at start, pinned, and writes decided decisions into it once', async () => {
    const { deps, part } = await installed();
    const doc = companyDocOf(await deps.store.loadStage())!;
    expect(doc.pinned).toBe(true);
    await deps.decisions.record({ title: 'Newsletter first', chosen: 'A weekly curated newsletter' });
    await deps.decisions.propose({ title: 'Raise now?', options: ['yes', 'no'] });
    await part.tick!();
    await part.tick!();
    const text = await deps.store.readDoc(doc.id);
    expect(text.match(/Newsletter first: A weekly curated newsletter/g)).toHaveLength(1);
    expect(text).not.toContain('Raise now?');
    await part.close!();
  });

  it('leaves the stage alone at start in fake mode, and makes the document once a partner is on it, wired to them', async () => {
    const { deps, part } = await installed({ fake: true });
    expect(companyDocOf(await deps.store.loadStage())).toBeUndefined();
    await part.tick!();
    expect(companyDocOf(await deps.store.loadStage())).toBeUndefined();
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    await part.tick!();
    const stage = await deps.store.loadStage();
    const doc = companyDocOf(stage)!;
    expect(stage.wires.filter((wire) => wire.from === 'p1' && wire.to === doc.id)).toHaveLength(1);
    await part.tick!();
    expect((await deps.store.loadStage()).wires.filter((wire) => wire.from === 'p1')).toHaveLength(1);
    await part.close!();
  });
});
