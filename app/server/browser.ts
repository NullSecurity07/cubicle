import { execFile, execFileSync, spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Reader } from './readers.ts';

// How a browser card's Chrome starts: `profile` is a folder that keeps its logins between runs, `headed` opens a real
// window on the founder's desktop. Both take effect when the session starts, so changing them means closing it first.
// `pace` is the pause before each step, in milliseconds between a least and a most; there is none when it is absent.
export type Launch = { profile?: string; headed?: boolean; pace?: [number, number] };
// Runs one agent-browser command in a named session and returns what it printed.
export type Runner = (session: string, args: string[], launch?: Launch) => Promise<string>;
type SearchHit = { title: string; url: string; snippet: string; date?: string };
// How far back a search may look. Only an engine that really supports it gets it; see ENGINES.
export type Recent = 'day' | 'week' | 'month' | 'year';
export type Browser = ReturnType<typeof createBrowser>;

const MAX_AT_ONCE = 4;
const PAGE_CHARS = 8000;
const SNAPSHOT_CHARS = 7000;
export const CHROMES = ['/usr/bin/google-chrome-stable', '/usr/sbin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];

// People may read the open web, never the founder's own machine or network: a page that says
// "now open http://localhost…" must get nowhere.
const LOCAL_REFUSED = 'addresses on this machine or the local network cannot be opened';
export function webUrl(raw: string): string {
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`); } catch { throw new Error(`not a web address: ${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`only http and https pages can be opened, not ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
    || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
  if (local) throw new Error(LOCAL_REFUSED);
  return url.href;
}

// The one address this app will open on this machine: the product the founder is building, typed by the founder on
// their own Video studio card. A product in the middle of being built lives on localhost, so a screenshot of it has to
// be allowed — but only here, only for a founder-typed address, and never down any path a person can reach.
function ownUrl(raw: string): string {
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `http://${raw}`); } catch { throw new Error(`not a web address: ${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`only http and https pages can be opened, not ${url.protocol}`);
  return url.href;
}

// A public name can still point at this machine. Asked before Chrome opens an address; a name that cannot be resolved
// is left for Chrome to fail on.
export type Resolve = (host: string) => Promise<string[]>;
export const dnsResolve: Resolve = async (host) => (await lookup(host, { all: true })).map((found) => found.address);
export async function publicUrl(raw: string, resolveHost?: Resolve): Promise<string> {
  const href = webUrl(raw);
  if (!resolveHost) return href;
  const host = new URL(href).hostname.replace(/^\[|\]$/g, '');
  for (const address of await resolveHost(host).catch(() => [])) webUrl(`http://${address.includes(':') ? `[${address}]` : address}/`);
  return href;
}

// Search engines wrap each result in a redirect: Bing packs the real address as base64 in `u`, DuckDuckGo as `uddg`.
export function unwrapRedirect(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/') return url.searchParams.get('uddg') ?? href;
    const packed = url.hostname.endsWith('bing.com') && url.pathname.startsWith('/ck/') ? url.searchParams.get('u') : null;
    if (!packed?.startsWith('a1')) return href;
    const real = Buffer.from(packed.slice(2), 'base64url').toString('utf8');
    return /^https?:\/\//.test(real) ? real : href;
  } catch { return href; }
}

const hits = (rows: string, title: string, snippet: string, date: string) => `JSON.stringify([...document.querySelectorAll("${rows}")].slice(0,6).map(r=>({title:(r.querySelector("${title}")?.textContent||"").trim(),url:r.querySelector("${title}")?.href||r.querySelector("${title} a")?.href||"",snippet:(r.querySelector("${snippet}")?.textContent||"").trim().slice(0,180),date:(r.querySelector("${date}")?.textContent||"").trim().slice(0,40)})))`;
// DuckDuckGo's HTML endpoint narrows by date with `df`; Bing's search page has no honest equivalent, so it says so
// rather than pretending. Tried in order for each query; an engine that answers with nothing (a challenge page, a
// changed layout) hands over to the next.
const DF: Record<Recent, string> = { day: 'd', week: 'w', month: 'm', year: 'y' };
export const ENGINES = [
  { name: 'duckduckgo', narrows: true, url: (query: string, recent?: Recent) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}${recent ? `&df=${DF[recent]}` : ''}`, read: hits('.result:not(.result--ad)', '.result__a', '.result__snippet', '.result__timestamp') },
  { name: 'bing', narrows: false, url: (query: string) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`, read: hits('li.b_algo', 'h2 a', '.b_caption p, p', '.news_dt') },
];

// How old a result is, so nobody quotes a four-year-old page as this morning's news: the engine's own stamp when it
// gives one, otherwise the date many pages put at the head of their own snippet, lifted out so it is not said twice.
const DATED = /^\s*(\d{4}-\d{2}-\d{2}|\d{1,2} [A-Z][a-z]{2,8},? \d{4}|[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}|\d+ (?:hours?|days?|weeks?|months?|years?) ago)\s*[·•\-–—:|]?\s*/;
export function aged(hit: SearchHit): { when: string; snippet: string } {
  const stamp = hit.date?.trim();
  if (stamp) return { when: stamp, snippet: hit.snippet };
  const found = DATED.exec(hit.snippet);
  return found ? { when: found[1], snippet: hit.snippet.slice(found[0].length) } : { when: '', snippet: hit.snippet };
}
// A site that answers with a human check instead of its page. The person must hear that plainly, or it will guess the content.
const WALL = /prove your humanity|verify (that )?you('| a)re (a )?human|are you a robot|unusual traffic|complete the (following )?challenge|checking your browser|just a moment|access denied|attention required|enable javascript and cookies|captcha/i;
const walled = (title: string, text: string) => WALL.test(title) || (text.length < 1200 && WALL.test(text));
export const WALL_NOTE = 'This site asked for a human check and did not show its page. Do not guess what it says, and do not try to pass the check. Tell the founder it is behind a bot wall; another source may have the same facts.';
const CARD_WALL_NOTE = 'On a browser card the founder can press "Show window", pass the check or sign in by hand, and you carry on from there.';
const THIN = 400;

const READ_PAGE = `JSON.stringify((()=>{const pick=document.querySelector("article")||document.querySelector("main")||document.querySelector("[role=main]")||document.body;return{title:document.title,url:location.href,text:(pick.innerText||"").replace(/\\n{3,}/g,"\\n\\n").trim()}})())`;
// `eval` prints its value as JSON; a value that is itself JSON text arrives wrapped once more.
const unwrap = <T>(printed: string): T => { const once = JSON.parse(printed.trim()); return (typeof once === 'string' ? JSON.parse(once) : once) as T; };

// Headless Chrome calls itself "HeadlessChrome", and most search engines refuse that name on sight. It is the founder's
// own Chrome, so it says so, with its real version. Nothing else about the session is disguised: sites that still ask
// for a human check get left alone.
export function honestUserAgent(version: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const major = /(\d+)\.\d+\.\d+/.exec(version)?.[1];
  if (!major) return undefined;
  const system = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export function realRunner(env: NodeJS.ProcessEnv = process.env): Runner {
  const bin = resolve(import.meta.dirname, '../node_modules/.bin/agent-browser');
  const chrome = env.AGENT_BROWSER_EXECUTABLE_PATH ?? CHROMES.find((path) => existsSync(path));
  let agent = env.AGENT_BROWSER_USER_AGENT;
  if (!agent && chrome) { try { agent = honestUserAgent(execFileSync(chrome, ['--version'], { encoding: 'utf8', timeout: 5000 })); } catch { /* keep the default */ } }
  return (session, args, launch) => new Promise((done, fail) => {
    const how = { ...(launch?.profile ? { AGENT_BROWSER_PROFILE: launch.profile } : {}), ...(launch?.headed ? { AGENT_BROWSER_HEADED: '1' } : {}) };
    execFile(bin, ['--session', session, ...args], { timeout: 45_000, maxBuffer: 8_000_000, env: { ...env, ...(chrome ? { AGENT_BROWSER_EXECUTABLE_PATH: chrome } : {}), ...(agent ? { AGENT_BROWSER_USER_AGENT: agent } : {}), ...how } },
      (error, stdout, stderr) => (error ? fail(new Error((stderr || stdout || error.message).trim().slice(0, 300))) : done(stdout)));
  });
}

// Stand-in for browser journeys: no Chrome, fixed answers. It remembers where each session was last sent, so a card
// sent to LinkedIn lands on its sign-in page and a journey can see a card that is not signed in. A session never sent
// anywhere is not running, and says nothing, as a real one does; otherwise a new app card would read as signed in.
const fakeOpened = new Map<string, string>();
// The site a search address was narrowed to with `site:`, or nothing.
const fakeSiteOf = (address: string): string => {
  let query = '';
  try { query = new URL(address).searchParams.get('q') ?? ''; } catch { return ''; }
  return /(?:^|\s)site:(\S+)/.exec(query)?.[1] ?? '';
};
export const fakeRunner: Runner = async (session, args) => {
  if (args[0] === 'open') fakeOpened.set(session, args[1] ?? '');
  if (args[0] === 'close') fakeOpened.delete(session);
  if (args[0] === 'get' && args[1] === 'url') {
    const last = fakeOpened.get(session);
    return last === undefined ? '' : /linkedin\.com/i.test(last) ? 'https://www.linkedin.com/login\n' : 'https://example.com/\n';
  }
  if (args[0] === 'eval' && ENGINES.some((engine) => engine.read === args[1])) {
    // A search inside one site answers with a page on that site, as a real engine would; anything else, the old example.
    const host = fakeSiteOf(fakeOpened.get(session) ?? '');
    if (host) return JSON.stringify(JSON.stringify([{ title: `A page on ${host}`, url: `https://${host}/a-page`, snippet: 'An example.' }]));
    return JSON.stringify(JSON.stringify([{ title: 'Example result', url: 'https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8', snippet: 'An example.' }]));
  }
  if (args[0] === 'eval') return JSON.stringify(JSON.stringify({ title: 'Example Domain', url: 'https://example.com/', text: `This domain is for use in examples. ${'It is reserved for documentation and may be used without asking. '.repeat(3)}`.trim() }));
  if (args[0] === 'snapshot') return '- heading "Example Domain" [ref=e1]\n- link "More information" [ref=e2]\n';
  // A session that is not running has no live view either, so watching it has to open a page first.
  if (args[0] === 'stream' && args[1] === 'status' && !fakeOpened.has(session)) return '';
  if (args[0] === 'stream') return 'Streaming enabled on ws://127.0.0.1:1\n';
  if (args[0] === 'get') return 'https://example.com/\n';
  return '✓ done\n';
};

// Opens the founder's own Chrome, not automated, on a card's profile folder at the app's home address, and settles when
// that Chrome exits. Sites such as Google refuse sign-in in an automated browser, and this one is not.
// `end` closes it for the founder, since Chrome can keep running after its last window closes.
export type Hand = (profile: string, home: string) => { done: Promise<void>; end: () => void };
function chromeByHand(env: NodeJS.ProcessEnv = process.env): Hand {
  return (profile, home) => {
    const chrome = env.AGENT_BROWSER_EXECUTABLE_PATH ?? CHROMES.find((path) => existsSync(path));
    if (!chrome) return { done: Promise.reject(new Error('no Chrome was found on this machine')), end: () => {} };
    // Not detached, so its exit is seen; no background mode, so closing the last window ends it.
    const child = spawn(chrome, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--new-window', webUrl(home)], { stdio: 'ignore' });
    const done = new Promise<void>((settle, fail) => { child.once('error', fail); child.once('exit', () => settle()); });
    return { done, end: () => { child.kill('SIGTERM'); } };
  };
}
// Stand-in for journeys: "closes" after a moment or when ended, whichever comes first.
export const fakeHand: Hand = () => {
  let end = () => {};
  const done = new Promise<void>((settle) => { const timer = setTimeout(settle, 300); end = () => { clearTimeout(timer); settle(); }; });
  return { done, end };
};

// Jina's public reader fetches a page from their side and returns markdown. Only the address leaves the machine. No key.
export const jinaReader: Reader = async (url) => {
  const response = await fetch(`https://r.jina.ai/${url}`, { headers: { 'x-return-format': 'markdown' }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!response?.ok) return null;
  const body = await response.text();
  const title = /^Title: (.*)$/m.exec(body)?.[1]?.trim() ?? '';
  const text = body.replace(/^Title: .*$/m, '').replace(/^URL Source: .*$/m, '').replace(/^Markdown Content:\s*$/m, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text };
};

// Clicks that send, publish, pay or destroy something. Browsing is free; these wait for the founder.
const OUTWARD = /^(send|reply|forward|post|publish|tweet|submit|share|comment|pay|buy|purchase|order|checkout|place order|subscribe|confirm|delete|remove|unsubscribe|sign up|create account|register|connect|follow|unfollow|like|repost|retweet|endorse|message|accept|invite)\b/i;
// A cookie banner is not the founder speaking to anyone, whatever its button starts with.
const COOKIE = /cookie/i;
const MAIL_HOSTS = /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.proton\.me|mail\.yahoo\.com|app\.fastmail\.com|mail\.zoho\.com|app\.tuta\.com)$/;
// The role and accessible name of a ref in a snapshot line such as `- button "Send" [ref=e44]`: '' for an element
// without a name, null for a ref that is not on the page.
export const elementOfRef = (tree: string, ref: string) => { const found = new RegExp(`^\\s*- (\\w+)(?: "((?:[^"\\\\]|\\\\.)*)")?[^\\n]*\\[ref=${ref.replace(/^@/, '')}\\]`, 'm').exec(tree); return found ? { role: found[1], name: found[2] ?? '' } : null; };
export const nameOfRef = (tree: string, ref: string) => elementOfRef(tree, ref)?.name ?? null;
// On an app card, the founder's own account, a click goes ahead without asking only when it plainly reads: moving to
// another page, a tab, a search box or a field, or a button that shows more, filters or sorts. Anything else could
// act as the founder, whatever it is called or when it is called nothing at all.
const READ_ROLES = new Set(['link', 'tab', 'searchbox', 'textbox', 'combobox', 'option', 'heading', 'treeitem']);
const READ_NAMES = /^(search|show|see|view|more|less|load more|expand|collapse|next|previous|back|close|dismiss|sort|filters?|all filters)\b|\bfilters?\b/i;

// `direct` readers know a site's feed or API and go first; `fallback` readers are asked, in order, when the local browser got nothing.
type Readers = { direct: Reader[]; fallback: Reader[] };

export function createBrowser(run: Runner, readers: Readers = { direct: [], fallback: [] }, resolveHost?: Resolve, hand: Hand = chromeByHand()) {
  const outer = run;
  // The founder's own Chrome per profile folder while it is open, so a second press does not start another.
  const hands = new Map<string, { done: Promise<void>; end: () => void }>();
  const seen = new Map<string, { tree: string; address: string }>();
  // What was last typed in each session, and into what: the question before a step that could send it shows it.
  const typed = new Map<string, { field: string; text: string }>();
  // Each session is a Chrome tab set with its own memory; only a few run at once, the rest wait their turn.
  let active = 0;
  const waiting: (() => void)[] = [];
  async function slot<T>(job: () => Promise<T>): Promise<T> {
    if (active >= MAX_AT_ONCE) await new Promise<void>((go) => waiting.push(go));
    active += 1;
    try { return await job(); } finally { active -= 1; waiting.shift()?.(); }
  }
  let counter = 0;
  const scratch = async <T>(job: (session: string) => Promise<T>) => slot(async () => {
    const session = `scratch-${process.pid}-${counter += 1}`;
    try { return await job(session); } finally { await run(session, ['close']).catch(() => {}); }
  });
  const settled = async <T>(jobs: Promise<T>[], label: (index: number) => string) => (await Promise.allSettled(jobs))
    .map((result, index) => (result.status === 'fulfilled' ? result.value : `## ${label(index)}\nFailed: ${(result.reason as Error).message}`));
  // One lasting session, one item after another, each failure said in its own block; the session is left open.
  const inOrder = async (session: string, items: string[], job: (session: string, item: string) => Promise<string>) => {
    const blocks: string[] = [];
    for (const item of items) blocks.push(await slot(() => job(session, item)).catch((error: Error) => `## ${item}\nFailed: ${error.message}`));
    return blocks;
  };

  return {
    // All queries at once, each in its own throwaway session. `recent` asks for the last day, week, month or year.
    // Given a lasting `session`, such as a source card's, they run there one after another, and it stays open to be watched.
    async search(queries: string[], recent?: Recent, session?: string): Promise<string> {
      const one = async (session: string, query: string) => {
        for (const engine of ENGINES) {
          const found = await run(session, ['open', engine.url(query, recent)]).then(() => run(session, ['eval', engine.read])).then((printed) => unwrap<SearchHit[]>(printed).filter((hit) => hit.url), () => []);
          if (!found.length) continue;
          const lines = found.map((hit, index) => { const { when, snippet } = aged(hit); return `${index + 1}. ${hit.title || '(untitled)'}\n   ${unwrapRedirect(hit.url)}\n   ${when ? `(${when}) ` : ''}${snippet}`; });
          // An engine that cannot narrow still answers rather than leaving the person with nothing, but it says so:
          // silently ignoring the ask is how an old page gets read as this year's.
          const wide = recent && !engine.narrows ? `\nThese are not limited to the last ${recent}: ${engine.name} answered and cannot narrow by date. Check each date yourself.` : '';
          return `## ${query}\n${lines.join('\n')}${wide}`;
        }
        return `## ${query}\nNo results: every search engine refused or came back empty.`;
      };
      const blocks = session ? await inOrder(session, queries, one) : await settled(queries.map((query) => scratch((scratched) => one(scratched, query))), (index) => queries[index]);
      return blocks.join('\n\n');
    },
    // One page as title and text, for a link card. Same path as `read`: local browser, then the reader service; a wall is said plainly.
    async page(raw: string): Promise<{ title: string; text: string }> {
      const block = await this.read([raw]);
      const [head, , ...rest] = block.split('\n');
      return { title: head.replace(/^## /, '').slice(0, 160), text: rest.join('\n').trim().slice(0, 5000) || block.slice(0, 600) };
    },
    // All pages at once: the readable text of each, cut to a size a model can afford.
    // Given a lasting `session`, they load there one after another, since one window shows one page at a time.
    async read(urls: string[], session?: string): Promise<string> {
      const one = async (session: string, raw: string) => {
        const address = await publicUrl(raw, resolveHost);
        // A site with a feed or an official API is read through it: faster, and it works where the site walls browsers.
        for (const reader of readers.direct) {
          const known = await reader(address).catch(() => null);
          if (known && known.text.length >= THIN) return `## ${known.title || address}\n${address}\n\n${known.text.length > PAGE_CHARS ? `${known.text.slice(0, PAGE_CHARS)}\n… (cut at ${PAGE_CHARS} of ${known.text.length} characters)` : known.text}`;
        }
        let page = await run(session, ['open', address]).then(() => run(session, ['eval', READ_PAGE])).then((printed) => unwrap<{ title: string; url: string; text: string }>(printed), () => null);
        // Where the page ended up counts as much as where it started: a redirect must not land on this machine.
        if (page?.url && !/^about:/.test(page.url)) webUrl(page.url);
        // Pages built in the browser are still empty at first load: give those a moment to finish, once.
        if (page && page.text.length < THIN && !walled(page.title, page.text)) {
          await run(session, ['wait', '--load', 'networkidle']).catch(() => {});
          page = unwrap<NonNullable<typeof page>>(await run(session, ['eval', READ_PAGE]));
        }
        // Refused, empty or timed out here: ask the reader service once before giving up.
        for (const reader of readers.fallback) {
          if (page && page.text.length >= THIN && !walled(page.title, page.text)) break;
          const second = await reader(address).catch(() => null);
          if (second && second.text.length >= THIN && !walled(second.title, second.text)) page = { ...second, url: address };
        }
        if (!page) throw new Error('the page did not load');
        if (walled(page.title, page.text)) return `## ${raw}\n${WALL_NOTE}`;
        if (page.text.length < 150) return `## ${raw}\nThis page came back almost empty (a silent bot wall or a login page). Do not guess what it says; try another source.`;
        const cut = page.text.length > PAGE_CHARS ? `${page.text.slice(0, PAGE_CHARS)}\n… (cut at ${PAGE_CHARS} of ${page.text.length} characters)` : page.text;
        return `## ${page.title || page.url}\n${page.url}\n\n${cut || '(no readable text)'}`;
      };
      const blocks = session ? await inOrder(session, urls, one) : await settled(urls.map((raw) => scratch((scratched) => one(scratched, raw))), (index) => urls[index]);
      return blocks.join('\n\n---\n\n');
    },
    // A product's own screens, as pictures, for a film to be cut from. One session, one viewport, the page opened
    // once and photographed at each scroll position asked for; a shot that did not land is simply left out.
    // `own` means the address is the founder's own product on this machine, which only a Video studio card may say.
    async shots(raw: string, want: { width: number; height: number; at: number[]; own?: boolean; file: (index: number) => string }, signal?: AbortSignal): Promise<string[]> {
      const address = want.own ? ownUrl(raw) : await publicUrl(raw, resolveHost);
      return scratch(async (session) => {
        const taken: string[] = [];
        await run(session, ['set', 'viewport', String(want.width), String(want.height)]);
        await run(session, ['open', address]);
        // A page built in the browser is still empty the moment it loads; give it a breath, and its fonts a chance.
        await run(session, ['wait', '2200']).catch(() => {});
        for (const [index, down] of want.at.entries()) {
          if (signal?.aborted) break;
          await run(session, ['eval', `window.scrollTo(0, ${Math.max(0, Math.round(down))})`]).catch(() => {});
          await run(session, ['wait', '700']).catch(() => {});
          const file = want.file(index);
          const done = await run(session, ['screenshot', file]).then(() => true, () => false);
          if (done && existsSync(file)) taken.push(file);
        }
        return taken;
      });
    },
    // One step in a browser card's lasting session, answered with the page as a compact tree of refs.
    async act(session: string, action: string, input: { url?: string; ref?: string; text?: string; key?: string; direction?: string }, launch?: Launch): Promise<string> {
      const go: Runner = (name, args) => run(name, args, launch);
      const need = (value: string | undefined, name: string) => { if (!value?.trim()) throw new Error(`"${name}" is missing for ${action}`); return value.trim(); };
      const ref = () => { const value = need(input.ref, 'ref'); return value.startsWith('@') ? value : `@${value}`; };
      const steps: Record<string, () => string[]> = {
        open: () => ['open', webUrl(need(input.url, 'url'))],
        look: () => [],
        click: () => ['click', ref()],
        fill: () => ['fill', ref(), need(input.text, 'text')],
        press: () => ['press', need(input.key, 'key')],
        scroll: () => ['scroll', input.direction === 'up' ? 'up' : 'down', '700'],
        back: () => ['back'],
      };
      if (!steps[action]) throw new Error(`unknown action "${action}". Use one of: ${Object.keys(steps).join(', ')}`);
      return slot(async () => {
        const args = steps[action]();
        if (action === 'open') await publicUrl(args[1], resolveHost);
        // An app card runs at a person's pace: a step every couple of seconds on the founder's own account, not a burst.
        const pace = launch?.pace;
        if (pace && args.length) await new Promise((settle) => setTimeout(settle, pace[0] + Math.random() * Math.max(0, pace[1] - pace[0])));
        if (args.length) await go(session, args);
        const address = (await go(session, ['get', 'url']).catch(() => '')).trim();
        if (address && !/^about:/.test(address)) webUrl(address);
        const tree = (await go(session, ['snapshot', '-i'])).trim();
        // The field is named from the page as it was when it was filled: the tree this step was taken on.
        if (action === 'fill') typed.set(session, { field: nameOfRef(seen.get(session)?.tree ?? tree, ref()) ?? '', text: input.text ?? '' });
        seen.set(session, { tree, address });
        const title = (await go(session, ['get', 'title']).catch(() => '')).trim();
        if (walled(title, tree.length < 1200 ? tree : '')) return `Now at ${address}\n${WALL_NOTE} ${CARD_WALL_NOTE}`;
        return `Now at ${address || 'a blank page'}\n${tree.length > SNAPSHOT_CHARS ? `${tree.slice(0, SNAPSHOT_CHARS)}\n… (cut; scroll or open a more specific page)` : tree || '(nothing to interact with)'}`;
      });
    },
    // The question for the founder when a step would send, publish, pay or delete; null when the step is plain browsing.
    // An app card is named by its app, which the founder knows better than a host name. An app card (`appName` given)
    // is the founder's own account, signed in: there Enter always asks, and so does any click that is not plainly
    // reading. Elsewhere, only webmail's Enter and clicks named like sending ask.
    async outward(session: string, action: string, input: { ref?: string; key?: string }, launch?: Launch, appName?: string): Promise<string | null> {
      let page = seen.get(session);
      const host = (() => { try { return new URL(page?.address ?? '').hostname; } catch { return ''; } })();
      const where = appName || host || 'this page';
      const own = !!appName;
      const last = typed.get(session);
      const shows = last?.text.trim() ? ` What was typed last${last.field ? ` into "${last.field}"` : ''}: "${last.text.trim().slice(0, 400)}".` : '';
      if (action === 'press') {
        if (!/enter/i.test(input.key ?? '')) return null;
        if (own) return `Press ${input.key} on ${where}? In a message or a post box this sends it as you.${shows}`;
        return MAIL_HOSTS.test(host) ? `Press ${input.key} on ${where}? In webmail this can send the message.${shows}` : null;
      }
      if (action !== 'click' || !input.ref) return null;
      if (!page) { const tree = await run(session, ['snapshot', '-i'], launch).catch(() => ''); page = { tree, address: '' }; }
      const element = elementOfRef(page.tree, input.ref);
      if (element === null) return `Click ${input.ref} on ${where}? I could not read what that element is.`;
      const name = element.name.trim();
      // An icon with no name could be anything; inside webmail or on the founder's own account that is reason enough to ask.
      if (!name) {
        if (own && READ_ROLES.has(element.role)) return null;
        return own || MAIL_HOSTS.test(host) ? `Click an unnamed ${element.role} (${input.ref}) on ${where}? Look at the browser card first.${shows}` : null;
      }
      if (OUTWARD.test(name) && !COOKIE.test(name)) return `Click "${name}" on ${where}? Look at the browser card first: it shows exactly what will go out.${shows}`;
      if (!own || COOKIE.test(name) || READ_ROLES.has(element.role) || READ_NAMES.test(name)) return null;
      return `Click "${name}" on ${where}? On your own account a click can act as you. Look at the browser card first.${shows}`;
    },
    // Where a browser card can watch its session live. Opens the session if nobody has used it yet.
    // An app card that has to be started opens on its own site, so Sign in shows the founder the page to sign in on.
    async watch(session: string, launch?: Launch, home?: string): Promise<{ port: number; url: string }> {
      const run: Runner = (name, args) => outer(name, args, launch);
      let status = await run(session, ['stream', 'status']).catch(() => '');
      if (!/ws:\/\//.test(status)) { await run(session, ['open', home ? webUrl(home) : 'about:blank']); status = await run(session, ['stream', 'status']).catch(() => ''); }
      if (!/ws:\/\//.test(status)) status = await run(session, ['stream', 'enable']);
      const port = Number(/ws:\/\/[^:]+:(\d+)/.exec(status)?.[1]);
      if (!port) throw new Error('the browser did not offer a live view');
      return { port, url: (await run(session, ['get', 'url']).catch(() => '')).trim() };
    },
    // Where an app card is, to tell whether the founder is signed in. A running session is read where it stands, so a
    // page a person is on does not move; only a session that is not running is sent to the app's home address.
    // Every call carries the card's launch, so its own profile and its logins are the ones asked.
    async landing(session: string, home: string, launch?: Launch): Promise<string> {
      const now = (await run(session, ['get', 'url'], launch).catch(() => '')).trim();
      if (now && !/^about:/.test(now)) return now;
      await run(session, ['open', webUrl(home)], launch);
      return (await run(session, ['get', 'url'], launch).catch(() => '')).trim();
    },
    // Where a card's browser is sitting right now, without opening anything: nothing when it is not running.
    where: (session: string) => run(session, ['get', 'url']).then((printed) => printed.trim() || null, () => null),
    // What the session last looked like goes with it: it is only there to say what changed since, and a session
    // opened again under the same name starts from a new page.
    close: (session: string) => { seen.delete(session); typed.delete(session); return run(session, ['close']).then(() => {}, () => {}); },
    // The caller closes the card's session first: a second Chrome on the same folder would only hand the address to it.
    byHand(profile: string, home: string): Promise<void> {
      const open = hands.get(profile);
      if (open) return open.done;
      const opened = hand(profile, home);
      const going = { done: opened.done.finally(() => hands.delete(profile)), end: opened.end };
      hands.set(profile, going);
      return going.done;
    },
    handOpen: (profile: string) => hands.has(profile),
    // The founder says they are done: their Chrome closes, and its exit clears the entry above.
    endHand(profile: string): boolean {
      const open = hands.get(profile);
      open?.end();
      return !!open;
    },
  };
}
