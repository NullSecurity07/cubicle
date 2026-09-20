import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAll, keyPools, keysOf, liveChecks, onPath } from './health.ts';

const at = new Date('2026-09-20T09:00:00').getTime();
const DAY = 86_400_000;
const setup = async (extra: Partial<Parameters<typeof checkAll>[0]> = {}) => {
  const workspace = await mkdtemp(join(tmpdir(), 'health-'));
  return checkAll({ workspace, root: '/nowhere', env: {}, now: () => at, backupDir: '/tmp/backups', backups: async () => [], outside: () => [], ...extra });
};
const row = (checks: Awaited<ReturnType<typeof checkAll>>, name: string) => checks.find((one) => one.name === name)!;

describe('keys', () => {
  it('are counted, never read', () => {
    expect(keysOf('GROQ_API_KEY', {})).toBe(0);
    expect(keysOf('GROQ_API_KEY', { GROQ_API_KEY: 'sk-one' })).toBe(1);
    expect(keysOf('GROQ_API_KEY', { GROQ_API_KEY: 'sk-one', GROQ_API_KEY_2: 'sk-two', GROQ_API_KEY_3: 'sk-three' })).toBe(3);
    // A gap in the run stops the counting: _4 without a _3 is a typing mistake, not a fourth key.
    expect(keysOf('GROQ_API_KEY', { GROQ_API_KEY: 'a', GROQ_API_KEY_2: 'b', GROQ_API_KEY_4: 'd' })).toBe(2);
    expect(keysOf('GROQ_API_KEY', { GROQ_API_KEY: '   ' })).toBe(0);
    expect(keyPools({ GROQ_API_KEY: 'a' }).find((one) => one.provider === 'groq')?.keys).toBe(1);
  });

  it('are shown as how many there are, and no part of a value ever leaves', async () => {
    const checks = await setup({ env: { GROQ_API_KEY: 'sk-secret-value', GROQ_API_KEY_2: 'sk-another', GEMINI_API_KEY: 'AIza-secret' } });
    const models = row(checks, 'Models');
    expect(models.ok).toBe(true);
    expect(models.detail).toBe('3 keys: groq (2), gemini (1)');
    expect(JSON.stringify(checks)).not.toContain('secret');
    expect(JSON.stringify(checks)).not.toContain('AIza');
  });

  it('say in plain words what to do when there are none', async () => {
    const models = row(await setup(), 'Models');
    expect(models.ok).toBe(false);
    expect(models.detail).toBe('no keys found, so nobody here can answer you');
    expect(models.fix).toContain('GROQ_API_KEY_2');
  });
});

describe('the rest of the checks', () => {
  it('say whether the workspace can be written to', async () => {
    const mine = row(await setup(), 'Your workspace');
    expect(mine.ok).toBe(true);
    // A workspace that is really a file: nothing can be written under it, and the founder is told what to do.
    const file = join(await mkdtemp(join(tmpdir(), 'health-')), 'not-a-folder');
    await writeFile(file, 'x');
    const theirs = row(await setup({ workspace: file }), 'Your workspace');
    expect(theirs.ok).toBe(false);
    expect(theirs.detail).toContain('nothing can be written to');
    expect(theirs.fix).toContain('allowed to write');
  });

  it('count a backup as fine for a week and say how long ago in days', async () => {
    expect(row(await setup(), 'Backup').detail).toContain('nothing has been backed up yet');
    expect(row(await setup({ backups: async () => [{ at }] }), 'Backup')).toMatchObject({ ok: true, detail: expect.stringContaining('the newest made today') });
    expect(row(await setup({ backups: async () => [{ at: at - DAY }, { at: at - 2 * DAY }] }), 'Backup').detail).toContain('2 kept in /tmp/backups, the newest made yesterday');
    expect(row(await setup({ backups: async () => [{ at: at - 9 * DAY }] }), 'Backup')).toMatchObject({ ok: false, detail: expect.stringContaining('9 days ago') });
  });

  it('name the outside program that did not answer, and say nothing at all when there are none', async () => {
    expect(row(await setup(), 'Outside tools')).toBeUndefined();
    const quiet = row(await setup({ outside: () => [{ name: 'notes', ok: true, detail: '2 tools' }, { name: 'files', ok: false, detail: 'it did not answer' }] }), 'Outside tools');
    expect(quiet).toMatchObject({ ok: false, detail: 'files (it did not answer)' });
    expect(row(await setup({ outside: () => [{ name: 'notes', ok: true, detail: '2 tools' }] }), 'Outside tools')).toMatchObject({ ok: true, detail: '1 program answered' });
  });

  it('every one of them says what to do about it', async () => {
    for (const check of await setup()) expect(check.fix.length).toBeGreaterThan(20);
    expect(await onPath('definitely-not-a-program-here', { PATH: '/bin' })).toBe(false);
  });
});

describe('a word with each model', () => {
  it('asks each one for a token and reports what came back', async () => {
    const good = { name: 'groq', model: 'gpt-oss', step: async () => ({ text: 'ok', calls: [] }) };
    const bad = { name: 'gemini', model: 'flash', step: async () => { throw new Error('401 the key is not valid'); } };
    const checks = await liveChecks([good, bad] as never);
    expect(checks[0]).toMatchObject({ name: 'A word with groq', ok: true });
    expect(checks[1]).toMatchObject({ name: 'A word with gemini', ok: false, detail: '401 the key is not valid' });
    expect((await liveChecks([]))[0].ok).toBe(false);
  });
});
