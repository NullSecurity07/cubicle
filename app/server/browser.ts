import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Runs one agent-browser command in a named session and returns what it printed.
export type Runner = (session: string, args: string[]) => Promise<string>;
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

// Bing wraps every result in a redirect that carries the real address as base64 in `u`.
export function unwrapBing(href: string): string {
  try {
    const url = new URL(href);
    const packed = url.hostname.endsWith('bing.com') && url.pathname.startsWith('/ck/') ? url.searchParams.get('u') : null;
    if (!packed?.startsWith('a1')) return href;
    const real = Buffer.from(packed.slice(2), 'base64url').toString('utf8');
    return /^https?:\/\//.test(real) ? real : href;
  } catch { return href; }
}

const READ_RESULTS = 'JSON.stringify([...document.querySelectorAll("li.b_algo")].slice(0,6).map(r=>({title:(r.querySelector("h2")?.textContent||"").trim(),url:r.querySelector("h2 a")?.href||"",snippet:(r.querySelector(".b_caption p, p")?.textContent||"").trim().slice(0,180)})))';
const READ_PAGE = `JSON.stringify((()=>{const pick=document.querySelector("article")||document.querySelector("main")||document.querySelector("[role=main]")||document.body;return{title:document.title,url:location.href,text:(pick.innerText||"").replace(/\\n{3,}/g,"\\n\\n").trim()}})())`;
// `eval` prints its value as JSON; a value that is itself JSON text arrives wrapped once more.
const unwrap = <T>(printed: string): T => { const once = JSON.parse(printed.trim()); return (typeof once === 'string' ? JSON.parse(once) : once) as T; };

export function realRunner(env: NodeJS.ProcessEnv = process.env): Runner {
  const bin = resolve(import.meta.dirname, '../node_modules/.bin/agent-browser');
  const chrome = env.AGENT_BROWSER_EXECUTABLE_PATH ?? CHROMES.find((path) => existsSync(path));
  return (session, args) => new Promise((done, fail) => {
    execFile(bin, ['--session', session, ...args], { timeout: 45_000, maxBuffer: 8_000_000, env: { ...env, ...(chrome ? { AGENT_BROWSER_EXECUTABLE_PATH: chrome } : {}) } },
      (error, stdout, stderr) => (error ? fail(new Error((stderr || stdout || error.message).trim().slice(0, 300))) : done(stdout)));
  });
}

// Stand-in for browser journeys: no Chrome, fixed answers.
export const fakeRunner: Runner = async (_session, args) => {
  if (args[0] === 'eval' && args[1] === READ_RESULTS) return JSON.stringify(JSON.stringify([{ title: 'Example result', url: 'https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8', snippet: 'An example.' }]));
  if (args[0] === 'eval') return JSON.stringify(JSON.stringify({ title: 'Example Domain', url: 'https://example.com/', text: 'This domain is for use in examples.' }));
  if (args[0] === 'snapshot') return '- heading "Example Domain" [ref=e1]\n- link "More information" [ref=e2]\n';
  if (args[0] === 'stream') return 'Streaming enabled on ws://127.0.0.1:1\n';
  if (args[0] === 'get') return 'https://example.com/\n';
  return '✓ done\n';
};

export function createBrowser(run: Runner) {
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
        await run(session, ['open', `https://www.bing.com/search?q=${encodeURIComponent(query)}`]);
        const hits = unwrap<SearchHit[]>(await run(session, ['eval', READ_RESULTS])).filter((hit) => hit.url);
        const lines = hits.map((hit, index) => `${index + 1}. ${hit.title || '(untitled)'}\n   ${unwrapBing(hit.url)}\n   ${hit.snippet}`);
        return `## ${query}\n${lines.join('\n') || 'No results.'}`;
      })), (index) => queries[index]);
      return blocks.join('\n\n');
    },
    // All pages at once: the readable text of each, cut to a size a model can afford.
    async read(urls: string[]): Promise<string> {
      const blocks = await settled(urls.map((raw) => scratch(async (session) => {
        await run(session, ['open', webUrl(raw)]);
        const page = unwrap<{ title: string; url: string; text: string }>(await run(session, ['eval', READ_PAGE]));
        const cut = page.text.length > PAGE_CHARS ? `${page.text.slice(0, PAGE_CHARS)}\n… (cut at ${PAGE_CHARS} of ${page.text.length} characters)` : page.text;
        return `## ${page.title || page.url}\n${page.url}\n\n${cut || '(no readable text)'}`;
      })), (index) => urls[index]);
      return blocks.join('\n\n---\n\n');
    },
    // One step in a browser card's lasting session, answered with the page as a compact tree of refs.
    async act(session: string, action: string, input: { url?: string; ref?: string; text?: string; key?: string; direction?: string }): Promise<string> {
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
        if (args.length) await run(session, args);
        const address = (await run(session, ['get', 'url']).catch(() => '')).trim();
        if (address && !/^about:/.test(address)) webUrl(address);
        const tree = (await run(session, ['snapshot', '-i'])).trim();
        return `Now at ${address || 'a blank page'}\n${tree.length > SNAPSHOT_CHARS ? `${tree.slice(0, SNAPSHOT_CHARS)}\n… (cut; scroll or open a more specific page)` : tree || '(nothing to interact with)'}`;
      });
    },
    // Where a browser card can watch its session live. Opens the session if nobody has used it yet.
    async watch(session: string): Promise<{ port: number; url: string }> {
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
