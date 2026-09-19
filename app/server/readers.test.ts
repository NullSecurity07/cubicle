import { describe, expect, it } from 'vitest';
import { archiveCopy, htmlToText, redditFeed, stackExchange } from './readers.ts';

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
