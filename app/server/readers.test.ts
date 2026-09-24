import { afterEach, describe, expect, it } from 'vitest';
import { archiveCopy, atomEntries, getPublic, htmlToText, reddit, redditFeed, resetReddit, stackExchange } from './readers.ts';

const http = (routes: Record<string, { body: string; url?: string }>) => {
  const asked: string[] = [];
  const fake = (async (url: string) => {
    asked.push(String(url));
    const hit = Object.entries(routes).find(([start]) => String(url).startsWith(start))?.[1];
    if (!hit) return new Response('no', { status: 404 });
    const response = new Response(hit.body, { status: 200 });
    Object.defineProperty(response, 'url', { value: hit.url ?? String(url) });
    return response;
  }) as typeof fetch;
  return { fake, asked };
};

describe('htmlToText', () => {
  it('keeps the words and the list shape, drops scripts and tags, and reads entities', () => {
    expect(htmlToText('<style>p{}</style><h1>Pricing &amp; plans</h1><p>Pro is &#36;19.</p><ul><li>One</li><li>Two</li></ul><script>alert(1)</script>')).toBe('Pricing & plans\nPro is $19.\n- One\n- Two');
  });
});

describe('redditFeed', () => {
  const feed = '<feed><title>startups</title><entry><author><name>/u/ana</name></author><content type="html">&lt;div&gt;&lt;p&gt;We hit 100 users.&lt;/p&gt;&lt;/div&gt; submitted by /u/ana</content><link href="https://www.reddit.com/r/startups/comments/1/x/"/><updated>2026-09-18T10:00:00+00:00</updated><title>First 100 users</title></entry></feed>';
  it('reads a listing through its feed, keeping the query, and leaves other sites alone', async () => {
    const { fake, asked } = http({ 'https://www.reddit.com/r/startups/top/.rss': { body: feed } });
    const page = await redditFeed(fake)('https://old.reddit.com/r/startups/top/?t=week');
    expect(asked).toEqual(['https://www.reddit.com/r/startups/top/.rss?t=week']);
    expect(page).toEqual({ title: 'startups', text: '### First 100 users\n/u/ana · 2026-09-18 · https://www.reddit.com/r/startups/comments/1/x/\nWe hit 100 users.' });
    expect(await redditFeed(fake)('https://example.com/r/startups')).toBeNull();
  });
});

describe('stackExchange', () => {
  it('reads a question with its best answers through the official API', async () => {
    const { fake, asked } = http({
      'https://api.stackexchange.com/2.3/questions/42/answers': { body: JSON.stringify({ items: [{ body: '<p>Use <code>useMemo</code>.</p>', score: 12, is_accepted: true }] }) },
      'https://api.stackexchange.com/2.3/questions/42?': { body: JSON.stringify({ items: [{ title: 'Why does it re-render?', body: '<p>My component re-renders.</p>', score: 7, tags: ['reactjs'] }] }) },
    });
    const page = await stackExchange(fake)('https://stackoverflow.com/questions/42/why-does-it-re-render');
    expect(page!.title).toBe('Why does it re-render?');
    expect(page!.text).toContain('Question (score 7, tags reactjs):\nMy component re-renders.');
    expect(page!.text).toContain('Answer (score 12, accepted):\nUse useMemo .');
    expect(asked.every((url) => url.endsWith('site=stackoverflow'))).toBe(true);
  });

  it('lists a tag, picks the right site for a stackexchange subdomain, and ignores other hosts', async () => {
    const { fake, asked } = http({ 'https://api.stackexchange.com/2.3/questions?tagged=': { body: JSON.stringify({ items: [{ title: 'Pricing a SaaS', score: 9, answer_count: 3, link: 'https://startups.stackexchange.com/q/1' }] }) } });
    const page = await stackExchange(fake)('https://startups.stackexchange.com/questions/tagged/pricing');
    expect(page!.text).toBe('- Pricing a SaaS (score 9, 3 answers)\n  https://startups.stackexchange.com/q/1');
    expect(asked[0]).toContain('site=startups');
    expect(await stackExchange(fake)('https://example.com/questions/42')).toBeNull();
  });
});

describe('archiveCopy', () => {
  it('returns the archived text and says how old it is', async () => {
    const { fake } = http({ 'https://web.archive.org/web/2id_/': { body: '<title>Best PM software</title><p>Asana leads.</p>', url: 'https://web.archive.org/web/20260917221530id_/https://www.g2.com/x' } });
    const page = await archiveCopy(fake)('https://www.g2.com/x');
    expect(page!.title).toBe('Best PM software');
    expect(page!.text).toMatch(/^\[Archived copy from 2026-09-17, kept by the Internet Archive/);
    expect(page!.text).toContain('Asana leads.');
  });
});

describe('getPublic', () => {
  const resolveHost = async (host: string) => (host === 'inside.test' ? ['127.0.0.1'] : ['93.184.216.34']);
  const routes = (table: Record<string, () => Response>) => {
    const asked: string[] = [];
    const fake = (async (url: string) => { asked.push(String(url)); return table[String(url)]?.() ?? new Response('no', { status: 404 }); }) as typeof fetch;
    return { fake, asked };
  };
  const moved = (to: string) => new Response(null, { status: 302, headers: { location: to } });

  it('follows a redirect, unwraps a link-tracker when asked, and refuses one that points at this machine', async () => {
    const { fake, asked } = routes({
      'https://a.test/': () => moved('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fb.test%2Fpage'),
      'https://b.test/page': () => new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } }),
      'https://c.test/': () => moved('http://inside.test/admin'),
    });
    const got = await getPublic('https://a.test/', { http: fake, resolveHost, agent: 't', unwrap: true });
    expect(got).toMatchObject({ status: 200, url: 'https://b.test/page', body: '<p>hi</p>' });
    expect(asked).toEqual(['https://a.test/', 'https://b.test/page']);
    await expect(getPublic('https://c.test/', { http: fake, resolveHost, agent: 't' })).rejects.toThrow();
    expect(asked).not.toContain('http://inside.test/admin');
  });

  it('lets anything but a page go unread when html-only, and keeps other hosts out with `only`', async () => {
    const { fake } = routes({
      'https://a.test/file.pdf': () => new Response('%PDF-1.7 lots of bytes', { headers: { 'content-type': 'application/pdf' } }),
      'https://www.reddit.com/r/x': () => moved('https://evil.test/'),
    });
    expect(await getPublic('https://a.test/file.pdf', { http: fake, resolveHost, agent: 't', htmlOnly: true })).toMatchObject({ status: 200, type: 'application/pdf', body: '' });
    expect((await getPublic('https://a.test/file.pdf', { http: fake, resolveHost, agent: 't' })).body).toContain('%PDF');
    await expect(getPublic('https://www.reddit.com/r/x', { http: fake, resolveHost, agent: 't', only: /(^|\.)reddit\.com$/ })).rejects.toThrow(/evil\.test/);
  });
});

describe('one Reddit for the whole app', () => {
  afterEach(resetReddit);
  it('rests a minute after Reddit says 429, and the feed reader shares that rest', async () => {
    let calls = 0;
    const fake = (async () => { calls += 1; return new Response('slow down', { status: 429 }); }) as typeof fetch;
    const read = redditFeed(fake, async () => {});
    expect(await read('https://www.reddit.com/r/startups')).toBeNull();
    expect(reddit.refusedUntil).toBeGreaterThan(Date.now());
    expect(await read('https://www.reddit.com/r/startups')).toBeNull();
    expect(calls).toBe(1);
  });
  it('reads Atom entries one way', () => {
    const [entry] = atomEntries('<feed><entry><title>A &amp; B</title><author><name>/u/ana</name></author><link href="https://x.test/1"/><updated>2026-09-18T10:00:00Z</updated><content type="html">&lt;p&gt;hi&lt;/p&gt;</content></entry></feed>');
    expect(entry).toMatchObject({ title: 'A & B', author: '/u/ana', link: 'https://x.test/1', updated: '2026-09-18T10:00:00Z', content: '<p>hi</p>' });
    expect(entry.at).toBe(Date.parse('2026-09-18T10:00:00Z'));
  });
});
