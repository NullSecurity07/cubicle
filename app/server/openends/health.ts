import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { Check } from '../../shared/openends.ts';
import models from '../models.json' with { type: 'json' };
import type { ModelClient } from '../providers.ts';

// Is everything this app leans on really here? One question a line, answered yes or no, and when the answer is no,
// what the founder would do about it — in the words they would use, not ours.
// A key's value is never read, printed or compared here. All this ever says about a key is that there is one.
const DAY = 86_400_000;

// A provider may have several keys: GROQ_API_KEY, then GROQ_API_KEY_2, _3 and so on. This counts them without ever
// looking at what they say.
export function keysOf(name: string, env: NodeJS.ProcessEnv): number {
  let found = env[name]?.trim() ? 1 : 0;
  for (let at = 2; env[`${name}_${at}`]?.trim(); at += 1) found += 1;
  return found;
}
export function keyPools(env: NodeJS.ProcessEnv): { provider: string; keys: number }[] {
  return (models as { name: string; keyEnv: string }[]).map((entry) => ({ provider: entry.name, keys: keysOf(entry.keyEnv, env) }));
}

// A program this machine can run, looked for the way a shell looks for it.
export async function onPath(command: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  for (const where of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (await access(join(where, command)).then(() => true, () => false)) return true;
  }
  return false;
}
const hasFiles = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).length > 0;
const ago = (at: number, now: number) => {
  const days = Math.floor((now - at) / DAY);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

export type HealthDeps = {
  workspace: string; root: string; env?: NodeJS.ProcessEnv; now?: () => number;
  backups: () => Promise<{ at: number }[]>; backupDir: string;
  outside: () => { name: string; ok: boolean; detail: string }[];
};

export async function checkAll(deps: HealthDeps): Promise<Check[]> {
  const { workspace, root, env = process.env, now = Date.now } = deps;
  const checks: Check[] = [];

  const pools = keyPools(env).filter((one) => one.keys > 0);
  const total = pools.reduce((sum, one) => sum + one.keys, 0);
  checks.push({
    name: 'Models',
    ok: pools.length > 0,
    detail: pools.length ? `${total} ${total === 1 ? 'key' : 'keys'}: ${pools.map((one) => `${one.provider} (${one.keys})`).join(', ')}` : 'no keys found, so nobody here can answer you',
    fix: 'Put a free key in the .env file beside the app, as GROQ_API_KEY. A second key for the same provider goes in as GROQ_API_KEY_2, a third as _3.',
  });

  const scratch = join(workspace, '.index', 'health-write-test');
  const writable = await mkdir(join(workspace, '.index'), { recursive: true }).then(() => writeFile(scratch, 'ok')).then(() => rm(scratch, { force: true })).then(() => true, () => false);
  checks.push({
    name: 'Your workspace', ok: writable,
    detail: writable ? `everything you write is kept in ${workspace}` : `nothing can be written to ${workspace}`,
    fix: 'Make sure that folder exists and that you are allowed to write in it, then start the app again.',
  });

  const recall = await hasFiles(join(root, 'app', '.cache', 'recall'));
  checks.push({
    name: 'Search by meaning', ok: recall,
    detail: recall ? 'ready on this machine' : 'the little model that does it has not been fetched yet',
    fix: 'Search for something once from the command bar. It fetches itself the first time, about 90 MB, and then works without the internet.',
  });

  const chrome = (await Promise.all(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map((one) => onPath(one, env)))).some(Boolean)
    || await hasFiles(join(root, 'app', 'node_modules', 'agent-browser'));
  checks.push({
    name: 'Browsing', ok: chrome,
    detail: chrome ? 'a browser is here for the browser cards' : 'no browser was found, so browser cards cannot open',
    fix: 'Install Chrome or Chromium from your package manager. Reading a page and searching the web work without it.',
  });

  const coder = await onPath('opencode', env);
  checks.push({
    name: 'Changing code', ok: coder,
    detail: coder ? 'opencode is here' : 'opencode was not found, so nobody can change a project folder',
    fix: 'Install it with: npm i -g opencode-ai. Everything else works without it.',
  });

  const voice = await hasFiles(join(root, 'app', '.cache', 'voice'));
  checks.push({
    name: 'Speaking out loud', ok: voice,
    detail: voice ? 'the voice is on this machine' : 'the voice has not been fetched yet',
    fix: 'Ask a voice studio for one line. The voice fetches itself the first time, about 80 MB, and then speaks without the internet.',
  });

  const held = await deps.backups();
  const newest = held[0]?.at ?? 0;
  const fresh = !!newest && now() - newest < 7 * DAY;
  checks.push({
    name: 'Backup', ok: fresh,
    detail: newest ? `${held.length} kept in ${deps.backupDir}, the newest made ${ago(newest, now())}` : `nothing has been backed up yet (they would go to ${deps.backupDir})`,
    fix: 'Open Health and press "Back up now". Five are kept, and each one holds everything you have written.',
  });

  const servers = deps.outside();
  const quiet = servers.filter((one) => !one.ok);
  if (servers.length) {
    checks.push({
      name: 'Outside tools', ok: !quiet.length,
      detail: quiet.length ? `${quiet.map((one) => `${one.name} (${one.detail})`).join(', ')}` : `${servers.length} ${servers.length === 1 ? 'program' : 'programs'} answered`,
      fix: 'Check the command or the address for that one in your mcp.json, then start the app again.',
    });
  }
  return checks;
}

// The one thing this cannot answer on its own: does a key still work? One token asked of each provider, which costs
// as close to nothing as a request can. Only run when the founder asks for it.
export async function liveChecks(clients: ModelClient[]): Promise<Check[]> {
  if (!clients.length) return [{ name: 'A word with each model', ok: false, detail: 'there is no provider to ask', fix: 'Put a free key in the .env file beside the app.' }];
  return Promise.all(clients.map(async (client) => {
    const started = Date.now();
    try {
      await client.step([{ role: 'user', content: 'Say ok.' }], { onToken: () => {}, signal: AbortSignal.timeout(30_000) });
      return { name: `A word with ${client.name}`, ok: true, detail: `answered in ${Date.now() - started} ms as ${client.model}`, fix: '' };
    } catch (error) {
      return { name: `A word with ${client.name}`, ok: false, detail: (error as Error).message.slice(0, 200), fix: `Check this provider's key in .env, and whether today's free allowance is used up.` };
    }
  }));
}
