import { describe, expect, it } from 'vitest';
import { createBrowser, fakeRunner, unwrapBing, webUrl, type Runner } from './browser.ts';

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

describe('unwrapBing', () => {
  it('reads the real address out of a Bing redirect and leaves other links alone', () => {
    expect(unwrapBing('https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8&ntb=1')).toBe('https://example.com/');
    expect(unwrapBing('https://example.org/x')).toBe('https://example.org/x');
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

  it('reports a page that fails without losing the others', async () => {
    const text = await createBrowser(fakeRunner).read(['https://example.com', 'http://localhost/secret']);
    expect(text).toContain('This domain is for use in examples.');
    expect(text).toContain('Failed: addresses on this machine');
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
