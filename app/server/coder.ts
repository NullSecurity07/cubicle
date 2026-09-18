import { execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export type CoderJob = { dir: string; task: string; onLine: (line: string) => void; signal?: AbortSignal };
export type CoderResult = { ok: boolean; summary: string; changed: string[] };
export type Coder = (job: CoderJob) => Promise<CoderResult>;

const TIME_LIMIT = 15 * 60_000;
// The harness may edit and run commands inside the project; it may not fetch the web or touch anything outside the folder.
const PERMISSION = JSON.stringify({ edit: 'allow', bash: 'allow', webfetch: 'deny', external_directory: 'deny' });

// A project is a real folder the founder named: absolute, existing, and never the home folder, the root or this app's data.
export function projectDir(path: string, forbidden: string[] = []): string {
  const raw = path.trim().replace(/^~(?=\/|$)/, homedir());
  if (!raw || !isAbsolute(raw)) throw new Error('the project card needs a full folder path, for example /home/you/code/my-app');
  const dir = resolve(raw);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`there is no folder at ${dir}`);
  if (dir === '/' || dir === resolve(homedir()) || forbidden.some((one) => dir === resolve(one) || resolve(one).startsWith(`${dir}/`))) throw new Error(`${dir} is too broad to hand to a coding agent; pick the project's own folder`);
  return dir;
}

// One event line from `opencode run --format json`, as a line a founder can read. Null for events that say nothing.
export function readEvent(line: string): { log?: string; text?: string } | null {
  let event: { type?: string; part?: { tool?: string; text?: string; state?: { status?: string; title?: string; input?: Record<string, unknown> } }; error?: unknown };
  try { event = JSON.parse(line); } catch { return null; }
  if (event.type === 'text' && event.part?.text?.trim()) return { text: event.part.text.trim() };
  if (event.type === 'error') return { log: `error: ${JSON.stringify(event.error ?? event).slice(0, 200)}` };
  if (event.type !== 'tool_use' || event.part?.state?.status !== 'completed') return null;
  const input = event.part.state.input ?? {};
  const what = String(input.command ?? event.part.state.title ?? input.filePath ?? input.pattern ?? '').replace(/\s+/g, ' ').slice(0, 120);
  return { log: `${event.part.tool} ${what}`.trim() };
}

const git = (dir: string, args: string[]) => new Promise<string>((done) => { execFile('git', ['-C', dir, ...args], { timeout: 10_000 }, (error, stdout) => done(error ? '' : stdout)); });

export function opencodeCoder(env: NodeJS.ProcessEnv = process.env): Coder {
  const bin = env.OPENCODE_BIN ?? [join(homedir(), '.opencode/bin/opencode'), '/usr/local/bin/opencode', '/usr/bin/opencode'].find((path) => existsSync(path));
  let model = env.STAGE_CODER_MODEL;
  // Free built-in models come and go; take the first one on offer unless the founder named a model.
  const freeModel = () => new Promise<string | undefined>((done) => { execFile(bin!, ['models'], { timeout: 30_000 }, (_error, stdout) => done(/^opencode\/\S*free\S*$/m.exec(stdout ?? '')?.[0])); });

  return async ({ dir, task, onLine, signal }) => {
    if (!bin) throw new Error('opencode is not installed. The founder installs it with: curl -fsSL https://opencode.ai/install | bash');
    model ??= await freeModel();
    if (!model) throw new Error('opencode offers no free model right now. The founder sets STAGE_CODER_MODEL in .env (provider/model).');
    const before = await git(dir, ['status', '--porcelain']);
    onLine(`opencode · ${model}`);
    return new Promise<CoderResult>((done) => {
      // stdin must be closed, or opencode waits on it forever.
      const run = spawn(bin, ['run', '--format', 'json', '--dir', dir, '-m', model!, task], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, OPENCODE_PERMISSION: PERMISSION } });
      const timer = setTimeout(() => run.kill('SIGTERM'), TIME_LIMIT);
      signal?.addEventListener('abort', () => run.kill('SIGTERM'), { once: true });
      let buffer = ''; let last = ''; let err = '';
      run.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
        for (const line of lines) { const event = readEvent(line); if (event?.log) onLine(event.log); if (event?.text) { last = event.text; onLine(`» ${event.text.replace(/\s+/g, ' ').slice(0, 160)}`); } }
      });
      run.stderr.on('data', (chunk) => { if (err.length < 2000) err += chunk; });
      run.on('close', async (code) => {
        clearTimeout(timer);
        const after = await git(dir, ['status', '--porcelain']);
        const was = new Set(before.split('\n'));
        const changed = after.split('\n').filter((line) => line.trim() && !was.has(line)).map((line) => line.slice(3));
        const ok = code === 0 && !signal?.aborted;
        done({ ok, changed, summary: ok ? last || 'Finished without a closing note.' : signal?.aborted ? 'Stopped by the founder.' : `opencode ended with code ${code}. ${err.trim().split('\n').slice(-2).join(' ')}`.trim() });
      });
    });
  };
}

// For browser journeys: no harness, two lines of progress, one "changed" file.
export const fakeCoder: Coder = async ({ task, onLine }) => {
  onLine('fake-coder · model none');
  await new Promise((settle) => setTimeout(settle, 150));
  onLine('edit src/example.ts');
  return { ok: true, summary: `Did: ${task}`, changed: ['src/example.ts'] };
};
