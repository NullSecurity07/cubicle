import { describe, expect, it } from 'vitest';
import { ENGINES, WALL_NOTE, createBrowser, fakeRunner, honestUserAgent, unwrapRedirect, webUrl, type Runner } from './browser.ts';

describe('webUrl', () => {
  it('accepts web pages and adds https to a bare domain', () => {
    expect(webUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(webUrl('example.com')).toBe('https://example.com/');
  });

  it('refuses this machine, the local network and non-web schemes', () => {
    for (const bad of ['http://localhost:7421/api/stage', 'http://127.0.0.1/', 'http://192.168.1.1/', 'http://10.0.0.5/', 'http://172.20.1.1/', 'http://[::1]/', 'http://printer.local/', 'file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)']) {
      expect(() => webUrl(bad), bad).toThrow();
    }
  });
});

describe('unwrapRedirect', () => {
  it('reads the real address out of Bing and DuckDuckGo redirects and leaves other links alone', () => {
    expect(unwrapRedirect('https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8&ntb=1')).toBe('https://example.com/');
    expect(unwrapRedirect('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fkanboard.org%2F&rut=04')).toBe('https://kanboard.org/');
    expect(unwrapRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Fkanboard.org%2F')).toBe('https://kanboard.org/');
    expect(unwrapRedirect('https://example.org/x')).toBe('https://example.org/x');
  });
});

describe('honestUserAgent', () => {
  it('names the real Chrome and its version instead of HeadlessChrome', () => {
    expect(honestUserAgent('Google Chrome 152.0.7977.82 \n', 'linux')).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36');
    expect(honestUserAgent('Chromium 140.0.1.2', 'darwin')).toContain('Macintosh');
    expect(honestUserAgent('no version here')).toBeUndefined();
  });
});

describe('browser', () => {
  it('runs every query at once, never more than four sessions, and closes each', async () => {
    let open = 0; let peak = 0; const closed: string[] = [];
    const run: Runner = async (session, args) => {
      if (args[0] === 'open') { open += 1; peak = Math.max(peak, open); await new Promise((r) => setTimeout(r, 20)); }
      if (args[0] === 'close') { open -= 1; closed.push(session); }
      return fakeRunner(session, args);
    };
    const text = await createBrowser(run).search(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(peak).toBe(4);
    expect(closed).toHaveLength(6);
    expect(text.match(/^## /gm)).toHaveLength(6);
    expect(text).toContain('https://example.com/');
  });

  it('moves to the next search engine when one comes back empty, and says so when all do', async () => {
    const opened: string[] = [];
    const run: Runner = async (session, args) => {
      if (args[0] === 'open') opened.push(new URL(args[1]).hostname);
      if (args[0] === 'eval' && args[1] === ENGINES[0].read) return JSON.stringify('[]');
      return fakeRunner(session, args);
    };
    expect(await createBrowser(run).search(['calm'])).toContain('https://example.com/');
    expect(opened).toEqual(['html.duckduckgo.com', 'www.bing.com']);
    const none: Runner = async (session, args) => (args[0] === 'eval' ? JSON.stringify('[]') : fakeRunner(session, args));
    expect(await createBrowser(none).search(['calm'])).toContain('every search engine refused');
  });

  it('says plainly when a site answers with a human check, instead of passing the check page off as content', async () => {
    const wall: Runner = async (session, args) => (args[0] === 'eval' ? JSON.stringify(JSON.stringify({ title: 'Reddit - Prove your humanity', url: 'https://www.reddit.com/', text: 'Please wait for verification.' })) : fakeRunner(session, args));
    const text = await createBrowser(wall).read(['https://www.reddit.com/r/startups/']);
    expect(text).toContain(WALL_NOTE);
    expect(text).not.toContain('Please wait');
  });

  it('asks the reader service when the local browser is refused, and still admits a wall nobody got past', async () => {
    const wall: Runner = async (session, args) => (args[0] === 'eval' ? JSON.stringify(JSON.stringify({ title: 'Just a moment...', url: 'https://techcrunch.com/', text: '' })) : fakeRunner(session, args));
    const asked: string[] = [];
    const helped = await createBrowser(wall, async (url) => { asked.push(url); return { title: 'TechCrunch', text: 'Startup news. '.repeat(60) }; }).read(['https://techcrunch.com/']);
    expect(asked).toEqual(['https://techcrunch.com/']);
    expect(helped).toContain('## TechCrunch');
    const stuck = await createBrowser(wall, async () => ({ title: 'Just a moment...', text: 'Verify you are human' })).read(['https://www.crunchbase.com/']);
    expect(stuck).toContain(WALL_NOTE);
  });

  it('gives a page built in the browser one more moment before reading it', async () => {
    let reads = 0; const waited: string[][] = [];
    const slow: Runner = async (session, args) => {
      if (args[0] === 'wait') waited.push(args);
      if (args[0] === 'eval') { reads += 1; return JSON.stringify(JSON.stringify({ title: 'App', url: 'https://app.example/', text: reads === 1 ? 'Loading' : 'x'.repeat(900) })); }
      return fakeRunner(session, args);
    };
    expect(await createBrowser(slow).read(['https://app.example/'])).toContain('x'.repeat(900));
    expect(waited).toEqual([['wait', '--load', 'networkidle']]);
  });

  it('reports a page that fails without losing the others', async () => {
    const text = await createBrowser(fakeRunner).read(['https://example.com', 'http://localhost/secret']);
    expect(text).toContain('This domain is for use in examples.');
    expect(text).toContain('Failed: addresses on this machine');
  });

  it('starts a card with its own lasting profile, and with a window only when the founder asked for one', async () => {
    const launches: unknown[] = [];
    const run: Runner = async (session, args, launch) => { launches.push(launch); return fakeRunner(session, args); };
    const browser = createBrowser(run);
    await browser.act('card-b1', 'look', {}, { profile: '/w/browsers/b1', headed: true });
    await browser.watch('card-b1', { profile: '/w/browsers/b1' });
    expect(launches.every((launch, index) => (launch as { profile: string }).profile === '/w/browsers/b1' || index < 0)).toBe(true);
    expect(launches.some((launch) => (launch as { headed?: boolean }).headed)).toBe(true);
    await browser.search(['x']);
    expect(launches.at(-1)).toBeUndefined();
  });

  it('turns a step into a command and answers with the page tree', async () => {
    const seen: string[][] = [];
    const run: Runner = async (session, args) => { seen.push(args); return fakeRunner(session, args); };
    const page = await createBrowser(run).act('card-b1', 'click', { ref: 'e2' });
    expect(seen[0]).toEqual(['click', '@e2']);
    expect(page).toContain('[ref=e1]');
    await expect(createBrowser(run).act('card-b1', 'open', { url: 'http://127.0.0.1:7421' })).rejects.toThrow(/this machine/);
    await expect(createBrowser(run).act('card-b1', 'dance', {})).rejects.toThrow(/unknown action/);
  });
});
