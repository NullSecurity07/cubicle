import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KeysView } from '../../shared/keys-file.ts';
import type { Deps } from '../install.ts';
import { chosenBackupDir } from '../openends/backup.ts';
import keysFile, { envFileOf, failuresOf, fromOwnPage, keptChecks, rowsOf } from './keys-file.ts';
import { createUsage, type UsageBook } from '../usage.ts';
import { PLANLESS } from '../breaker.ts';
import type { ModelClient } from '../providers.ts';

const OWN = { ports: [7420, 7421], token: 't' };
const PAGE = { origin: 'http://localhost:7420', 'sec-fetch-site': 'same-origin' };
const kept = { ...process.env };
afterEach(() => { for (const name of ['STAGE_BACKUP_DIR', 'STAGE_ENV_FILE', 'OPENOUTFIND_OPERATOR_EMAIL']) { if (kept[name] === undefined) delete process.env[name]; else process.env[name] = kept[name]; } });

async function setup(before = '', usage?: UsageBook, clients: ModelClient[] = []) {
  const workspace = await mkdtemp(join(tmpdir(), 'keys-file-'));
  if (before) await writeFile(join(workspace, '.env'), before);
  const answered: { status: number; body: any }[] = [];
  let sent: unknown = {};
  const deps = { workspace, root: '/nowhere', fake: true, own: OWN, clients, usage, json: (_res: ServerResponse, status: number, body: unknown) => answered.push({ status, body }), body: async () => sent } as unknown as Deps;
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

  it('carries the line naming the free keys that would add a fallback, until they are set', async () => {
    const { call } = await setup('NVIDIA_API_KEY=nvapi-set-here-1234\n');
    const view = (await call('/api/keys-file'))!.body as KeysView;
    expect(view.fallback).toMatch(/^Keys that would add a fallback, each a free sign-up: Mistral at console\.mistral\.ai/);
    expect(view.fallback).not.toContain('NVIDIA');
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
    // Kept for this workspace, not for the machine: another workspace is not sent there.
    expect(chosenBackupDir(workspace)).toBe(usb);
    expect(process.env.STAGE_BACKUP_DIR).toBeUndefined();
    expect((await stat(usb)).isDirectory()).toBe(true);
    expect((await call('/api/keys-file/places'))!.body).toMatchObject({ current: usb, custom: true, fallback: join(workspace, 'backups') });
    expect((await call('/api/keys-file/STAGE_BACKUP_DIR', 'PUT', { value: join(workspace, 'inside') }))!.body.error).toMatch(/inside the workspace/);
    await call('/api/keys-file/STAGE_BACKUP_DIR', 'PUT', { value: '' });
    expect(chosenBackupDir(workspace)).toBeNull();
    expect((await call('/api/keys-file/places'))!.body).toMatchObject({ current: join(workspace, 'backups'), custom: false });
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

describe('a key refused in a turn, in the Keys panel (round 6)', () => {
  it('shows the key as failing from the moment a turn is refused, until it answers again', async () => {
    const usage = createUsage(null);
    const { row } = await setup('MISTRAL_API_KEY=mistral-key-0001\nNVIDIA_API_KEY=nvapi-key-0002\nNVIDIA_API_KEY_2=nvapi-key-0003\n', usage);
    expect(await row('MISTRAL_API_KEY')).toMatchObject({ state: 'set' });
    usage.failed('mistral', Object.assign(new Error('401 Unauthorized'), { status: 401 }));
    usage.failed('nvidia#2', Object.assign(new Error('401 Unauthorized'), { status: 401 }));
    expect(await row('MISTRAL_API_KEY')).toMatchObject({ state: 'failing', problem: 'refused in a turn (401)' });
    expect(await row('NVIDIA_API_KEY')).toMatchObject({ state: 'failing', problem: 'key 2: refused in a turn (401)' });
    usage.record('mistral');
    expect(await row('MISTRAL_API_KEY')).toMatchObject({ state: 'set' });
  });

  it('says a key whose plan allows no requests yet as that', async () => {
    const usage = createUsage(null);
    const { row } = await setup('MISTRAL_API_KEY=mistral-key-0001\n', usage);
    usage.failed('mistral', Object.assign(new Error('429 Rate limit exceeded'), { status: 429, headers: new Headers({ 'x-ratelimit-limit-req-minute': '0' }) }));
    expect(await row('MISTRAL_API_KEY')).toMatchObject({ state: 'failing', problem: 'its plan allows no requests yet: turn on the free plan at console.mistral.ai' });
  });
});

describe('a Mistral key whose free plan is off, in a Keys check (round 6 final)', () => {
  it('keeps saying where to turn the plan on, not the raw 429', () => {
    const failed = failuresOf([{ name: 'mistral' }], [{ ok: false, detail: PLANLESS }]);
    expect(failed.get('MISTRAL_API_KEY')).toBe('its plan allows no requests yet: turn on the free plan at console.mistral.ai');
  });

  it('brings a key refused in a turn back at once when a check finds it answering', async () => {
    const usage = createUsage(null);
    const answering: ModelClient = { name: 'mistral', model: 'm', maxPromptChars: 1000, tools: true, limits: {}, step: async () => ({ text: 'ok', calls: [] }) };
    const { call, row } = await setup('MISTRAL_API_KEY=mistral-key-0001\n', usage, [answering]);
    usage.failed('mistral', Object.assign(new Error('429 Rate limit exceeded'), { status: 429, headers: new Headers({ 'x-ratelimit-limit-req-minute': '0' }) }));
    expect(usage.dead('mistral')).toBe(true);
    await call('/api/keys-file/check', 'POST');
    expect(usage.dead('mistral')).toBe(false);
    expect(await row('MISTRAL_API_KEY')).toMatchObject({ state: 'set' });
  });

  it('marks a model whose key answered the check as checked, so its dot no longer reads untested (pass 8)', async () => {
    const usage = createUsage(null);
    const answering: ModelClient = { name: 'nvidia', model: 'k', maxPromptChars: 1000, tools: true, limits: {}, step: async (_messages, { onToken }) => { onToken('ok'); return { text: '', calls: [] }; } };
    const { call } = await setup('NVIDIA_API_KEY=nvapi-key-0001\n', usage, [answering]);
    expect(usage.info([answering])[0].checked).toBeUndefined();
    await call('/api/keys-file/check', 'POST');
    expect(usage.info([answering])[0]).toMatchObject({ name: 'nvidia', requests: 0, checked: true });
  });
});

describe('the last key check after a restart (journey 11)', () => {
  it('names a key whose check timed out or found no model as failing, with when, unless it answered since', () => {
    const kept = { nvidia: { outcome: 'slow' as const, at: 100 }, 'openrouter-qwen': { outcome: 'not-found' as const, at: 120, status: 404 }, groq: { outcome: 'ok' as const, at: 90 }, cerebras: { outcome: 'down' as const, at: 80, status: 503 } };
    const { failing, checkedAt } = keptChecks([{ name: 'nvidia' }, { name: 'openrouter-qwen' }, { name: 'groq' }, { name: 'cerebras' }], kept, (name) => (name === 'cerebras' ? 200 : undefined));
    expect(checkedAt).toBe(120);
    expect(failing.get('NVIDIA_API_KEY')).toBe('slow (no answer in 20 s)');
    expect(failing.get('OPENROUTER_API_KEY')).toBe('model not found (404), so its name needs changing');
    expect(failing.has('GROQ_API_KEY')).toBe(false);
    expect(failing.has('CEREBRAS_API_KEY')).toBe(false);
  });

  it('says nothing was checked when nothing was', () => {
    expect(keptChecks([{ name: 'groq' }], {})).toEqual({ failing: new Map(), checkedAt: null });
  });
});
