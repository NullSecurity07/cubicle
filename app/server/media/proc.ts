import { spawn } from 'node:child_process';

// The one way the studio runs a long program and listens to it: the renderer, the transcriber and the two models
// that run on this machine. It used to be written out four times, and every copy registered its stop after
// spawning, so a job whose stop came while it waited its turn was never told and ran to the end.

export type Ran = { code: number; out: string };
export type Listen = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  // What ends a line. The local models draw their progress bars with carriage returns, so for them those count.
  split?: RegExp;
  // Each line as it arrives, untrimmed; the caller decides what a line worth hearing looks like.
  onLine?: (line: string) => void;
  // How much of what the program printed to hand back, from the end. Nothing unless asked for: a render prints a
  // line a second for minutes, and only its last line is ever read.
  collect?: number;
  signal?: AbortSignal;
};

export function runLines(command: string, args: string[], listen: Listen): Promise<Ran> {
  const { signal, onLine, collect = 0 } = listen;
  // A job stopped before it started is not started at all.
  if (signal?.aborted) return Promise.reject(new Error('stopped'));
  const split = listen.split ?? /\n/;
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: listen.cwd, env: listen.env ?? process.env });
    let out = '';
    let rest = '';
    const read = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (collect > 0) {
        out += text;
        // Trimmed in steps rather than on every chunk, so a chatty program is not copied a byte at a time.
        if (out.length > collect * 2) out = out.slice(-collect);
      }
      if (!onLine) return;
      rest += text;
      const lines = rest.split(split);
      rest = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    const stop = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (error) => { signal?.removeEventListener('abort', stop); fail(error); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      done({ code: code ?? 1, out: collect > 0 && out.length > collect ? out.slice(-collect) : out });
    });
  });
}
