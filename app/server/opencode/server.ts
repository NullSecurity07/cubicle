import { spawn as spawnChild } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { childEnv } from '../safety/env.ts';
import type { CoderHome } from './config.ts';
import { readStream, type RawEvent } from './events.ts';

// One long-lived `opencode serve` for the whole app, started the first time somebody needs it, on this machine only.
// Every card talks to it over plain http; everything it does comes back on one event stream.
export type EngineHealth = { running: boolean; pid?: number; port?: number; rss?: number; problem?: string };
export type CallOptions = { directory?: string; body?: unknown };
export type Engine = {
  call<T = any>(method: string, path: string, options?: CallOptions): Promise<T>;
  listen(hear: (event: RawEvent) => void): () => void;
  health(): EngineHealth;
  restart(): Promise<void>;
  stop(): Promise<void>;
};
// Said on the stream by this app, not by opencode, when the server went away under whoever was using it.
export const GONE = 'coder.gone';

const LISTENING = /opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/;
export const portOf = (text: string): number | null => { const found = LISTENING.exec(text); return found ? Number(found[1]) : null; };

// What the child is started with: this machine's ordinary environment, the keys its config names and no others, its
// own settings folder (so the founder's global opencode config, their plugins and outside tools are never loaded), its
// own data, and a password nobody else knows.
export function serverEnv(env: NodeJS.ProcessEnv, home: CoderHome, password: string): NodeJS.ProcessEnv {
  return {
    ...childEnv(env, home.keys),
    OPENCODE_CONFIG: home.configPath, OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    XDG_DATA_HOME: home.dataHome, XDG_CONFIG_HOME: home.configHome,
    OPENCODE_SERVER_PASSWORD: password,
  };
}

// Resident memory out of `/proc/<pid>/status`, in bytes.
export const rssOf = (status: string) => Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1] ?? 0) * 1024;
const TOO_BIG = 2 * 1024 ** 3;
// A server that has grown past 2 GB is started afresh, but never under somebody's work.
export const needsRestart = (rss: number, busy: boolean) => rss > TOO_BIG && !busy;

export function findBin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.OPENCODE_BIN) return env.OPENCODE_BIN;
  const known = [join(homedir(), '.opencode/bin/opencode'), '/usr/local/bin/opencode', '/usr/bin/opencode'];
  const onPath = (env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'opencode'));
  return [...known, ...onPath].find((path) => existsSync(path)) ?? null;
}

type Child = { pid?: number; exitCode: number | null; stderr: NodeJS.ReadableStream | null; kill(signal?: NodeJS.Signals): boolean; once(event: 'exit', listener: () => void): unknown; on(event: 'exit', listener: () => void): unknown };
type Options = {
  bin: string | null; env: NodeJS.ProcessEnv; home: () => Promise<CoderHome>;
  spawn?: (bin: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'ignore', 'pipe'] }) => Child;
  fetch?: typeof fetch; listen?: boolean;
};
const START_LIMIT = 30_000;
const REOPEN = 1_500;

export function createOpencodeServer(options: Options): Engine {
  const spawn = options.spawn ?? ((bin, args, how) => spawnChild(bin, args, how) as unknown as Child);
  const fetcher = options.fetch ?? fetch;
  const hearers = new Set<(event: RawEvent) => void>();
  let child: Child | null = null;
  let base = '';
  let auth = '';
  let port: number | undefined;
  let starting: Promise<void> | null = null;
  let problem: string | undefined;
  let stream: AbortController | null = null;

  const tell = (event: RawEvent) => { for (const hear of [...hearers]) { try { hear(event); } catch { /* one card's trouble is its own */ } } };

  // The one subscription for the whole server, opened again whenever it drops for as long as the server is up.
  async function subscribe(mine: Child) {
    while (child === mine && mine.exitCode === null) {
      stream = new AbortController();
      try {
        const response = await fetcher(`${base}/global/event`, { headers: { authorization: auth }, signal: stream.signal });
        const read = readStream(tell);
        const decoder = new TextDecoder();
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) read(decoder.decode(chunk, { stream: true }));
      } catch { /* dropped or stopped: the loop decides */ }
      if (child === mine) await new Promise((settle) => setTimeout(settle, REOPEN));
    }
  }

  async function start() {
    if (!options.bin) throw new Error('opencode is not installed. The founder installs it with: curl -fsSL https://opencode.ai/install | bash');
    const home = await options.home();
    const password = randomBytes(24).toString('base64url');
    const mine = spawn(options.bin, ['serve', '--port', '0', '--hostname', '127.0.0.1'], { env: serverEnv(options.env, home, password), stdio: ['ignore', 'ignore', 'pipe'] });
    child = mine;
    auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    let said = '';
    port = await new Promise<number>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`opencode did not start in time. ${said.trim().split('\n').slice(-2).join(' ')}`.trim())), START_LIMIT);
      mine.stderr?.on('data', (chunk: Buffer) => {
        if (said.length < 4000) said += chunk;
        const found = portOf(said);
        if (found) { clearTimeout(timer); done(found); }
      });
      mine.once('exit', () => { clearTimeout(timer); fail(new Error(`opencode stopped as it started. ${said.trim().split('\n').slice(-2).join(' ')}`.trim())); });
    }).catch((error: Error) => { if (mine.exitCode === null) mine.kill('SIGKILL'); child = null; throw error; });
    base = `http://127.0.0.1:${port}`;
    problem = undefined;
    // Whatever becomes of this app, the server does not outlive it.
    const orphan = () => { if (mine.exitCode === null) mine.kill('SIGKILL'); };
    process.once('exit', orphan);
    mine.on('exit', () => {
      process.removeListener('exit', orphan);
      if (child !== mine) return;
      child = null; port = undefined; stream?.abort();
      problem = 'it stopped; the next coding task starts it again';
      tell({ type: GONE, properties: {} });
    });
    if (options.listen !== false) void subscribe(mine);
  }

  const ensure = () => {
    if (child && child.exitCode === null && port) return Promise.resolve();
    starting ??= start().finally(() => { starting = null; });
    return starting;
  };

  async function stop() {
    const mine = child;
    child = null; port = undefined; stream?.abort();
    if (!mine || mine.exitCode !== null) return;
    const gone = new Promise<void>((settle) => mine.once('exit', () => settle()));
    mine.kill('SIGTERM');
    const late = setTimeout(() => { if (mine.exitCode === null) mine.kill('SIGKILL'); }, 5_000);
    await gone;
    clearTimeout(late);
  }

  return {
    async call(method, path, { directory, body } = {}) {
      await ensure();
      const url = new URL(path, base);
      if (directory) url.searchParams.set('directory', directory);
      const response = await fetcher(url.toString(), {
        method, headers: { authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`opencode answered ${response.status}: ${text.slice(0, 200)}`);
      if (!text) return null;
      try { return JSON.parse(text); } catch { return text; }
    },
    listen(hear) { hearers.add(hear); return () => { hearers.delete(hear); }; },
    health() {
      const pid = child?.pid;
      const rss = pid ? rssOf(readFileSafely(`/proc/${pid}/status`)) : undefined;
      return { running: !!child && !!port, ...(pid ? { pid } : {}), ...(port ? { port } : {}), ...(rss ? { rss } : {}), ...(problem ? { problem } : {}) };
    },
    async restart() { await stop(); await ensure(); },
    stop,
  };
}

const readFileSafely = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };

// What the health panel reads about the coder, filled in by the slice that owns the server. The same small shared handle
// the event hub uses: one side sets it, the other asks it, and neither imports the other.
export const coderHealth: { now: () => (EngineHealth & { bin: string | null }) | null } = { now: () => null };
