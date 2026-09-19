import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Reader } from './readers.ts';

// How a browser card's Chrome starts: `profile` is a folder that keeps its logins between runs, `headed` opens a real
// window on the founder's desktop. Both take effect when the session starts, so changing them means closing it first.
export type Launch = { profile?: string; headed?: boolean };
// Runs one agent-browser command in a named session and returns what it printed.
export type Runner = (session: string, args: string[], launch?: Launch) => Promise<string>;
export type SearchHit = { title: string; url: string; snippet: string };
export type Browser = ReturnType<typeof createBrowser>;

const MAX_AT_ONCE = 4;
const PAGE_CHARS = 8000;
const SNAPSHOT_CHARS = 7000;
const CHROMES = ['/usr/bin/google-chrome-stable', '/usr/sbin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];

// People may read the open web, never the founder's own machine or network: a page that says
// "now open http://localhost…" must get nowhere.
export function webUrl(raw: string): string {
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`); } catch { throw new Error(`not a web address: ${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`only http and https pages can be opened, not ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
    || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
  if (local) throw new Error('addresses on this machine or the local network cannot be opened');
  return url.href;
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

const hits = (rows: string, title: string, snippet: string) => `JSON.stringify([...document.querySelectorAll("${rows}")].slice(0,6).map(r=>({title:(r.querySelector("${title}")?.textContent||"").trim(),url:r.querySelector("${title}")?.href||r.querySelector("${title} a")?.href||"",snippet:(r.querySelector("${snippet}")?.textContent||"").trim().slice(0,180)})))`;
// Tried in order for each query; an engine that answers with nothing (a challenge page, a changed layout) hands over to the next.
export const ENGINES = [
  { name: 'duckduckgo', url: (query: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, read: hits('.result:not(.result--ad)', '.result__a', '.result__snippet') },
  { name: 'bing', url: (query: string) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`, read: hits('li.b_algo', 'h2 a', '.b_caption p, p') },
];
// A site that answers with a human check instead of its page. The person must hear that plainly, or it will guess the content.
const WALL = /prove your humanity|verify (that )?you('| a)re (a )?human|are you a robot|unusual traffic|complete the (following )?challenge|checking your browser|just a moment|access denied|attention required|enable javascript and cookies|captcha/i;
export const walled = (title: string, text: string) => WALL.test(title) || (text.length < 1200 && WALL.test(text));
export const WALL_NOTE = 'This site asked for a human check and did not show its page. Do not guess what it says, and do not try to pass the check. Tell the founder it is behind a bot wall; another source may have the same facts.';
export const CARD_WALL_NOTE = 'On a browser card the founder can press "Show window", pass the check or sign in by hand, and you carry on from there.';
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

// Stand-in for browser journeys: no Chrome, fixed answers.
export const fakeRunner: Runner = async (_session, args) => {
  if (args[0] === 'eval' && ENGINES.some((engine) => engine.read === args[1])) return JSON.stringify(JSON.stringify([{ title: 'Example result', url: 'https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8', snippet: 'An example.' }]));
  if (args[0] === 'eval') return JSON.stringify(JSON.stringify({ title: 'Example Domain', url: 'https://example.com/', text: `This domain is for use in examples. ${'It is reserved for documentation and may be used without asking. '.repeat(3)}`.trim() }));
  if (args[0] === 'snapshot') return '- heading "Example Domain" [ref=e1]\n- link "More information" [ref=e2]\n';
  if (args[0] === 'stream') return 'Streaming enabled on ws://127.0.0.1:1\n';
  if (args[0] === 'get') return 'https://example.com/\n';
  return '✓ done\n';
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
const OUTWARD = /^(send|reply|forward|post|publish|tweet|submit|share|comment|pay|buy|purchase|order|checkout|place order|subscribe|confirm|delete|remove|unsubscribe|sign up|create account|register)\b/i;
const MAIL_HOSTS = /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.proton\.me|mail\.yahoo\.com|app\.fastmail\.com|mail\.zoho\.com|app\.tuta\.com)$/;
// The accessible name of a ref in a snapshot line such as `- button "Send" [ref=e44]`: '' for an element without one, null for a ref that is not on the page.
export const nameOfRef = (tree: string, ref: string) => { const found = new RegExp(`^\\s*- \\w+(?: "((?:[^"\\\\]|\\\\.)*)")?[^\\n]*\\[ref=${ref.replace(/^@/, '')}\\]`, 'm').exec(tree); return found ? found[1] ?? '' : null; };

// `direct` readers know a site's feed or API and go first; `fallback` readers are asked, in order, when the local browser got nothing.
export type Readers = { direct: Reader[]; fallback: Reader[] };

export function createBrowser(run: Runner, readers: Readers = { direct: [], fallback: [] }) {
  const outer = run;
  const seen = new Map<string, { tree: string; address: string }>();
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

  return {
    // All queries at once, each in its own throwaway session.
    async search(queries: string[]): Promise<string> {
      const blocks = await settled(queries.map((query) => scratch(async (session) => {
        for (const engine of ENGINES) {
          const found = await run(session, ['open', engine.url(query)]).then(() => run(session, ['eval', engine.read])).then((printed) => unwrap<SearchHit[]>(printed).filter((hit) => hit.url), () => []);
          if (!found.length) continue;
          const lines = found.map((hit, index) => `${index + 1}. ${hit.title || '(untitled)'}\n   ${unwrapRedirect(hit.url)}\n   ${hit.snippet}`);
          return `## ${query}\n${lines.join('\n')}`;
        }
        return `## ${query}\nNo results: every search engine refused or came back empty.`;
      })), (index) => queries[index]);
      return blocks.join('\n\n');
    },
    // One page as title and text, for a link card. Same path as `read`: local browser, then the reader service; a wall is said plainly.
    async page(raw: string): Promise<{ title: string; text: string }> {
      const block = await this.read([raw]);
      const [head, , ...rest] = block.split('\n');
      return { title: head.replace(/^## /, '').slice(0, 160), text: rest.join('\n').trim().slice(0, 5000) || block.slice(0, 600) };
    },
    // All pages at once: the readable text of each, cut to a size a model can afford.
    async read(urls: string[]): Promise<string> {
      const blocks = await settled(urls.map((raw) => scratch(async (session) => {
        const address = webUrl(raw);
        // A site with a feed or an official API is read through it: faster, and it works where the site walls browsers.
        for (const reader of readers.direct) {
          const known = await reader(address).catch(() => null);
          if (known && known.text.length >= THIN) return `## ${known.title || address}\n${address}\n\n${known.text.length > PAGE_CHARS ? `${known.text.slice(0, PAGE_CHARS)}\n… (cut at ${PAGE_CHARS} of ${known.text.length} characters)` : known.text}`;
        }
        let page = await run(session, ['open', address]).then(() => run(session, ['eval', READ_PAGE])).then((printed) => unwrap<{ title: string; url: string; text: string }>(printed), () => null);
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
      })), (index) => urls[index]);
      return blocks.join('\n\n---\n\n');
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
        if (args.length) await go(session, args);
        const address = (await go(session, ['get', 'url']).catch(() => '')).trim();
        if (address && !/^about:/.test(address)) webUrl(address);
        const tree = (await go(session, ['snapshot', '-i'])).trim();
        seen.set(session, { tree, address });
        const title = (await go(session, ['get', 'title']).catch(() => '')).trim();
        if (walled(title, tree.length < 1200 ? tree : '')) return `Now at ${address}\n${WALL_NOTE} ${CARD_WALL_NOTE}`;
        return `Now at ${address || 'a blank page'}\n${tree.length > SNAPSHOT_CHARS ? `${tree.slice(0, SNAPSHOT_CHARS)}\n… (cut; scroll or open a more specific page)` : tree || '(nothing to interact with)'}`;
      });
    },
    // The question for the founder when a step would send, publish, pay or delete; null when the step is plain browsing.
    async outward(session: string, action: string, input: { ref?: string; key?: string }, launch?: Launch): Promise<string | null> {
      let page = seen.get(session);
      const host = (() => { try { return new URL(page?.address ?? '').hostname; } catch { return ''; } })();
      if (action === 'press') return /enter/i.test(input.key ?? '') && MAIL_HOSTS.test(host) ? `Press ${input.key} on ${host}? In webmail this can send the message.` : null;
      if (action !== 'click' || !input.ref) return null;
      if (!page) { const tree = await run(session, ['snapshot', '-i'], launch).catch(() => ''); page = { tree, address: '' }; }
      const name = nameOfRef(page.tree, input.ref);
      if (name === null) return `Click ${input.ref} on ${host || 'this page'}? I could not read what that element is.`;
      // An icon with no name could be anything; inside webmail that is reason enough to ask.
      if (!name.trim()) return MAIL_HOSTS.test(host) ? `Click an unnamed button (${input.ref}) on ${host}? Look at the browser card first.` : null;
      return OUTWARD.test(name.trim()) ? `Click "${name}" on ${host || 'this page'}? Look at the browser card first: it shows exactly what will go out.` : null;
    },
    // Where a browser card can watch its session live. Opens the session if nobody has used it yet.
    async watch(session: string, launch?: Launch): Promise<{ port: number; url: string }> {
      const run: Runner = (name, args) => outer(name, args, launch);
      let status = await run(session, ['stream', 'status']).catch(() => '');
      if (!/ws:\/\//.test(status)) { await run(session, ['open', 'about:blank']); status = await run(session, ['stream', 'status']).catch(() => ''); }
      if (!/ws:\/\//.test(status)) status = await run(session, ['stream', 'enable']);
      const port = Number(/ws:\/\/[^:]+:(\d+)/.exec(status)?.[1]);
      if (!port) throw new Error('the browser did not offer a live view');
      return { port, url: (await run(session, ['get', 'url']).catch(() => '')).trim() };
    },
    close: (session: string) => run(session, ['close']).then(() => {}, () => {}),
  };
}
