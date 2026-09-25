import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KeysView } from '../../shared/keys-file.ts';
import type { Deps } from '../install.ts';
import keysFile, { envFileOf, failuresOf, fromOwnPage, rowsOf } from './keys-file.ts';

const OWN = { ports: [7420, 7421], token: 't' };
const PAGE = { origin: 'http://localhost:7420', 'sec-fetch-site': 'same-origin' };
const kept = { ...process.env };
afterEach(() => { for (const name of ['STAGE_BACKUP_DIR', 'STAGE_ENV_FILE', 'OPENOUTFIND_OPERATOR_EMAIL']) { if (kept[name] === undefined) delete process.env[name]; else process.env[name] = kept[name]; } });

async function setup(before = '') {
  const workspace = await mkdtemp(join(tmpdir(), 'keys-file-'));
  if (before) await writeFile(join(workspace, '.env'), before);
  const answered: { status: number; body: any }[] = [];
  let sent: unknown = {};
  const deps = { workspace, root: '/nowhere', fake: true, own: OWN, clients: [], json: (_res: ServerResponse, status: number, body: unknown) => answered.push({ status, body }), body: async () => sent } as unknown as Deps;
  const part = await keysFile.install(deps);
  const call = async (path: string, method = 'GET', body: unknown = {}, headers: Record<string, string> = PAGE) => {
    sent = body;
    const took = await part.route!({ method, headers } as unknown as IncomingMessage, {} as ServerResponse, path);
    return took ? answered.at(-1)! : null;
  };
  const row = async (name: string) => ((await call('/api/keys-file'))!.body as KeysView).rows.find((one) => one.name === name)!;
  return { workspace, call, row, file: join(workspace, '.env') };
}

describe('the keys file', () => {
  it('lives beside the workspace in fake mode and at the repository root otherwise, unless the machine says', () => {
    expect(envFileOf({ fake: true, workspace: '/w', root: '/r' }, {})).toBe('/w/.env');
    expect(envFileOf({ fake: false, workspace: '/w', root: '/r' }, {})).toBe('/r/.env');
    expect(envFileOf({ fake: false, workspace: '/w', root: '/r' }, { STAGE_ENV_FILE: '/x/.env' })).toBe('/x/.env');
  });

  it('writes a key and never gives its value back, only that it is set and its last four characters', async () => {
    const { call, row, file } = await setup('# mine\nGROQ_API_KEY=gsk_already_there_ABCD\n');
    expect(await row('GROQ_API_KEY')).toMatchObject({ state: 'set', tail: 'ABCD', pending: false, restart: true, group: 'Models', label: 'Groq' });
    expect(await row('PEXELS_API_KEY')).toMatchObject({ state: 'missing', pending: false });
    const saved = await call('/api/keys-file/PEXELS_API_KEY', 'PUT', { value: '  pexels-secret-value-9876 ' });
    expect(saved!.status).toBe(200);
    expect(JSON.stringify(saved!.body)).not.toContain('pexels-secret');
    expect(JSON.stringify(saved!.body)).not.toContain('gsk_already');
    expect(await row('PEXELS_API_KEY')).toMatchObject({ state: 'set', tail: '9876', pending: true });
    expect(await readFile(file, 'utf8')).toBe('# mine\nGROQ_API_KEY=gsk_already_there_ABCD\nPEXELS_API_KEY=pexels-secret-value-9876\n');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // Taken out again, it is missing, and nothing is waiting for a start any more.
    await call('/api/keys-file/PEXELS_API_KEY', 'PUT', { value: '' });
    expect(await row('PEXELS_API_KEY')).toMatchObject({ state: 'missing', pending: false });
  });

  it('writes only from the app\'s own page, and only names the app reads', async () => {
    const { call } = await setup();
    expect((await call('/api/keys-file/HF_TOKEN', 'PUT', { value: 'hf_x' }, { 'x-stage-token': 't' }))!.status).toBe(403);
    expect((await call('/api/keys-file/HF_TOKEN', 'PUT', { value: 'hf_x' }, { origin: 'http://evil.example' }))!.status).toBe(403);
    expect((await call('/api/keys-file/NODE_OPTIONS', 'PUT', { value: '--require x' }))!.status).toBe(400);
    expect((await call('/api/keys-file/HF_TOKEN', 'PUT', { value: 'two\nlines' }))!.body.error).toMatch(/one line/);
    expect((await call('/api/keys-file/HF_TOKEN', 'PUT', { value: 'hf_x' }, { origin: 'http://127.0.0.1:7421' }))!.status).toBe(200);
    expect(fromOwnPage({ headers: {} }, OWN)).toBe(false);
  });

  it('points backups at a folder it has made ready, at once, and back at the default when emptied', async () => {
    const { call, workspace } = await setup();
    const usb = join(await mkdtemp(join(tmpdir(), 'usb-')), 'Cubicle backups');
    expect((await call('/api/keys-file/places'))!.body).toMatchObject({ current: join(workspace, 'backups'), custom: false, places: [] });
    expect((await call('/api/keys-file/STAGE_BACKUP_DIR', 'PUT', { value: usb }))!.status).toBe(200);
    expect(process.env.STAGE_BACKUP_DIR).toBe(usb);
    expect((await stat(usb)).isDirectory()).toBe(true);
    expect((await call('/api/keys-file/places'))!.body).toMatchObject({ current: usb, custom: true, fallback: join(workspace, 'backups') });
    expect((await call('/api/keys-file/STAGE_BACKUP_DIR', 'PUT', { value: join(workspace, 'inside') }))!.body.error).toMatch(/inside the workspace/);
    await call('/api/keys-file/STAGE_BACKUP_DIR', 'PUT', { value: '' });
    expect(process.env.STAGE_BACKUP_DIR).toBeUndefined();
  });

  it('takes a name OpenOutreach reads at once, and waits for nothing', async () => {
    const { call, row } = await setup();
    await call('/api/keys-file/OPENOUTFIND_OPERATOR_EMAIL', 'PUT', { value: 'me@startup.io' });
    expect(process.env.OPENOUTFIND_OPERATOR_EMAIL).toBe('me@startup.io');
    expect(await row('OPENOUTFIND_OPERATOR_EMAIL')).toMatchObject({ state: 'set', pending: false, restart: false });
  });
});

describe('what a row says', () => {
  const known = [{ name: 'GROQ_API_KEY', group: 'Models', label: 'Groq', restart: true }];
  it('names a key set where the app was started, which .env cannot change', () => {
    expect(rowsOf(known, { GROQ_API_KEY: 'from-file' }, { GROQ_API_KEY: 'from-shell-value-1234' }, { GROQ_API_KEY: 'from-file' }, new Map())[0])
      .toMatchObject({ state: 'set', shell: true, tail: '1234', pending: false });
  });
  it('counts the spare keys and says which one failed', () => {
    const rows = rowsOf(known, { GROQ_API_KEY: 'a', GROQ_API_KEY_2: 'b', GROQ_API_KEY_3: 'c' }, {}, { GROQ_API_KEY: 'a' }, new Map([['GROQ_API_KEY', '401 invalid key']]));
    expect(rows[0]).toMatchObject({ state: 'failing', spares: 2, problem: '401 invalid key' });
    expect(rowsOf(known, { GROQ_API_KEY: 'a', GROQ_API_KEY_2: 'b' }, {}, {}, new Map([['GROQ_API_KEY_2', '401']]))[0]).toMatchObject({ state: 'failing', problem: 'key 2: 401' });
  });
  it('knows a second key\'s failure by its client\'s name', () => {
    const entries = [{ name: 'groq', keyEnv: 'GROQ_API_KEY' }, { name: 'groq-qwen', keyEnv: 'GROQ_API_KEY' }];
    const failed = failuresOf([{ name: 'groq' }, { name: 'groq#2' }, { name: 'groq-qwen' }], [{ ok: true, detail: '' }, { ok: false, detail: '401' }, { ok: false, detail: '429' }], entries);
    expect([...failed]).toEqual([['GROQ_API_KEY_2', '401'], ['GROQ_API_KEY', '429']]);
  });
});
