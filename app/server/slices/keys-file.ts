import { readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { KeyRow, KeysView } from '../../shared/keys-file.ts';
import type { Deps, Slice } from '../install.ts';
import { catalogue, SETTINGS, type KeyInfo } from '../keys-file/catalogue.ts';
import { NAME, readEnv, tailOf, withEnv } from '../keys-file/envfile.ts';
import { backupPlaces, readyFolder } from '../keys-file/places.ts';
import { backupDirOf } from '../openends/backup.ts';
import { liveChecks } from '../openends/health.ts';
import { ENTRIES, providerOf, type ModelClient } from '../providers.ts';

// The founder's keys, set from the window instead of by editing `.env` by hand. The file is the one the app reads when
// it starts: `.env` at the repository root, or beside the workspace in fake mode so a check run never touches the
// founder's own (STAGE_ENV_FILE says otherwise). A value goes in and never comes out: the panel is told there is one,
// and its last four characters when it is long. Only the app's own page may write, never a script holding the token.

export const envFileOf = (deps: Pick<Deps, 'fake' | 'workspace' | 'root'>, env: NodeJS.ProcessEnv = process.env) =>
  env.STAGE_ENV_FILE || (deps.fake ? join(deps.workspace, '.env') : join(deps.root, '.env'));

// The page in the window, and nothing else: its fetches say they are from the same site, or name one of the app's own
// ports as where they come from. A script with the launch token passes the server's gate, but not this one.
export function fromOwnPage(req: Pick<IncomingMessage, 'headers'>, own: Deps['own']): boolean {
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';
  if (one(req.headers['sec-fetch-site']) === 'same-origin') return true;
  try {
    const origin = new URL(one(req.headers.origin));
    return origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && own.ports.includes(Number(origin.port || 80));
  } catch { return false; }
}

// Which key each failed answer was: a client named `groq#2` is the second Groq key, GROQ_API_KEY_2.
export function failuresOf(clients: Pick<ModelClient, 'name'>[], checks: { ok: boolean; detail: string }[], entries: { name: string; keyEnv: string }[] = ENTRIES): Map<string, string> {
  const failed = new Map<string, string>();
  clients.forEach((client, index) => {
    const check = checks[index];
    const entry = entries.find((one) => one.name === providerOf(client.name));
    if (!check || check.ok || !entry) return;
    const at = Number(client.name.split('#')[1] ?? 1);
    const name = at > 1 ? `${entry.keyEnv}_${at}` : entry.keyEnv;
    if (!failed.has(name)) failed.set(name, check.detail);
  });
  return failed;
}

// The rows, from what the file says now, what the app started with, and the last check.
export function rowsOf(known: KeyInfo[], file: Record<string, string>, started: Record<string, string | undefined>, startedFile: Record<string, string>, failing: Map<string, string>): KeyRow[] {
  return known.map((info) => {
    const shell = !!started[info.name] && startedFile[info.name] !== started[info.name];
    // The file is what the app reads when it starts, unless the shell set the name first: then that is what counts.
    const value = shell ? started[info.name] : file[info.name];
    let spares = 0;
    for (let at = 2; (file[`${info.name}_${at}`] ?? started[`${info.name}_${at}`])?.trim(); at += 1) spares += 1;
    // A spare that failed counts against the row it belongs to, named by its number.
    const spare = [...failing].find(([name]) => name.startsWith(`${info.name}_`) && /^\d+$/.test(name.slice(info.name.length + 1)));
    const problem = !value ? undefined : failing.get(info.name) ?? (spare ? `key ${spare[0].slice(info.name.length + 1)}: ${spare[1]}` : undefined);
    return {
      name: info.name, group: info.group, label: info.label, ...(info.where ? { where: info.where } : {}),
      state: !value?.trim() ? 'missing' : problem ? 'failing' : 'set',
      ...(tailOf(value) ? { tail: tailOf(value) } : {}),
      spares, restart: info.restart, pending: info.restart && !shell && (file[info.name] ?? '') !== (startedFile[info.name] ?? ''),
      shell, ...(problem ? { problem } : {}),
    };
  });
}

const PATH = /^\/api\/keys-file\/([A-Z][A-Z0-9_]{0,63})$/;

export default {
  name: 'keys-file',
  async install(deps) {
    const file = envFileOf(deps);
    const known = catalogue();
    const writable = new Set([...known.map((one) => one.name), ...SETTINGS]);
    const liveNames = new Set([...known.filter((one) => !one.restart).map((one) => one.name), ...SETTINGS]);
    const readFileEnv = async () => readEnv(await readFile(file, 'utf8').catch(() => ''));
    // What the app started with: the environment and the file as they were, so a row can say whether a change is
    // waiting for a start, and whether a value came from the shell rather than from the file.
    const started: Record<string, string | undefined> = { ...process.env };
    const startedFile = await readFileEnv();
    let failing = new Map<string, string>();
    let checkedAt: number | null = null;
    let writing: Promise<unknown> = Promise.resolve();

    const view = async (): Promise<KeysView> => ({ file, rows: rowsOf(known, await readFileEnv(), started, startedFile, failing), checkedAt });

    // One name at a time, one write at a time, under a working name and renamed whole: a crash never leaves half a file.
    async function write(name: string, value: string | null) {
      const run = writing.then(async () => {
        const next = withEnv(await readFile(file, 'utf8').catch(() => ''), name, value);
        await writeFile(`${file}.tmp`, next, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
        // Whatever the app reads each time it needs it takes the new value now; the rest waits for a start.
        if (liveNames.has(name)) { if (value === null) delete process.env[name]; else process.env[name] = value; }
        failing.delete(name);
      });
      writing = run.catch(() => {});
      return run;
    }

    return {
      async route(req, res, path) {
        if (!path.startsWith('/api/keys-file')) return false;
        const method = req.method ?? 'GET';
        if (path === '/api/keys-file' && method === 'GET') { deps.json(res, 200, await view()); return true; }
        if (path === '/api/keys-file/places' && method === 'GET') {
          const current = backupDirOf(deps);
          const fallback = backupDirOf(deps, { ...process.env, STAGE_BACKUP_DIR: '' });
          deps.json(res, 200, { current, custom: current !== fallback, fallback, places: deps.fake ? [] : await backupPlaces() });
          return true;
        }
        // One word with every model the app started with: which of its keys still answer.
        if (path === '/api/keys-file/check' && method === 'POST') {
          const clients = deps.clients.filter((client) => client.name !== 'fake' && client.name !== 'ollama');
          failing = failuresOf(clients, await liveChecks(clients));
          checkedAt = Date.now();
          deps.json(res, 200, await view());
          return true;
        }
        const name = PATH.exec(path)?.[1];
        if (!name || method !== 'PUT') return false;
        if (!fromOwnPage(req, deps.own)) { deps.json(res, 403, { error: 'keys are set from the app\'s own window' }); return true; }
        if (!NAME.test(name) || !writable.has(name)) { deps.json(res, 400, { error: `${name} is not a name this app reads` }); return true; }
        const sent = await deps.body(req).catch(() => null);
        const typed = typeof sent?.value === 'string' ? sent.value.trim() : '';
        try {
          if (typed.length > 4000) throw new Error('that is far longer than a key');
          // A backup folder is made ready before it is written down, so the next backup never finds it missing.
          const value = !typed ? null : name === 'STAGE_BACKUP_DIR' ? await readyFolder(typed, deps.workspace) : typed;
          await write(name, value);
          deps.json(res, 200, await view());
        } catch (error) { deps.json(res, 400, { error: (error as Error).message }); }
        return true;
      },
      async close() { await writing; },
    };
  },
} satisfies Slice;
