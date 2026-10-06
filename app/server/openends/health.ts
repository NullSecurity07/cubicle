import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Check } from '../../shared/openends.ts';
import { checkWords, type CheckOutcome } from '../../shared/model.ts';
import { outcomeOf } from '../usage.ts';
import { fallbackList, PROVIDERS } from '../keys-file/catalogue.ts';
import { planless, PLANLESS, unpaid, UNPAID } from '../breaker.ts';
import { ENTRIES, providerOf, unset, type ModelClient } from '../providers.ts';
import type { EngineHealth } from '../opencode/server.ts';
import { graphifyVersion, INSTALL, mcpCommand, PIN } from '../slices/graph.ts';
import { isoDay, parseFeed, REDDIT_AGENT } from '../readers.ts';
import { which, whichAsync } from '../which.ts';
import { FIND_VARS, outreachEnv } from '../leads/openoutreach.ts';
import { canWrite, sameDisk, type StatDev } from './backup.ts';
import { serviceRow, serviceState, type ServiceState } from '../service.ts';
import { clipsMissedToday, servedToday } from '../media/stock.ts';

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
  // The side model and a provider's second model (groq-qwen) are other models behind the same keys, not more keys:
  // each key is counted once, under the first provider that reads it.
  const seen = new Set<string>();
  return ENTRIES.filter((entry) => !entry.side && !seen.has(entry.keyEnv) && seen.add(entry.keyEnv)).map((entry) => ({ provider: entry.name, keys: keysOf(entry.keyEnv, env) }));
}

// How many of the free providers can answer here, and which names in .env would bring the rest. A provider is one
// line in models.json (the side model is not one, nor the partner's own Gemini 3.5 Flash, which hands nobody else
// a turn); it counts once everything it needs is set, the Cloudflare account
// id as much as its token. Two that can call tools is the floor: one alone has nobody to hand over to at its limit.
export function freeProviders(env: NodeJS.ProcessEnv): Check {
  const lines = ENTRIES.filter((entry) => !entry.side && !entry.partnerOnly);
  const keyed = lines.filter((entry) => !unset(entry, env).length);
  const missing = [...new Set(lines.flatMap((entry) => unset(entry, env)))];
  const callers = keyed.filter((entry) => entry.tools).length;
  return {
    name: 'Free providers', ok: callers >= 2,
    detail: `${keyed.length} of ${lines.length} keyed${missing.length ? `; unset: ${missing.join(', ')}` : ''}`,
    fix: 'Each free key you add is another day of free answers. The table under "Run it" in the README says where to make each one; put it in the .env file beside the app and start the app again.',
  };
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

// The Backup row, from one reading of the backups folder. Health and the dashboard both build it here, from the same
// reading the dashboard's own backup line uses, so the two can never say different things at once.
// A day, since one is made by itself every day; and a folder it can still be written to, or the next one fails.
// Red is for no backup, one that failed or one older than a day. Fresh ones on the workspace's own disk are a warning
// (amber): the day the disk goes, both go. "Same disk" is the same filesystem as stat sees it: two partitions of one
// drive look different, and so do two btrfs subvolumes, so the warning is only ever a floor.
export function backupRow(state: { dir: string; backups: { at: number }[]; writable: boolean; sameDisk?: boolean }, now: number): Check {
  const newest = state.backups[0]?.at ?? 0;
  const fresh = !!newest && now - newest < DAY;
  return {
    name: 'Backup', ok: fresh && state.writable, ...(fresh && state.writable && state.sameDisk ? { warn: true } : {}),
    // What is so, in one sentence, then the folder on a line of its own: a long path set inside the sentence pushed
    // the same-disk warning past the end of a dashboard tile, and the warning is the part the founder must read.
    detail: [
      [
        newest ? `${state.backups.length} kept, the newest made ${ago(newest, now)}` : 'nothing has been backed up yet',
        ...(state.writable ? [] : ['and that folder cannot be written to']),
        ...(state.sameDisk ? ['on the same disk as the workspace: a copy here dies with this disk; pick another disk'] : []),
      ].join(', '),
      newest ? `Kept in ${state.dir}` : `They would go to ${state.dir}`,
    ].join('\n'),
    fix: 'One is made by itself once a day, and five are kept. Point "Back up to…" in Health at a second disk or a synced folder: a copy on this same disk is gone with it.',
  };
}

export type HealthDeps = {
  workspace: string; root: string; env?: NodeJS.ProcessEnv; now?: () => number;
  backups: () => Promise<{ at: number }[]>; backupDir: string;
  // Which disk a folder is on; `stat` unless a test says otherwise.
  stat?: StatDev;
  outside: () => { name: string; ok: boolean; detail: string }[];
  // The coder card's opencode: where its program is, and whether its server is up. Absent when nothing owns it.
  coder?: () => (EngineHealth & { bin: string | null }) | null;
  // Which yt-dlp is here, or null. Asked of the program itself, so a broken install says so too.
  ytdlp?: () => Promise<string | null>;
  // Which Graphify is here, or null, and how the coder would start its tool server (null: it cannot).
  graphify?: () => Promise<string | null>;
  graphServer?: () => string[] | null;
  // The keys that have made today's published number of requests, by name.
  spent?: () => string[];
  // The keys a provider refuses right now and why: only the founder can turn a plan on, add a card or fix a key.
  refused?: () => Refusal[];
  // Whether the app runs as a systemd user service; asked of systemctl unless a test says otherwise.
  service?: () => Promise<ServiceState>;
  // The rows slices add about themselves. The app's own registry when left out.
  rows?: Map<string, () => Promise<Check | null> | Check | null>;
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

// Rows a slice adds about itself, by name, and takes off again when it closes. null is "nothing to say".
export const healthRows = new Map<string, () => Promise<Check | null> | Check | null>();

// The services that need nothing but a key in .env: what each one opens up, and the line that sets it up.
// `photos` is how many pictures each library served films today (`servedToday`), which is what the photographs row
// says rather than guessing from the keys.
export function keyChecks(env: NodeJS.ProcessEnv, root: string, photos: Record<string, number> = {}, clipsMissed = 0): Check[] {
  const has = (...names: string[]) => names.every((name) => !!env[name]?.trim());
  const checks: Check[] = [];
  const agentmail = has('AGENTMAIL_API_KEY');
  const gmail = has('GMAIL_USER', 'GMAIL_APP_PASSWORD');
  checks.push({
    name: 'Email', ok: agentmail || gmail,
    detail: agentmail && gmail ? 'each person has a mailbox, and mail can go out from your own address'
      : agentmail ? 'each person has a mailbox; sending as you needs GMAIL_USER and GMAIL_APP_PASSWORD'
      : gmail ? 'mail goes out from your own address; nobody can read an inbox without AGENTMAIL_API_KEY'
      : 'no mail key is set, so people draft mail that opens in your Gmail for you to send, or write it in a browser card signed in to webmail',
    fix: 'Add AGENTMAIL_API_KEY (free at agentmail.to) to .env for a mailbox per person, or GMAIL_USER and GMAIL_APP_PASSWORD to send from your own address, then start the app again.',
  });
  const cloudflare = has('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID');
  const local = env.STAGE_IMAGE_BACKEND === 'local';
  checks.push({
    name: 'Drawing pictures', ok: cloudflare || local,
    detail: cloudflare ? `Cloudflare draws them${local ? ', though STAGE_IMAGE_BACKEND=local keeps every picture on this machine' : ''}` : local ? 'every picture is drawn on this machine' : 'no Cloudflare key is set, so pictures are drawn on this machine if it can, and not at all if it cannot',
    fix: 'Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to .env. A free Cloudflare account covers hundreds of pictures a day.',
  });
  checks.push({
    name: 'Making clips', ok: has('HF_TOKEN'),
    detail: has('HF_TOKEN') ? 'a Hugging Face token is set, so films can have moving clips and lip-sync' : 'no Hugging Face token is set, so films are made of still pictures',
    fix: 'Make a free Hugging Face account, copy a read token from huggingface.co/settings/tokens into .env as HF_TOKEN, and start the app again.',
  });
  // Openverse and Wikimedia Commons answer with no key at all, so a film has real photographs either way; Pexels is
  // asked first when its key is set. The row says which library served today, and how many.
  const tally = Object.entries(photos).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ${count}`).join(', ');
  const chain = has('PEXELS_API_KEY') ? 'Pexels, then Openverse, then Wikimedia Commons' : 'Openverse, then Wikimedia Commons (no Pexels key is set)';
  checks.push({
    name: 'Real photographs', ok: true,
    detail: `${tally ? `today films used photographs from ${tally}; asked in turn: ${chain}` : `no film has used a photograph today; films ask ${chain}, and draw what none of them has`}${clipsMissed ? `; ${clipsMissed} clip${clipsMissed === 1 ? '' : 's'} asked for found no free footage today, so ${clipsMissed === 1 ? 'that scene is' : 'those scenes are'} a picture` : ''}`,
    fix: 'Nothing is needed. PEXELS_API_KEY (free at pexels.com/api) in .env adds Pexels photographs and footage first.',
  });
  checks.push({
    name: 'More music', ok: has('FREESOUND_API_KEY'),
    detail: has('FREESOUND_API_KEY') ? 'Freesound is set as a second music library' : 'films take music from the free library alone; Freesound would add a second',
    fix: 'Add FREESOUND_API_KEY (free at freesound.org/apiv2/apply) to .env. Music works without it.',
  });
  const found = outreachEnv(env, root);
  const missing = FIND_VARS.filter((name) => !found[name]);
  const uvx = which('uvx', { env, extra: env.HOME ? [join(env.HOME, '.local/bin')] : [] });
  checks.push({
    name: 'Finding leads', ok: !!uvx && !missing.length,
    detail: !uvx ? 'uvx is not on this machine, so nobody can find leads (adding them by hand still works)'
      : missing.length ? `OpenOutreach still needs ${missing.join(', ')}` : 'OpenOutreach is set up and runs through uvx',
    fix: `Install uv (docs.astral.sh/uv), then put ${FIND_VARS.join(', ')} in .env at the repository root. The Leads card works without it.`,
  });
  return checks;
}

export type Refusal = { name: string; why: 'plan' | 'card' | 'key' };
// Each refused key as the usage book knows it, one line a provider: `mistral` once, however many keys it has.
export function refusals(clients: Pick<ModelClient, 'name'>[], usage: { planOff(name: string): boolean; needsCard(name: string): boolean; dead(name: string): boolean }): Refusal[] {
  const found = new Map<string, Refusal['why']>();
  for (const { name } of clients) {
    const why = usage.planOff(name) ? 'plan' : usage.needsCard(name) ? 'card' : usage.dead(name) ? 'key' : undefined;
    if (why && !found.has(providerOf(name))) found.set(providerOf(name), why);
  }
  return [...found].map(([name, why]) => ({ name, why }));
}
const REFUSAL_WORDS: Record<Refusal['why'], string> = { plan: 'plan off', card: 'needs a card', key: 'key refused' };

export async function checkAll(deps: HealthDeps): Promise<Check[]> {
  const { workspace, root, env = process.env, now = Date.now } = deps;
  const checks: Check[] = [];

  const pools = keyPools(env).filter((one) => one.keys > 0);
  const total = pools.reduce((sum, one) => sum + one.keys, 0);
  // A key whose provider refuses it (a plan that is off, an account that wants a card) is not fine, however many keys
  // there are: it answers nobody until the founder does something only they can.
  const refused = deps.refused?.() ?? [];
  const waiting = refused.map((one) => `${one.name} ${REFUSAL_WORDS[one.why]}`).join(', ');
  checks.push({
    name: 'Models',
    ok: pools.length > 0 && !refused.length,
    detail: pools.length ? `${total} ${total === 1 ? 'key' : 'keys'}: ${pools.map((one) => `${one.provider} (${one.keys})`).join(', ')}${waiting ? `; needs you: ${waiting}` : ''}` : 'no keys found, so nobody here can answer you',
    fix: refused.length ? `${[...new Set(refused.map((one) => (one.why === 'plan' ? 'Turn on the free plan in the provider\'s console' : one.why === 'card' ? 'Add a card or payment method to the provider\'s account (or leave that provider off; the others answer)' : 'Paste a working key in Keys from the command bar')))].join('. ')}. The others answer meanwhile.`
      : 'Open Keys from the command bar and paste a free key, such as Groq\'s. A second key for the same provider goes in .env as GROQ_API_KEY_2, a third as _3.',
  });

  checks.push(freeProviders(env));
  const fallback = fallbackList((name) => !!env[name]?.trim());
  if (fallback) checks.push({ name: 'Keys that would add a fallback', ok: true, detail: fallback, fix: 'Each is a free sign-up. Paste the key in Keys from the command bar and start the app again; the partner then has another model to ask when Gemini cannot answer.' });
  // A model that has used its free turns for the day is left out until midnight UTC; the founder hears which, once.
  const spent = deps.spent?.() ?? [];
  if (spent.length) checks.push({ name: 'Free turns today', ok: true, detail: spent.map((name) => `${name}: daily free turns used, back at midnight UTC`).join('; '), fix: 'Nothing to do: the other models answer until then.' });

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

  // Whether the morning note, the bet checks, the watches and the backup happen with the window closed.
  checks.push(serviceRow(await (deps.service ?? (() => serviceState({ env })))().catch(() => ({ systemd: false, installed: false, enabled: false, active: 'inactive', path: '' }))));

  checks.push(backupRow({ dir: deps.backupDir, backups: await deps.backups(), writable: await canWrite(deps.backupDir), sameDisk: await sameDisk(workspace, deps.backupDir, deps.stat) }, now()));

  const stockDir = join(root, 'app', '.cache', 'stock');
  checks.push(...keyChecks(env, root, await servedToday(stockDir).catch(() => ({})), await clipsMissedToday(stockDir).catch(() => 0)));
  // What slices know about themselves right now (the phone, Twenty), each asked once; one that throws is left out.
  for (const row of [...(deps.rows ?? healthRows).values()]) {
    const found = await Promise.resolve().then(row).catch(() => null);
    if (found) checks.push(found);
  }

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
// What to do about a key whose plan allows no requests: nothing in .env, only the plan in the provider's console.
const planFix = (name: string) => {
  const where = PROVIDERS[ENTRIES.find((entry) => entry.name === providerOf(name))?.keyEnv ?? '']?.where;
  return `Turn on the free plan${where ? ` at ${where}` : " in the provider's console"}; the key itself is fine.`;
};

// `failed` hears each error as it came, so the usage book can know a refused key before a turn is refused by it.
// `capMs`: how long each model is given; the key check gives each 20 s, all at once, so the panel answers in 20 s.
// Each check says what it came to (`outcome`, usage.ts) and the status the provider gave, if any.
export type LiveCheck = Check & { outcome: CheckOutcome; status?: number };
export async function liveChecks(clients: ModelClient[], failed?: (client: ModelClient, error: unknown) => void, capMs?: number): Promise<LiveCheck[]> {
  if (!clients.length) return [{ name: 'A word with each model', ok: false, detail: 'there is no provider to ask', fix: 'Put a free key in the .env file beside the app.', outcome: 'failed' }];
  return Promise.all(clients.map(async (client): Promise<LiveCheck> => {
    const started = Date.now();
    // Unless capped: as long as a turn would wait for this model's first word, and 15 s more (Kimi on NVIDIA takes 13-44 s).
    const cap = capMs ?? Math.max(30_000, (client.firstWordMs ?? 0) + 15_000);
    let timedOut = false;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The cap holds even for a client that does not stop when told to, or that waits in its own queue first.
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; stop.abort(); reject(new Error(`no answer in ${Math.round(cap / 1000)} s`)); }, cap); });
      await Promise.race([client.step([{ role: 'user', content: 'Say ok.' }], { onToken: () => {}, signal: stop.signal }), late]);
      return { name: `A word with ${client.name}`, ok: true, detail: `answered in ${Date.now() - started} ms as ${client.model}`, fix: '', outcome: 'ok' };
    } catch (error) {
      const outcome = outcomeOf(error, timedOut);
      const status = timedOut ? undefined : (error as { status?: number })?.status;
      const name = `A word with ${client.name}`;
      if (!timedOut) failed?.(client, error);
      if (outcome === 'slow') return { name, ok: false, detail: `slow (no answer in ${Math.round(cap / 1000)} s)`, fix: 'Nothing to do now: the others answer first. Check again later.', outcome };
      if (outcome === 'card') return { name, ok: false, detail: UNPAID, fix: `Add a card or payment method to ${client.name}'s account, or leave it off; the others answer.`, outcome, status };
      if (outcome === 'plan') return { name, ok: false, detail: PLANLESS, fix: planFix(client.name), outcome, status };
      if (outcome === 'not-found') return { name, ok: false, detail: checkWords({ outcome, status }), fix: `${client.model} is no longer served under that name; models.json needs a new one.`, outcome, status };
      if (outcome === 'down') return { name, ok: false, detail: checkWords({ outcome, status }), fix: 'Nothing to do: the provider is having trouble; the others answer.', outcome, status };
      return { name, ok: false, detail: (error as Error).message.slice(0, 200), fix: `Check this provider's key in .env, and whether today's free allowance is used up.`, outcome, ...(status ? { status } : {}) };
    } finally { clearTimeout(timer); }
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

// The day's budget for work nobody asked for (usage.ts, createUnasked): how much of it is used, and on what. Each reason
// once, with how many times when it came up more than once, so twelve page watches read as one line, not twelve.
export function unaskedRow(state: { cap: number; used: { reason: string }[] }): Check {
  const counts = new Map<string, number>();
  for (const one of state.used) counts.set(one.reason, (counts.get(one.reason) ?? 0) + 1);
  const reasons = [...counts].map(([reason, times]) => (times > 1 ? `${reason} (${times})` : reason)).join(', ');
  const full = state.used.length >= state.cap;
  return {
    name: 'Unasked work today', ok: true, ...(full ? { warn: true } : {}),
    detail: `${state.used.length} of ${state.cap} used${reasons ? `: ${reasons}` : ''}`,
    fix: full ? 'Nothing to do: what was left waits for tomorrow, and anything you ask still gets an answer today.' : '',
  };
}
