import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PERMISSION } from './config.ts';
import { createOpencodeServer, needsRestart, portOf, reap, rssOf, serverEnv } from './server.ts';

const home = { configPath: '/w/opencode/opencode.json', configHome: '/w/opencode/settings', dataHome: '/w/opencode/data', keys: ['GROQ_API_KEY'] };

describe('the one opencode server', () => {
  it('reads its port off the line it prints when it is listening', () => {
    expect(portOf('opencode server listening on http://127.0.0.1:41873\n')).toBe(41873);
    expect(portOf('some warning\nopencode server listening on http://127.0.0.1:4096')).toBe(4096);
    expect(portOf('starting…')).toBeNull();
  });

  it('starts with only the keys its config names, its own settings and a password of its own', () => {
    const env = serverEnv({ PATH: '/bin', HOME: '/home/me', GROQ_API_KEY: 'gsk', GEMINI_API_KEY: 'AIza', GITHUB_TOKEN: 'ghp', AWS_SECRET_ACCESS_KEY: 'x' }, home, 'pw-123');
    expect(env).toMatchObject({
      PATH: '/bin', HOME: '/home/me', GROQ_API_KEY: 'gsk',
      OPENCODE_CONFIG: home.configPath, OPENCODE_PERMISSION: JSON.stringify(PERMISSION), XDG_DATA_HOME: home.dataHome, XDG_CONFIG_HOME: home.configHome,
      OPENCODE_SERVER_PASSWORD: 'pw-123',
      // None of the founder's skills or Claude Code files (~/.claude, ~/.agents) are read into the coder's prompt.
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    });
    for (const gone of ['GEMINI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY']) expect(env).not.toHaveProperty(gone);
  });

  it('reads how much memory it holds, and is restarted only when it is big and idle', () => {
    expect(rssOf('Name:\topencode\nVmRSS:\t  2150400 kB\nThreads: 12\n')).toBe(2150400 * 1024);
    expect(rssOf('Name:\topencode\n')).toBe(0);
    const big = 2.5 * 1024 ** 3;
    expect(needsRestart(big, false)).toBe(true);
    expect(needsRestart(big, true)).toBe(false);
    expect(needsRestart(512 * 1024 ** 2, false)).toBe(false);
  });

  it('lets go of a server an earlier launch left behind, and of nothing else', async () => {
    const killed: number[] = [];
    const files: Record<string, string> = { '/w/server.pid': '777', '/proc/777/cmdline': '/home/me/.opencode/bin/opencode\0serve\0--port\0' + '0', '/proc/888/cmdline': 'vim\0notes' };
    const read = async (path: string) => { if (!(path in files)) throw new Error('none'); return files[path]; };
    expect(await reap('/w/server.pid', read, (pid) => { killed.push(pid); })).toBe(true);
    files['/w/server.pid'] = '888';
    expect(await reap('/w/server.pid', read, (pid) => { killed.push(pid); })).toBe(false);
    expect(await reap('/w/missing.pid', read, (pid) => { killed.push(pid); })).toBe(false);
    expect(killed).toEqual([777]);
  });

  it('is started once however many ask, talks with its password, and is killed on the way out', async () => {
    const started: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const signals: string[] = [];
    const spawn = (_bin: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      started.push({ args, env: options.env });
      const child = Object.assign(new EventEmitter(), { pid: 4242, stderr: new PassThrough(), stdout: new PassThrough(), exitCode: null as number | null, kill: (signal: string) => { signals.push(signal); child.exitCode = 0; child.emit('exit', 0); return true; } });
      setTimeout(() => child.stdout.write('opencode server listening on http://127.0.0.1:5123\n'), 5);
      return child;
    };
    const asked: { url: string; auth: string | null; method: string }[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), method: init?.method ?? 'GET' });
      return new Response(String(url).includes('/session?') ? '{"id":"ses_1"}' : null, { status: String(url).includes('/session?') ? 200 : 204 });
    };
    const server = createOpencodeServer({ bin: '/bin/opencode', env: { PATH: '/bin' }, home: async () => home, spawn: spawn as never, fetch: fetcher as typeof fetch, listen: false });
    const [one] = await Promise.all([server.call('POST', '/session', { directory: '/code/shop', body: {} }), server.call('POST', '/session/ses_1/abort', { directory: '/code/shop' })]);
    expect(one).toEqual({ id: 'ses_1' });
    expect(started).toHaveLength(1);
    expect(started[0].args).toEqual(['serve', '--port', '0', '--hostname', '127.0.0.1']);
    expect(asked[0].url).toBe('http://127.0.0.1:5123/session?directory=%2Fcode%2Fshop');
    const password = started[0].env.OPENCODE_SERVER_PASSWORD!;
    expect(password.length).toBeGreaterThan(20);
    expect(asked[0].auth).toBe(`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);
    expect(server.health()).toMatchObject({ running: true, pid: 4242, port: 5123 });
    await server.stop();
    expect(signals).toEqual(['SIGTERM']);
    expect(server.health().running).toBe(false);
  });
});
