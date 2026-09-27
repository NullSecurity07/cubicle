import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAll, freeProviders, healthRows, keyChecks, keyPools, keysOf, liveChecks, liveReaders, LIVE_FEED, LIVE_REDDIT, LIVE_REDDIT_FEED, onPath, ytdlpVersion } from './health.ts';
import type { Check } from '../../shared/openends.ts';

const at = new Date('2026-09-20T09:00:00').getTime();
const DAY = 86_400_000;
const setup = async (extra: Partial<Parameters<typeof checkAll>[0]> = {}) => {
  const workspace = await mkdtemp(join(tmpdir(), 'health-'));
  // The workspace and the backups on two disks, unless a test says otherwise: tmp is one disk on most machines.
  const stat = async (path: string) => ({ dev: path === workspace ? 1 : 2 });
  return checkAll({ workspace, root: '/nowhere', env: {}, now: () => at, backupDir: '/tmp/backups', backups: async () => [], outside: () => [], stat, ...extra });
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

  it('say how many free providers can answer, and which names would bring the rest', async () => {
    const none = row(await setup(), 'Free providers');
    expect(none.ok).toBe(false);
    expect(none.detail).toMatch(/^0 of 13 keyed; unset: GROQ_API_KEY, CEREBRAS_API_KEY, GEMINI_API_KEY, NVIDIA_API_KEY, /);
    // A token without its account id is not a provider yet, and the id is named as missing.
    const env = { GROQ_API_KEY: 'sk-secret', GEMINI_API_KEY: 'AIza-secret', CLOUDFLARE_API_TOKEN: 'cf-secret' };
    const some = freeProviders(env);
    expect(some.ok).toBe(true);
    // groq, groq-qwen and gemini: the second Groq model is its own day's worth on the same key.
    expect(some.detail).toMatch(/^3 of 13 keyed; unset: CEREBRAS_API_KEY, NVIDIA_API_KEY, ZAI_API_KEY, AI_GATEWAY_API_KEY, CLOUDFLARE_ACCOUNT_ID, OLLAMA_API_KEY, SAMBANOVA_API_KEY, MISTRAL_API_KEY, OPENROUTER_API_KEY$/);
    expect(JSON.stringify(some)).not.toContain('secret');
    expect(freeProviders({ ...env, CLOUDFLARE_ACCOUNT_ID: 'abc' }).detail).toMatch(/^4 of 13 keyed/);
    expect(freeProviders({ GROQ_API_KEY: 'a' }).ok).toBe(true);
    expect(freeProviders({ GEMINI_API_KEY: 'a' }).ok).toBe(false);
    // Each key is counted once in the Models line, though three models read Groq's.
    expect(keyPools({ GROQ_API_KEY: 'a' }).filter((one) => one.keys)).toEqual([{ provider: 'groq', keys: 1 }]);
  });

  it('say in plain words what to do when there are none', async () => {
    const models = row(await setup(), 'Models');
    expect(models.ok).toBe(false);
    expect(models.detail).toBe('no keys found, so nobody here can answer you');
    expect(models.fix).toContain('GROQ_API_KEY_2');
  });
});

describe('the rest of the checks', () => {
  it('say whether the coder is here, and whether its server is up and how big it is', async () => {
    expect(row(await setup(), 'Changing code')).toMatchObject({ ok: false, detail: expect.stringContaining('opencode was not found') });
    const idle = row(await setup({ coder: () => ({ bin: '/home/me/.opencode/bin/opencode', running: false }) }), 'Changing code');
    expect(idle).toMatchObject({ ok: true, detail: 'opencode is here, and its server starts with the first coding task' });
    const up = row(await setup({ coder: () => ({ bin: '/x/opencode', running: true, pid: 12, rss: 320 * 1024 ** 2 }) }), 'Changing code');
    expect(up.detail).toBe('opencode is here, and its server is running (320 MB)');
    const gone = row(await setup({ coder: () => ({ bin: '/x/opencode', running: false, problem: 'stopped; the next coding task starts it again' }) }), 'Changing code');
    expect(gone.detail).toBe('opencode is here, and its server stopped; the next coding task starts it again');
  });

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

  it('count a backup as fine for a day and say how long ago in days', async () => {
    expect(row(await setup(), 'Backup').detail).toContain('nothing has been backed up yet');
    expect(row(await setup({ backups: async () => [{ at }] }), 'Backup')).toMatchObject({ ok: true, detail: expect.stringContaining('the newest made today') });
    expect(row(await setup({ backups: async () => [{ at: at - DAY - 1000 }, { at: at - 2 * DAY }] }), 'Backup')).toMatchObject({ ok: false, detail: expect.stringContaining('2 kept in /tmp/backups, the newest made yesterday') });
    expect(row(await setup({ backups: async () => [{ at: at - 9 * DAY }] }), 'Backup')).toMatchObject({ ok: false, detail: expect.stringContaining('9 days ago') });
    // The point of a backup is a second disk: the fix says so.
    expect(row(await setup(), 'Backup').fix).toContain('second disk');
  });

  it('count a backup on the same disk as the workspace as a problem, however fresh the newest', async () => {
    const one = row(await setup({ backups: async () => [{ at }], stat: async () => ({ dev: 7 }) }), 'Backup');
    expect(one.ok).toBe(false);
    expect(one.detail).toContain('the newest made today');
    expect(one.detail).toContain('same disk as the workspace');
    expect(row(await setup({ backups: async () => [{ at }] }), 'Backup').detail).not.toContain('same disk');
  });

  it('count a backup folder that cannot be written to as a problem, however fresh the newest', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'health-')), 'not-a-folder');
    await writeFile(file, 'x');
    const stuck = row(await setup({ backupDir: join(file, 'backups'), backups: async () => [{ at }] }), 'Backup');
    expect(stuck.ok).toBe(false);
    expect(stuck.detail).toContain('cannot be written to');
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

describe('reading videos, feeds and Reddit', () => {
  it('names the yt-dlp that is here, and says what to do when there is none', async () => {
    const here = row(await setup({ ytdlp: async () => '2026.08.19' }), 'Reading videos');
    expect(here).toMatchObject({ ok: true, detail: 'yt-dlp 2026.08.19 is here, so people can read a YouTube video\'s transcript' });
    const missing = row(await setup({ ytdlp: async () => null }), 'Reading videos');
    expect(missing.ok).toBe(false);
    expect(missing.fix).toContain('pipx install yt-dlp');
    // Nothing on the PATH is nothing to run.
    expect(await ytdlpVersion({ PATH: '/definitely/not/here' })).toBeNull();
  });

  it('names the Graphify that is here, the pin when it differs, and how the coder reads its maps', async () => {
    const pinned = row(await setup({ graphify: async () => '0.9.66', graphServer: () => ['/home/me/.local/bin/graphify-mcp', 'g'] }), 'Mapping code');
    expect(pinned).toMatchObject({ ok: true, detail: 'Graphify 0.9.66 is here, so people and the coder can map a folder' });
    const newer = row(await setup({ graphify: async () => '0.9.70', graphServer: () => ['/usr/bin/uvx', '--from', 'x'] }), 'Mapping code');
    expect(newer.detail).toBe('Graphify 0.9.70 is here, but the app is tested with 0.9.66; the coder reads maps through uvx, because this graphify-mcp lacks its mcp part');
    const missing = row(await setup({ graphify: async () => null, graphServer: () => null }), 'Mapping code');
    expect(missing.ok).toBe(false);
    expect(missing.fix).toContain('uv tool install graphifyy==0.9.66');
  });

  const answers = (table: Record<string, () => Response>) => (async (url: string) => (table[String(url)] ?? (() => new Response('', { status: 404 })))()) as typeof fetch;
  const rss = '<rss version="2.0"><channel><title>Hacker News: Front Page</title><item><title>A</title><pubDate>Wed, 23 Sep 2026 10:00:00 GMT</pubDate></item><item><title>B</title></item></channel></rss>';

  it('asks Reddit and one feed once each, and says plainly what came back', async () => {
    const [reddit, feed] = await liveReaders(answers({
      [LIVE_REDDIT]: () => Response.json({ data: { children: [{ data: { created_utc: 1790150400 } }] } }),
      [LIVE_FEED]: () => new Response(rss),
    }));
    expect(reddit).toMatchObject({ name: 'Reading Reddit', ok: true, detail: 'Reddit\'s data answered; the newest post in r/startups is from 2026-09-23' });
    expect(feed).toMatchObject({ name: 'Reading a feed', ok: true, detail: '2 posts from "Hacker News: Front Page", the newest from 2026-09-23' });
  });

  it('counts Reddit\'s feed as a way in when its data is refused, and fails only when both are', async () => {
    const [through] = await liveReaders(answers({ [LIVE_REDDIT]: () => new Response('', { status: 403 }), [LIVE_REDDIT_FEED]: () => new Response('<feed></feed>') }));
    expect(through).toMatchObject({ ok: true, detail: 'Reddit refused its data (403) but its public feed answered, so posts come without scores' });
    const [refused, feed] = await liveReaders(answers({ [LIVE_REDDIT]: () => new Response('', { status: 403 }), [LIVE_REDDIT_FEED]: () => new Response('', { status: 429 }), [LIVE_FEED]: () => new Response('<html></html>') }));
    expect(refused).toMatchObject({ ok: false, detail: 'Reddit refused both its data (403) and its feed (429)' });
    expect(feed).toMatchObject({ ok: false, detail: `${LIVE_FEED} did not send a feed` });
    const [, offline] = await liveReaders((async () => { throw new Error('getaddrinfo ENOTFOUND hnrss.org'); }) as typeof fetch);
    expect(offline).toMatchObject({ ok: false, detail: `${LIVE_FEED} could not be reached: getaddrinfo ENOTFOUND hnrss.org` });
  });
});

describe('the rows for keys and for slices', () => {
  it('say which services have their keys, and never show a value', async () => {
    const none = keyChecks({}, '/nowhere');
    expect(none.map((one) => [one.name, one.ok])).toEqual([['Email', false], ['Drawing pictures', false], ['Making clips', false], ['Real photographs', false], ['More music', false], ['Finding leads', false]]);
    expect(none.find((one) => one.name === 'Finding leads')!.detail).toMatch(/uvx is not on this machine/);
    const env = { AGENTMAIL_API_KEY: 'am-secret', CLOUDFLARE_API_TOKEN: 'cf-secret', CLOUDFLARE_ACCOUNT_ID: 'acc-secret', HF_TOKEN: 'hf_secret', PEXELS_API_KEY: 'px-secret', FREESOUND_API_KEY: 'fs-secret' };
    const some = keyChecks(env, '/nowhere');
    expect(some.filter((one) => one.ok).map((one) => one.name)).toEqual(['Email', 'Drawing pictures', 'Making clips', 'Real photographs', 'More music']);
    expect(JSON.stringify(some)).not.toContain('secret');
    expect(keyChecks({ STAGE_IMAGE_BACKEND: 'local' }, '/nowhere').find((one) => one.name === 'Drawing pictures')!.ok).toBe(true);
  });

  it('names the OpenOutreach settings still missing once uvx is here', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'uvx-'));
    await writeFile(join(bin, 'uvx'), '#!/bin/sh\n', { mode: 0o755 });
    const leads = keyChecks({ PATH: bin, OPENOUTFIND_AI_MODEL: 'm' }, '/nowhere').find((one) => one.name === 'Finding leads')!;
    expect(leads.ok).toBe(false);
    expect(leads.detail).toContain('OPENOUTFIND_LLM_API_KEY');
    expect(leads.detail).not.toContain('OPENOUTFIND_AI_MODEL');
  });

  it('adds what slices say about themselves, and leaves out one that throws', async () => {
    const rows: typeof healthRows = new Map<string, () => Promise<Check | null> | Check | null>([
      ['phone', async () => ({ name: 'Your phone', ok: true, detail: 'on', fix: '' })],
      ['broken', async () => { throw new Error('no'); }],
      ['quiet', () => null],
    ]);
    const checks = await setup({ rows });
    expect(row(checks, 'Your phone')).toMatchObject({ ok: true, detail: 'on' });
    expect(checks.some((one) => one.name === 'broken')).toBe(false);
    expect(healthRows).toBeInstanceOf(Map);
  });
});
