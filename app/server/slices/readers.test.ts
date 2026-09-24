import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedStage } from '../../shared/model.ts';
import type { Store } from '../store.ts';
import type { ToolContext } from '../tools/registry.ts';
import { UNTRUSTED } from '../tools/web.ts';
import {
  createPace, execProgram, feedLinks, flatten, fromJson3, fromVtt, parseFeed, pickTrack, readerTools, redditAsk, REDDIT_REFUSED, resetReddit,
  TRANSCRIPT_CHARS, youtubeUrl, type Exec, type ReaderOptions,
} from './readers.ts';

const FIXTURES = join(import.meta.dirname, 'readers.fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
// Thursday 24 September 2026, noon UTC.
const NOW = Date.UTC(2026, 8, 24, 12);
const context = (signal?: AbortSignal): ToolContext => ({ stage: seedStage, roomId: 'marketing', store: {} as Store, granted: new Map(), signal });
const tools = (options: Partial<ReaderOptions> & { workspace?: string }) => {
  const all = readerTools({ workspace: tmpdir(), now: () => NOW, pace: async () => {}, resolveHost: async () => ['93.184.216.34'], ...options });
  return (name: string) => all.find((one) => one.name === name)!;
};

// A fetch that answers from a table and writes down every request, headers and all.
type Asked = { url: string; headers: Record<string, string> };
const web = (table: Record<string, () => Response>) => {
  const asked: Asked[] = [];
  const http = (async (url: string, init?: RequestInit) => {
    asked.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    const answer = table[String(url)];
    return answer ? answer() : new Response('not here', { status: 404 });
  }) as typeof fetch;
  return { http, asked };
};
const ok = (body: string, type = 'text/plain') => () => new Response(body, { status: 200, headers: { 'content-type': type } });

describe('read_youtube', () => {
  // yt-dlp as the tests have it: the first run prints what the video is, the second writes one caption file where
  // "-o" says, or whatever the test hands it.
  const ytdlp = (captions: { name: string; body: string } | null, info = fixture('video.info.json')) => {
    const runs: { args: string[]; cwd: string }[] = [];
    const exec: Exec = async (_command, args, { cwd }) => {
      runs.push({ args, cwd });
      if (args.includes('--dump-json')) return { code: 0, stdout: info, stderr: '', timedOut: false, aborted: false };
      const out = args[args.indexOf('-o') + 1];
      if (captions) await writeFile(join(dirname(out), captions.name), captions.body);
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
    };
    return { exec, runs };
  };

  it('knows one video from a channel, a playlist and anything that is not YouTube', () => {
    expect(youtubeUrl('https://www.youtube.com/watch?v=jNQXAC9IVRw')).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    expect(youtubeUrl('youtu.be/jNQXAC9IVRw')).toBe('https://youtu.be/jNQXAC9IVRw');
    expect(youtubeUrl('https://youtube.com/shorts/abcdefghijk')).toContain('/shorts/');
    expect(youtubeUrl('jNQXAC9IVRw')).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    expect(() => youtubeUrl('https://www.youtube.com/@somechannel')).toThrow('one video');
    expect(() => youtubeUrl('https://www.youtube.com/playlist?list=PL123')).toThrow('one video');
    expect(() => youtubeUrl('https://vimeo.com/123')).toThrow('Only YouTube');
    expect(() => youtubeUrl('http://localhost:8080/watch?v=x')).toThrow('this machine');
  });

  it('takes the uploader\'s captions over automatic ones, and the words really said over a translation', () => {
    expect(pickTrack({ subtitles: { de: [], en: [] }, automatic_captions: { en: [] } })).toEqual({ lang: 'en', auto: false });
    expect(pickTrack({ subtitles: { 'en-GB': [] } })).toEqual({ lang: 'en-GB', auto: false });
    expect(pickTrack({ subtitles: { fr: [] }, automatic_captions: { en: [], 'en-orig': [] } })).toEqual({ lang: 'en-orig', auto: true });
    expect(pickTrack({ automatic_captions: { en: [] } })).toEqual({ lang: 'en', auto: true });
    expect(pickTrack({ subtitles: { fr: [] }, automatic_captions: { de: [] } })).toBeNull();
  });

  it('reads YouTube\'s own caption file and rolling WebVTT into lines said once each', () => {
    const zoo = fromJson3(fixture('captions.json3'));
    expect(zoo[0]).toEqual({ at: 1.2, text: 'All right, so here we are, in front of the elephants' });
    const rolled = fromVtt(fixture('captions.vtt'));
    expect(rolled.map((one) => one.text)).toEqual(['so today we talk pricing', 'most founders charge too little', 'and that\'s & the whole problem', 'an hour in, still talking']);
    expect(rolled.map((one) => one.at)).toEqual([0.32, 3.12, 65, 3723.5]);
  });

  it('writes the words as paragraphs of about a minute, each with where it starts, and cuts at a whole one', () => {
    const lines = fromVtt(fixture('captions.vtt'));
    expect(flatten(lines)).toEqual({ text: '[0:00] so today we talk pricing most founders charge too little\n[1:05] and that\'s & the whole problem\n[1:02:03] an hour in, still talking', cutAt: null });
    expect(flatten(lines, 90)).toEqual({ text: '[0:00] so today we talk pricing most founders charge too little', cutAt: 65 });
  });

  it('gives what the video is and its transcript, reads the facts back instead of asking YouTube twice, and leaves nothing behind', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'readers-'));
    const { exec, runs } = ytdlp({ name: 'v.en.json3', body: fixture('captions.json3') });
    const { text } = await tools({ workspace, exec })('read_youtube').run({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }, context());
    expect(text.startsWith(UNTRUSTED)).toBe(true);
    expect(text).toContain('Video: Me at the zoo');
    expect(text).toContain('Channel: jawed');
    expect(text).toContain('Uploaded: 2005-04-24 (21 years ago)');
    expect(text).toContain('Length: 0:19');
    expect(text).toContain('Views: 436,158,113');
    expect(text).toContain('Captions: written for the video (en)');
    expect(text).toContain('[0:01] All right, so here we are, in front of the elephants');
    expect(runs[0].args).toContain('--dump-json');
    expect(runs[0].args).toContain('--skip-download');
    expect(runs[1].args).toEqual(expect.arrayContaining(['--load-info-json', 'info.json', '--write-subs', '--sub-langs', 'en', '--sub-format', 'json3/vtt', '--skip-download']));
    expect(runs[1].args).not.toContain('--write-auto-subs');
    // The scratch folder lives under the workspace and is gone once the video is read.
    expect(runs[0].cwd.startsWith(join(workspace, '.readers'))).toBe(true);
    expect(existsSync(runs[0].cwd)).toBe(false);
  });

  it('falls back to WebVTT, and says automatic captions may mishear', async () => {
    const info = JSON.stringify({ ...JSON.parse(fixture('video.info.json')), subtitles: {}, automatic_captions: { 'en-orig': [] } });
    const { exec, runs } = ytdlp({ name: 'v.en-orig.vtt', body: fixture('captions.vtt') }, info);
    const { text } = await tools({ exec })('read_youtube').run({ url: 'jNQXAC9IVRw' }, context());
    expect(runs[1].args).toContain('--write-auto-subs');
    expect(text).toContain('made automatically by YouTube (en-orig), so names and numbers may be misheard');
    expect(text).toContain('[1:05] and that\'s & the whole problem');
  });

  it('says so in one sentence when there are no English captions, and still says what the video is', async () => {
    const info = JSON.stringify({ ...JSON.parse(fixture('video.info.json')), subtitles: { fr: [] }, automatic_captions: {} });
    const { exec, runs } = ytdlp(null, info);
    const { text } = await tools({ exec })('read_youtube').run({ url: 'jNQXAC9IVRw' }, context());
    expect(runs).toHaveLength(1);
    expect(text).toContain('Video: Me at the zoo');
    expect(text.trimEnd().endsWith('This video has no English captions, so there is no transcript to read.')).toBe(true);
  });

  it('stops at twenty thousand characters and says where it stopped', async () => {
    const events = Array.from({ length: 4000 }, (_, index) => ({ tStartMs: index * 2000, segs: [{ utf8: `sentence number ${index} about pricing` }] }));
    const { exec } = ytdlp({ name: 'v.en.json3', body: JSON.stringify({ events }) });
    const { text } = await tools({ exec })('read_youtube').run({ url: 'jNQXAC9IVRw' }, context());
    const transcript = text.split('Transcript:\n')[1].split('\n\n(Cut here')[0];
    expect(transcript.length).toBeLessThanOrEqual(TRANSCRIPT_CHARS);
    expect(text).toMatch(/\(Cut here at \d+:\d\d of 0:19: only the first 20,000 characters are shown\.\)$/);
  });

  it('turns every failure into a sentence the person can read', async () => {
    const failing = (ran: Partial<Awaited<ReturnType<Exec>>>): Exec => async () => ({ code: 1, stdout: '', stderr: '', timedOut: false, aborted: false, ...ran });
    const read = (exec: Exec) => tools({ exec })('read_youtube').run({ url: 'jNQXAC9IVRw' }, context()).then((one) => one.text);
    expect(await read(failing({ stderr: 'ERROR: [youtube] jNQXAC9IVRw: Video unavailable. This video is private\n' }))).toBe('yt-dlp could not read this video: Video unavailable. This video is private.');
    expect(await read(failing({ timedOut: true }))).toContain('more than 90 seconds');
    expect(await read(failing({ aborted: true }))).toBe('Stopped by the founder.');
    expect(await tools({})('read_youtube').run({ url: 'https://example.com/video' }, context())).toEqual({ text: 'Only YouTube addresses can be read this way. For another page, use web_fetch.' });
    expect((await tools({})('read_youtube').run({}, context())).text).toContain('"url"');
  });

  it('is not offered as working when yt-dlp is missing', () => {
    expect(tools({ hasYtdlp: () => false })('read_youtube').ready!()).toContain('yt-dlp is not installed');
    expect(tools({ hasYtdlp: () => true })('read_youtube').ready!()).toBeNull();
  });

  it('kills the program when the founder stops the turn', async () => {
    const stop = new AbortController();
    const started = Date.now();
    const running = execProgram(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: tmpdir(), timeoutMs: 30_000, signal: stop.signal });
    setTimeout(() => stop.abort(), 100);
    const ran = await running;
    expect(ran.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    const late = await execProgram(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: tmpdir(), timeoutMs: 100 });
    expect(late.timedOut).toBe(true);
    const missing = await execProgram('no-such-program-here', [], { cwd: tmpdir(), timeoutMs: 1000 });
    expect(missing.code).toBeNull();
  });
});

describe('read_feed', () => {
  it('reads RSS 2.0: CDATA, entities, a guid for a link, and no script', () => {
    const feed = parseFeed(fixture('rss.xml'))!;
    expect(feed.kind).toBe('RSS');
    expect(feed.title).toBe('Indie Pricing Notes');
    expect(feed.items.map((one) => one.title)).toEqual(['Why we doubled our price & kept every customer', 'Old post about seats & usage', 'The newest one', 'No date at all']);
    expect(feed.items[0].summary).toBe('We were scared . Then we did it.');
    expect(feed.items[1]).toMatchObject({ link: 'https://pricing.example.com/seats', at: Date.UTC(2024, 2, 2, 10), summary: 'Seats or usage? Both .' });
    expect(feed.items[3].at).toBeNull();
  });

  it('reads Atom, taking the page a post lives on over its own feed address', () => {
    const feed = parseFeed(fixture('atom.xml'))!;
    expect(feed).toMatchObject({ kind: 'Atom', title: 'Changelog & Releases' });
    expect(feed.items[0]).toEqual({ title: 'Version 2.0 is out', link: 'https://tool.example.com/changelog/2-0', at: Date.UTC(2026, 8, 22, 12), summary: 'Faster sync, new pricing page.' });
    expect(feed.items[1]).toMatchObject({ link: 'https://tool.example.com/changelog/1-9', summary: 'Bug fixes.' });
  });

  it('reads JSON Feed, and knows a page is not a feed', () => {
    const feed = parseFeed(fixture('feed.json'))!;
    expect(feed.kind).toBe('JSON Feed');
    expect(feed.items[0]).toEqual({ title: 'Issue 41: cold email that works', link: 'https://weekly.example.com/41', at: Date.UTC(2026, 8, 18, 5), summary: 'Three examples .' });
    expect(parseFeed(fixture('page.html'))).toBeNull();
    expect(parseFeed('{"items": []}')).toBeNull();
  });

  it('finds the feeds a page names in its head', () => {
    expect(feedLinks(fixture('page.html'), 'https://pricing.example.com/blog/')).toEqual(['https://pricing.example.com/feed.xml', 'https://other.example.com/atom.xml']);
  });

  it('follows a page to its feed and gives the posts newest first, dated, with short summaries', async () => {
    const long = fixture('rss.xml').replace('LONGTEXT', 'word '.repeat(300));
    const { http, asked } = web({ 'https://pricing.example.com/blog': ok(fixture('page.html'), 'text/html'), 'https://pricing.example.com/feed.xml': ok(long, 'application/rss+xml') });
    const { text } = await tools({ http })('read_feed').run({ url: 'pricing.example.com/blog', limit: 3 }, context());
    expect(asked.map((one) => one.url)).toEqual(['https://pricing.example.com/blog', 'https://pricing.example.com/feed.xml']);
    expect(text.startsWith(UNTRUSTED)).toBe(true);
    expect(text).toContain('Feed: Indie Pricing Notes (RSS, https://pricing.example.com/feed.xml)');
    expect(text).toContain('3 of 4 posts, newest first. The newest is from 2026-09-23 (yesterday).');
    const titles = [...text.matchAll(/^\d+\. (.*)$/gm)].map((one) => one[1]);
    expect(titles).toEqual(['The newest one', 'Why we doubled our price & kept every customer', 'Old post about seats & usage']);
    expect(text).toContain('2026-09-23T18:00Z (yesterday) · https://pricing.example.com/newest');
    expect(text).toContain('2024-03-02T10:00Z (2 years ago)');
    const summary = text.split('\n').find((line) => line.startsWith('   word'))!;
    expect(summary.trim().length).toBeLessThanOrEqual(400);
  });

  it('takes fifteen posts unless asked, and never more than forty', async () => {
    const items = Array.from({ length: 50 }, (_, index) => ({ id: String(index), url: `https://f.example.com/${index}`, title: `Post ${index}`, date_published: new Date(NOW - index * 86_400_000).toISOString() }));
    const { http } = web({ 'https://f.example.com/feed.json': ok(JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'F', items })) });
    const read = (limit?: number) => tools({ http })('read_feed').run({ url: 'https://f.example.com/feed.json', ...(limit ? { limit } : {}) }, context()).then((one) => one.text);
    expect(await read()).toContain('15 of 50 posts');
    expect(await read(100)).toContain('40 of 50 posts');
  });

  it('never reads this machine, not even when a feed redirects there', async () => {
    const { http, asked } = web({ 'https://sly.example.com/feed': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/secret' } }) });
    expect((await tools({ http })('read_feed').run({ url: 'http://localhost:3000/feed' }, context())).text).toBe('The feed could not be read: addresses on this machine or the local network cannot be opened.');
    expect((await tools({ http })('read_feed').run({ url: 'https://sly.example.com/feed' }, context())).text).toContain('cannot be opened');
    expect(asked.map((one) => one.url)).toEqual(['https://sly.example.com/feed']);
    // A public name that points home is refused before anything is asked.
    const home = await tools({ http, resolveHost: async () => ['192.168.1.10'] })('read_feed').run({ url: 'https://looks-public.example.com/feed' }, context());
    expect(home.text).toContain('cannot be opened');
  });

  it('says what went wrong in a sentence', async () => {
    const { http } = web({ 'https://plain.example.com/': ok('<html><head><title>x</title></head></html>', 'text/html'), 'https://gone.example.com/feed': () => new Response('', { status: 410 }) });
    expect((await tools({ http })('read_feed').run({ url: 'https://plain.example.com/' }, context())).text).toBe('That page is not a feed and names no feed. Read it with web_fetch, or look on the site for an RSS link.');
    expect((await tools({ http })('read_feed').run({ url: 'https://gone.example.com/feed' }, context())).text).toBe('The feed could not be read: the site answered 410.');
    const slow = (async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as typeof fetch;
    expect((await tools({ http: slow })('read_feed').run({ url: 'https://slow.example.com/feed' }, context())).text).toBe('The feed could not be read: it took too long to answer.');
  });
});

describe('read_reddit', () => {
  beforeEach(() => resetReddit());

  it('turns what was asked into Reddit\'s own addresses', () => {
    expect(redditAsk({ query: 'pricing help', subreddit: 'r/startups', sort: 'top', time: 'month' })).toMatchObject({
      kind: 'search',
      json: 'https://www.reddit.com/r/startups/search.json?q=pricing%20help&restrict_sr=1&sort=top&t=month&limit=25&raw_json=1',
      rss: 'https://www.reddit.com/r/startups/search.rss?q=pricing%20help&restrict_sr=1&sort=top&t=month&limit=25',
    });
    expect(redditAsk({ query: 'crm' }).json).toBe('https://www.reddit.com/search.json?q=crm&sort=relevance&limit=25&raw_json=1');
    expect(redditAsk({ subreddit: 'SaaS' }).json).toBe('https://www.reddit.com/r/SaaS/hot.json?limit=25&raw_json=1');
    expect(redditAsk({ url: 'https://old.reddit.com/r/startups/comments/abc123/some_title/' }).json).toBe('https://www.reddit.com/r/startups/comments/abc123/some_title.json?sort=top&limit=100&raw_json=1');
    expect(redditAsk({ url: 'https://redd.it/abc123' }).json).toBe('https://www.reddit.com/comments/abc123.json?sort=top&limit=100&raw_json=1');
    expect(redditAsk({ url: 'https://www.reddit.com/r/startups/' }).kind).toBe('listing');
    expect(() => redditAsk({ subreddit: 'two words' })).toThrow('not a subreddit name');
    expect(() => redditAsk({ url: 'https://evil.example.com/r/x/comments/abc' })).toThrow('not a Reddit address');
    expect(() => redditAsk({ query: 'x', sort: 'best' })).toThrow('"sort" must be one of');
    expect(() => redditAsk({})).toThrow('Say what to read');
  });

  it('searches with a plain name for itself and no cookies, and dates every post', async () => {
    const { http, asked } = web({ [redditAsk({ query: 'pricing', subreddit: 'startups' }).json]: ok(fixture('reddit-search.json'), 'application/json') });
    let paced = 0;
    const { text } = await tools({ http, pace: async () => { paced += 1; } })('read_reddit').run({ query: 'pricing', subreddit: 'startups' }, context());
    expect(paced).toBe(1);
    expect(asked[0].headers['user-agent']).toMatch(/^cubicle-reader\/1\.0/);
    expect(Object.keys(asked[0].headers).map((one) => one.toLowerCase())).not.toContain('cookie');
    expect(text.startsWith(UNTRUSTED)).toBe(true);
    expect(text).toContain('1. How did you price your first B2B product?\n   r/startups · u/founder_one · 412 points · 88 comments · 2025-09-20 (12 months ago)');
    expect(text).toContain('https://www.reddit.com/r/startups/comments/abc123/how_did_you_price_your_first_b2b_product/');
    expect(text).toContain('(links to https://blog.example.com/teardown)');
    expect(text).toContain('2024-10-01 (24 months ago)');
  });

  it('reads a thread: the post, then the top comments by score, each with its best replies one level down', async () => {
    const url = 'https://www.reddit.com/r/startups/comments/abc123/how_did_you_price_your_first_b2b_product/';
    const { http } = web({ [redditAsk({ url }).json]: ok(fixture('reddit-thread.json'), 'application/json') });
    const { text } = await tools({ http })('read_reddit').run({ url }, context());
    expect(text).toContain('We charge $29 a month and it feels too low.');
    const comments = text.split('\n').filter((line) => /^\s*- u\//.test(line)).map((line) => line.replace(/ ·.*$/, ''));
    expect(comments).toEqual(['- u/top_voice', '  - u/reply_big', '  - u/reply_small', '- u/middle', '- u/low_scorer']);
    expect(text).not.toContain('too_deep');
    expect(text).not.toContain('[removed]');
    expect(text).toContain('u/top_voice · 250 points · 2025-09-20 (12 months ago): Talk to ten customers');
  });

  it('says Reddit refused when it is told to slow down', async () => {
    const { http } = web({ [redditAsk({ query: 'x' }).json]: () => new Response('', { status: 429 }) });
    expect((await tools({ http })('read_reddit').run({ query: 'x' }, context())).text).toBe(REDDIT_REFUSED);
    expect(REDDIT_REFUSED).toBe('Reddit refused this request; try again in a minute.');
  });

  it('reads the public feed when the data is refused, and goes straight there for a while after', async () => {
    const search = redditAsk({ query: 'pricing', subreddit: 'startups' });
    const thread = redditAsk({ url: 'https://www.reddit.com/r/startups/comments/abc123/how_did_you_price/' });
    const { http, asked } = web({
      [search.json]: () => new Response('<html>blocked</html>', { status: 403 }),
      [search.rss]: ok(fixture('reddit-search.atom.xml'), 'application/atom+xml'),
      [thread.rss]: ok(fixture('reddit-thread.atom.xml'), 'application/atom+xml'),
    });
    const read = tools({ http })('read_reddit');
    const found = (await read.run({ query: 'pricing', subreddit: 'startups' }, context())).text;
    expect(found.startsWith(UNTRUSTED)).toBe(true);
    expect(found).toContain('no scores or comment counts');
    expect(found).toContain('1. How did you price your first B2B product?\n   u/founder_one · 2026-09-20 (4 days ago)');
    expect(found).toContain('We charge $29 and it feels too low. I\'m scared to raise it.');
    expect(found).not.toContain('submitted by');
    const talk = (await read.run({ url: 'https://www.reddit.com/r/startups/comments/abc123/how_did_you_price/' }, context())).text;
    expect(talk).toContain('- u/top_voice · 2026-09-21 (3 days ago): Talk to ten customers first.');
    expect(asked.map((one) => one.url)).toEqual([search.json, search.rss, thread.rss]);
  });

  it('refuses in the same words when the feed is refused too, and never follows Reddit off Reddit', async () => {
    const ask = redditAsk({ query: 'x' });
    const { http } = web({ [ask.json]: () => new Response('', { status: 403 }), [ask.rss]: () => new Response('', { status: 403 }) });
    expect((await tools({ http })('read_reddit').run({ query: 'x' }, context())).text).toBe(REDDIT_REFUSED);
    resetReddit();
    const away = web({ [ask.json]: () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com/' } }) });
    expect((await tools({ http: away.http })('read_reddit').run({ query: 'x' }, context())).text).toContain('which this reader does not follow');
  });

  it('keeps two seconds between requests however many people ask at once', async () => {
    let clock = 0;
    const slept: number[] = [];
    const pace = createPace(2000, () => clock, async (ms) => { slept.push(ms); });
    await Promise.all([pace(), pace(), pace()]);
    expect(slept).toEqual([2000, 4000]);
    clock = 10_000;
    await pace();
    expect(slept).toEqual([2000, 4000]);
    clock = 10_500;
    await pace();
    expect(slept).toEqual([2000, 4000, 1500]);
  });
});

describe('the slice', () => {
  it('offers all three to everyone, capped per turn', async () => {
    const { default: slice } = await import('./readers.ts');
    const installed = await slice.install({ workspace: tmpdir() } as never);
    expect(installed.tools!.map((one) => [one.name, one.perTurn])).toEqual([['read_youtube', 2], ['read_feed', 3], ['read_reddit', 3]]);
    expect('offer' in installed).toBe(false);
  });

  it('keeps its fixtures where the tests find them', async () => {
    expect((await readdir(FIXTURES)).sort()).toEqual(expect.arrayContaining(['atom.xml', 'captions.json3', 'captions.vtt', 'feed.json', 'page.html', 'reddit-search.json', 'reddit-thread.json', 'rss.xml']));
  });
});
