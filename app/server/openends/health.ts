import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Check } from '../../shared/openends.ts';
import models from '../models.json' with { type: 'json' };
import type { ModelClient } from '../providers.ts';
import type { EngineHealth } from '../opencode/server.ts';
import { graphifyVersion, INSTALL, mcpCommand, PIN } from '../slices/graph.ts';
import { isoDay, parseFeed, REDDIT_AGENT } from '../readers.ts';
import { whichAsync } from '../which.ts';

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
  // The side model is another model behind a provider's own keys, not more keys: it is not counted twice.
  return (models as { name: string; keyEnv: string; side?: boolean }[]).filter((entry) => !entry.side).map((entry) => ({ provider: entry.name, keys: keysOf(entry.keyEnv, env) }));
}

// A program this machine can run, looked for the way a shell looks for it.
export async function onPath(command: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await whichAsync(command, { env })) !== null;
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
  // The coder card's opencode: where its program is, and whether its server is up. Absent when nothing owns it.
  coder?: () => (EngineHealth & { bin: string | null }) | null;
  // Which yt-dlp is here, or null. Asked of the program itself, so a broken install says so too.
  ytdlp?: () => Promise<string | null>;
  // Which Graphify is here, or null, and how the coder would start its tool server (null: it cannot).
  graphify?: () => Promise<string | null>;
  graphServer?: () => string[] | null;
};

// The version yt-dlp says it is, or null when it is not on the PATH or will not run.
export async function ytdlpVersion(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!await onPath('yt-dlp', env)) return null;
  return new Promise((settle) => {
    execFile('yt-dlp', ['--version'], { env, timeout: 15_000 }, (error, stdout) => settle(error ? null : stdout.trim().split('\n')[0] || null));
  });
}

// The outside programs' rows, as the openends slice that talks to them last saw them. The dashboard reads its health
// through this, so it shows the same rows as the health panel without connecting to anything itself.
export const outsideHealth: { now: () => { name: string; ok: boolean; detail: string }[] } = { now: () => [] };

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

  const server = deps.coder?.() ?? null;
  const coder = !!server?.bin || await onPath('opencode', env);
  const megabytes = server?.rss ? ` (${Math.round(server.rss / 1024 ** 2)} MB)` : '';
  const running = !server ? '' : server.running ? `, and its server is running${megabytes}` : server.problem ? `, and its server ${server.problem}` : ', and its server starts with the first coding task';
  checks.push({
    name: 'Changing code', ok: coder,
    detail: coder ? `opencode is here${running}` : 'opencode was not found, so nobody can change a project folder',
    fix: 'Install it with: curl -fsSL https://opencode.ai/install | bash. Everything else works without it.',
  });

  const ytdlp = await (deps.ytdlp ?? (() => ytdlpVersion(env)))();
  checks.push({
    name: 'Reading videos', ok: !!ytdlp,
    detail: ytdlp ? `yt-dlp ${ytdlp} is here, so people can read a YouTube video's transcript` : 'yt-dlp was not found, so nobody can read a YouTube video',
    fix: 'Install it with: pipx install yt-dlp (or put the single yt-dlp file from its GitHub page in ~/.local/bin). Feeds and Reddit work without it.',
  });

  const graphify = await (deps.graphify ?? (() => graphifyVersion(env)))();
  const reader = (deps.graphServer ?? (() => mcpCommand('graph.json', env)))();
  const through = !reader ? '; the coder cannot read maps (no graphify-mcp with its mcp part, and no uvx)' : reader[0].endsWith('uvx') ? '; the coder reads maps through uvx, because this graphify-mcp lacks its mcp part' : '';
  checks.push({
    name: 'Mapping code', ok: !!graphify,
    detail: !graphify ? 'Graphify was not found, so nobody can map a code folder'
      : graphify === PIN ? `Graphify ${graphify} is here, so people and the coder can map a folder${through}`
      : `Graphify ${graphify} is here, but the app is tested with ${PIN}${through}`,
    fix: `Install it with: ${INSTALL}. Coding works without it.`,
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

// Can the people really read Reddit and a feed from this machine today? One request each, only when asked for, and
// the answer as it came: Reddit in particular turns some machines away, and this is where the founder finds out.
export const LIVE_FEED = 'https://hnrss.org/frontpage';
export const LIVE_REDDIT = 'https://www.reddit.com/r/startups/new.json?limit=1&raw_json=1';
export const LIVE_REDDIT_FEED = 'https://www.reddit.com/r/startups/new/.rss?limit=1';
export async function liveReaders(http: typeof fetch = fetch): Promise<Check[]> {
  const get = (url: string) => http(url, { headers: { 'user-agent': REDDIT_AGENT }, signal: AbortSignal.timeout(20_000) });
  const said = (error: unknown) => ((error as Error).name === 'TimeoutError' ? 'it took more than 20 seconds to answer' : (error as Error).message.slice(0, 160));
  const reddit = await (async (): Promise<Check> => {
    const name = 'Reading Reddit';
    const fix = 'Nothing to do: people read Reddit through its public feed instead, without scores. If both are refused, try again later; Reddit limits machines that ask often.';
    try {
      const data = await get(LIVE_REDDIT);
      if (data.ok) {
        const post = ((await data.json()) as { data?: { children?: { data?: { created_utc?: number } }[] } }).data?.children?.[0]?.data;
        return { name, ok: true, detail: `Reddit's data answered${post?.created_utc ? `; the newest post in r/startups is from ${isoDay(post.created_utc * 1000)}` : ''}`, fix: '' };
      }
      const feed = await get(LIVE_REDDIT_FEED);
      if (feed.ok) return { name, ok: true, detail: `Reddit refused its data (${data.status}) but its public feed answered, so posts come without scores`, fix: '' };
      return { name, ok: false, detail: `Reddit refused both its data (${data.status}) and its feed (${feed.status})`, fix };
    } catch (error) { return { name, ok: false, detail: `Reddit could not be reached: ${said(error)}`, fix }; }
  })();
  const feed = await (async (): Promise<Check> => {
    const name = 'Reading a feed';
    const fix = 'Check this machine is online. The feed used for the check is hnrss.org; one site being down does not stop the others.';
    try {
      const response = await get(LIVE_FEED);
      if (!response.ok) return { name, ok: false, detail: `${LIVE_FEED} answered ${response.status}`, fix };
      const read = parseFeed(await response.text());
      if (!read) return { name, ok: false, detail: `${LIVE_FEED} did not send a feed`, fix };
      const newest = read.items.map((one) => one.at ?? 0).reduce((a, b) => Math.max(a, b), 0);
      return { name, ok: true, detail: `${read.items.length} posts from "${read.title}"${newest ? `, the newest from ${isoDay(newest)}` : ''}`, fix: '' };
    } catch (error) { return { name, ok: false, detail: `${LIVE_FEED} could not be reached: ${said(error)}`, fix }; }
  })();
  return [reddit, feed];
}
