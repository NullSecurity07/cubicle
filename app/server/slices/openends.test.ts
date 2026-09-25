import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Check } from '../../shared/openends.ts';
import type { Installed } from '../install.ts';
import { outsideHealth } from '../openends/health.ts';
import { stubDeps } from '../slice-stubs.ts';
import slice from './openends.ts';

const root = resolve(import.meta.dirname, '../../..');
let part: Installed | null = null;
afterEach(async () => { await part?.close?.(); part = null; });

async function setup(files: Record<string, string> = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'openends-'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(workspace, name), text);
  const deps = stubDeps(workspace, root);
  const answered: { status: number; body: any }[] = [];
  let sent: unknown = {};
  deps.json = (_res, status, body) => { answered.push({ status, body }); };
  deps.body = async () => sent as Record<string, any>;
  part = await slice.install(deps);
  const call = async (path: string, method = 'GET', body: unknown = {}) => {
    sent = body;
    const handled = await part!.route!({ method, url: path, headers: {} } as IncomingMessage, {} as ServerResponse, path);
    return handled ? answered.at(-1)! : null;
  };
  return { deps, call, workspace };
}

describe('the openends slice', () => {
  // The health answer asks real programs on this machine whether they are there (yt-dlp, Chrome, uvx, opencode); under a
  // heavy load those probes alone can take longer than the usual five seconds, so this one gets room.
  it('answers health with the key rows, and keeps a fake run\'s backups beside its workspace', { timeout: 30_000 }, async () => {
    const { call, workspace } = await setup();
    const { checks } = (await call('/api/health'))!.body as { checks: Check[] };
    expect(checks.map((one) => one.name)).toEqual(expect.arrayContaining(['Models', 'Your workspace', 'Backup', 'Email', 'Finding leads']));
    const made = await call('/api/backups', 'POST');
    expect(made!.status).toBe(200);
    expect(made!.body.dir).toBe(join(workspace, 'backups'));
    expect((await readdir(join(workspace, 'backups'))).filter((name) => name.endsWith('.tar.gz'))).toHaveLength(1);
    expect(await call('/api/nothing-here')).toBeNull();
  });

  it('names a broken mcp.json as one row, shows it on the dashboard\'s health too, and lets go on close', async () => {
    const before = outsideHealth.now;
    await setup({ 'mcp.json': '{ not json' });
    const rows = outsideHealth.now();
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    await part!.close!();
    part = null;
    expect(outsideHealth.now).toBe(before);
  });

  it('takes a skill file in switched off, and gives it back out as a file', async () => {
    const { call, deps } = await setup();
    const text = '---\nname: Cold email check\ndescription: Before any cold email goes out\n---\n\n# Cold email check\n\n## Procedure\n1. Read it aloud.\n';
    const taken = await call('/api/skill-files', 'POST', { text });
    expect(taken!.status).toBe(200);
    expect(taken!.body).toMatchObject({ name: 'Cold email check', state: 'off' });
    const out = await call(`/api/skill-files/${taken!.body.id}`);
    expect(out!.body.text).toContain('name: Cold email check');
    expect((await call('/api/skill-files', 'POST', { text: 'x'.repeat(20_001) }))!.status).toBe(400);
    expect((await deps.skills.list()).length).toBeGreaterThan(0);
  });
});
