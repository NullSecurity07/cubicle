import { spawn, type ChildProcess } from 'node:child_process';

// JSON-RPC 2.0, hand-rolled, two ways round: down a pipe to a program on this machine, or over http to one that
// answers on a URL. No dependency, and no OAuth: whatever a server needs to know it gets from its own entry.
// Every call has a timeout. A call that never comes back would otherwise hold a person's turn open for good.
export type Rpc = {
  call(method: string, params?: unknown, timeout?: number): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
};
export type Hello = (rpc: Rpc) => Promise<void>;

const CALL_MS = 20_000;
const BACKOFF = [0, 400, 1200, 3000, 6000];
// These timers are never unreferenced. A server is connected while the app is still starting, before the port is
// open, and at that moment a waiting timer may be the only thing holding the process up: unreference it and node
// decides there is nothing left to do and leaves, halfway through the start.
const sleep = (milliseconds: number) => new Promise<void>((done) => { setTimeout(done, milliseconds); });

// What came back, unwrapped. A server's own error is an error here, in its own words: the person reads it and moves on.
export function unwrap(answer: any): unknown {
  if (answer?.error) throw new Error(String(answer.error.message ?? answer.error.code ?? 'the outside tool refused'));
  return answer?.result;
}

// A program on this machine, spoken to over its own input and output: one JSON object to a line, both ways.
// It is started on the first call and started again after it dies, each time a little later than the last, so a
// server that crashes on every message cannot become a loop that spawns processes as fast as the machine allows.
export function stdioRpc(options: { command: string; args?: string[]; env?: NodeJS.ProcessEnv; cwd?: string; hello?: Hello }): Rpc {
  const waiting = new Map<number, { keep: (value: unknown) => void; drop: (error: Error) => void }>();
  let child: ChildProcess | null = null;
  let starting: Promise<void> | null = null;
  let deaths = 0;
  let next = 1;
  let gone = false;

  const fail = (why: string) => { for (const { drop } of waiting.values()) drop(new Error(why)); waiting.clear(); };

  function read(line: string) {
    let answer: any;
    try { answer = JSON.parse(line); } catch { return; /* a server that prints notes to stdout is not an answer */ }
    const held = typeof answer?.id === 'number' ? waiting.get(answer.id) : undefined;
    if (!held) return;
    waiting.delete(answer.id);
    held.keep(answer);
  }

  async function start() {
    if (child && !child.killed && child.exitCode === null) return;
    if (gone) throw new Error('this outside tool has been let go of');
    await sleep(BACKOFF[Math.min(deaths, BACKOFF.length - 1)]);
    const born = spawn(options.command, options.args ?? [], { env: options.env, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child = born;
    deaths += 1;
    let rest = '';
    born.stdout?.setEncoding('utf8');
    born.stdout?.on('data', (chunk: string) => {
      rest += chunk;
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) read(line);
    });
    // Anything a server says on its error channel is for the console, never for a person's prompt.
    born.stderr?.setEncoding('utf8');
    born.stderr?.on('data', () => {});
    born.on('error', (error: Error) => { if (child === born) child = null; fail(error.message); });
    born.on('exit', () => { if (child === born) child = null; fail('the outside tool stopped'); });
    if (options.hello) await options.hello(plain);
    // Only a handshake that got through counts as a good start: the next failure waits from the beginning again.
    deaths = 0;
  }
  const ready = () => (starting ??= start().finally(() => { starting = null; }));

  async function send(body: Record<string, unknown>, id?: number, timeout = CALL_MS) {
    const live = child;
    if (!live?.stdin?.writable) throw new Error('the outside tool is not listening');
    const answer = id === undefined ? Promise.resolve(undefined) : new Promise<unknown>((keep, drop) => {
      const timer = setTimeout(() => { waiting.delete(id); drop(new Error(`the outside tool did not answer within ${Math.round(timeout / 1000)} seconds`)); }, timeout);
      waiting.set(id, { keep: (value) => { clearTimeout(timer); keep(value); }, drop: (error) => { clearTimeout(timer); drop(error); } });
    });
    live.stdin.write(`${JSON.stringify(body)}\n`);
    return answer;
  }

  // The handshake talks to a child that is still being started, so it cannot wait on `ready` or it would wait on itself.
  const plain: Rpc = {
    call: async (method, params, timeout) => { const id = next++; return unwrap(await send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, id, timeout)); },
    notify: async (method, params) => { await send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }); },
    close: async () => {},
  };

  return {
    async call(method, params, timeout) { await ready(); return plain.call(method, params, timeout); },
    async notify(method, params) { await ready(); return plain.notify(method, params); },
    async close() {
      gone = true;
      fail('this outside tool has been let go of');
      const live = child;
      child = null;
      if (!live || live.exitCode !== null) return;
      live.stdin?.end();
      live.kill('SIGTERM');
      await Promise.race([new Promise<void>((done) => live.once('exit', () => done())), sleep(1500).then(() => { live.kill('SIGKILL'); })]);
    },
  };
}

// One frame of a server-sent stream, as a `data:` line. Several lines belong to one frame; anything else is a comment.
export function sseData(body: string): unknown[] {
  const found: unknown[] = [];
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const text = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!text) continue;
    try { found.push(JSON.parse(text)); } catch { /* a keep-alive, or half a frame: nothing to answer with */ }
  }
  return found;
}

// A server that answers on an address. It may reply as one JSON body or as a stream of frames, so both are read, and
// if it hands out a session of its own that name is carried on every later message the way it asks.
export function httpRpc(options: { url: string; headers?: Record<string, string>; fetch?: typeof fetch }): Rpc {
  const get = options.fetch ?? fetch;
  let session = '';
  let next = 1;

  async function post(body: Record<string, unknown>, id: number | undefined, timeout: number): Promise<unknown> {
    const stop = AbortSignal.timeout(timeout);
    const response = await get(options.url, {
      method: 'POST', signal: stop,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}), ...(options.headers ?? {}) },
      body: JSON.stringify(body),
    });
    const given = response.headers.get('mcp-session-id');
    if (given) session = given;
    if (!response.ok) {
      // A session the server has forgotten: drop it, and whoever asked may ask again from the beginning.
      if (response.status === 404 && session) session = '';
      throw new Error(`the outside tool answered ${response.status}`);
    }
    if (id === undefined) { await response.text().catch(() => ''); return undefined; }
    const text = await response.text();
    const answers = response.headers.get('content-type')?.includes('text/event-stream') ? sseData(text) : [text.trim() ? JSON.parse(text) : {}];
    const mine = answers.find((one) => (one as { id?: unknown }).id === id) ?? answers.at(-1);
    if (!mine) throw new Error('the outside tool answered with nothing');
    return mine;
  }

  return {
    async call(method, params, timeout = CALL_MS) { const id = next++; return unwrap(await post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, id, timeout)); },
    async notify(method, params) { await post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }, undefined, CALL_MS); },
    async close() { session = ''; },
  };
}
