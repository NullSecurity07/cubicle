import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { dnsResolve, webUrl, type Resolve } from '../browser.ts';
import type { Deps, Slice } from '../install.ts';
import {
  age, atomEntries, attr, clip, createPace, decode, failure, getPublic, htmlToText, isoDay, oneLine, parseFeed, reddit, REDDIT_AGENT, REDDIT_GAP, REDDIT_REST,
  resetReddit, when, type Feed, type Got, type Item,
} from '../readers.ts';

// Kept where they were first found: the tests and the health checks read them from here.
export { age, attr, createPace, isoDay, parseFeed, REDDIT_AGENT, REDDIT_GAP, resetReddit, when, type Feed, type Item };
import type { Tool, ToolContext } from '../tools/registry.ts';
import { webCache } from '../cache.ts';
import { UNTRUSTED } from '../tools/web.ts';

// Three ways to hear customers and a market that a web page does not give: what was said in a video, what a blog or
// a news site has put out lately, and how people on Reddit talk about a problem in their own words. All three only
// read, never sign in and never send anything, so they are offered to everyone the way web_fetch is.

export const TRANSCRIPT_CHARS = 20_000;
export const REDDIT_CHARS = 20_000;
export const SUMMARY_CHARS = 400;
export const FEED_LIMIT = 15;
export const FEED_MAX = 40;
export const YTDLP_MS = 90_000;
export const FEED_MS = 20_000;
const FEED_AGENT = 'cubicle-reader/1.0 (desktop app; reads one feed for its owner)';
export const REDDIT_REFUSED = 'Reddit refused this request; try again in a minute.';

// ---------------------------------------------------------------- programs

export type Ran = { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean };
export type Exec = (command: string, args: string[], options: { cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<Ran>;

// Runs a program and always comes back: a program that is missing, hangs or is stopped by the founder is an answer
// too. A stopped turn kills it outright, because a half-read video is worth nothing and yt-dlp would carry on alone.
export const execProgram: Exec = (command, args, { cwd, timeoutMs, signal }) => new Promise((settle) => {
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let aborted = false;
  let done = false;
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = () => { if (child.exitCode === null) child.kill('SIGKILL'); };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  const stop = () => { aborted = true; kill(); };
  const finish = (code: number | null) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    settle({ code, stdout, stderr, timedOut, aborted });
  };
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 30_000_000) stdout += chunk; });
  child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 100_000) stderr += chunk; });
  child.on('error', (error) => { stderr += error.message; finish(null); });
  child.on('close', (code) => finish(code));
});

// Is a program on the PATH? Asked before a person is offered the tool, so it has to answer at once.
export const hasProgram = (command: string, env: NodeJS.ProcessEnv = process.env) => (env.PATH ?? '').split(delimiter).filter(Boolean).some((where) => existsSync(join(where, command)));

// ---------------------------------------------------------------- YouTube

export type Line = { at: number; text: string };

// One video, never a channel or a playlist: those would be hundreds of videos in one call.
export function youtubeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return `https://www.youtube.com/watch?v=${trimmed}`;
  const href = webUrl(trimmed);
  const url = new URL(href);
  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be' && /^\/[\w-]{6,}/.test(url.pathname)) return href;
  if (!/(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$/.test(host)) throw new Error('Only YouTube addresses can be read this way. For another page, use web_fetch.');
  if ((url.pathname === '/watch' && url.searchParams.get('v')) || /^\/(shorts|live|embed)\/[\w-]+/.test(url.pathname)) return href;
  throw new Error('Give the address of one video (youtube.com/watch?v=…), not a channel, a playlist or a search.');
}

type Info = {
  title?: string; channel?: string; uploader?: string; upload_date?: string; duration?: number; view_count?: number; webpage_url?: string; description?: string;
  subtitles?: Record<string, unknown>; automatic_captions?: Record<string, unknown>;
};

// The one English track worth reading. Captions the uploader wrote beat automatic ones; among automatic ones,
// `en-orig` is what was really said, while plain `en` on a video in another language is a machine translation.
export function pickTrack(info: Info): { lang: string; auto: boolean } | null {
  const english = (langs: string[], order: RegExp[]) => {
    for (const test of order) { const found = langs.find((one) => test.test(one)); if (found) return found; }
    return null;
  };
  const manual = english(Object.keys(info.subtitles ?? {}), [/^en$/, /^en-(US|GB|CA|AU|IE|IN|NZ)$/i, /^en[-_][A-Za-z]{2,4}$/]);
  if (manual) return { lang: manual, auto: false };
  const auto = english(Object.keys(info.automatic_captions ?? {}), [/^en-orig$/, /^en$/]);
  return auto ? { lang: auto, auto: true } : null;
}

// YouTube's own caption format: one event per caption, its words in `segs`.
export function fromJson3(raw: string): Line[] {
  const data = JSON.parse(raw) as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] };
  return dedupe((data.events ?? []).filter((event) => event.segs?.length).map((event) => ({ at: (event.tStartMs ?? 0) / 1000, text: oneLine(event.segs!.map((seg) => seg.utf8 ?? '').join('')) })));
}

const seconds = (stamp: string) => stamp.split(':').reduce((sum, part) => sum * 60 + Number(part.replace(',', '.')), 0);
// WebVTT, the fallback. Automatic captions roll: each cue repeats the line before it, so a line seen a moment ago is
// not written twice.
export function fromVtt(raw: string): Line[] {
  const lines: Line[] = [];
  for (const block of raw.replace(/\r/g, '').split(/\n{2,}/)) {
    const rows = block.split('\n');
    const timing = rows.findIndex((row) => row.includes('-->'));
    if (timing < 0) continue;
    const at = seconds(rows[timing].split('-->')[0].trim());
    for (const row of rows.slice(timing + 1)) lines.push({ at, text: oneLine(decode(row.replace(/<[^>]+>/g, ''))) });
  }
  return dedupe(lines);
}
function dedupe(lines: Line[]): Line[] {
  const recent: string[] = [];
  const kept: Line[] = [];
  for (const line of lines) {
    if (!line.text || recent.includes(line.text)) continue;
    recent.push(line.text);
    if (recent.length > 3) recent.shift();
    kept.push(line);
  }
  return kept;
}

export const clock = (at: number) => {
  const whole = Math.max(0, Math.floor(at));
  const [hours, minutes, secs] = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
  const two = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${two(minutes)}:${two(secs)}` : `${minutes}:${two(secs)}`;
};

// The words as paragraphs of about a minute, each opening with where it starts, so a person can say "at 12:30 she
// says…" and the founder can go and listen. Cut at a whole paragraph where it can be.
export function flatten(lines: Line[], cap = TRANSCRIPT_CHARS): { text: string; cutAt: number | null } {
  const blocks: { at: number; text: string }[] = [];
  for (const line of lines) {
    const last = blocks.at(-1);
    if (last && line.at < last.at + 60) last.text += ` ${line.text}`;
    else blocks.push({ at: line.at, text: line.text });
  }
  let text = '';
  for (const [index, block] of blocks.entries()) {
    const paragraph = `[${clock(block.at)}] ${block.text}`;
    const joined = text ? `${text}\n${paragraph}` : paragraph;
    if (joined.length > cap) return { text: text || paragraph.slice(0, cap), cutAt: blocks[text ? index : index + 1]?.at ?? block.at };
    text = joined;
  }
  return { text, cutAt: null };
}

const YTDLP_BASE = ['--ignore-config', '--no-playlist', '--no-warnings', '--no-progress', '--skip-download', '--ignore-no-formats-error'];
const said = (stderr: string) => clip(oneLine((stderr.match(/ERROR:\s*(.*)/)?.[1] ?? stderr).replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '')), 240);

export type ReaderOptions = {
  workspace: string;
  exec?: Exec; http?: typeof fetch; resolveHost?: Resolve; now?: () => number;
  pace?: () => Promise<void>; hasYtdlp?: () => boolean;
  // Keep each read fifteen minutes under the workspace's cache folder. On in the app, off in fake mode and in tests.
  cache?: boolean;
};

async function readYoutube(raw: string, options: ReaderOptions, signal?: AbortSignal): Promise<string> {
  const { exec = execProgram, now = Date.now } = options;
  let url: string;
  try { url = youtubeUrl(raw); } catch (error) { return (error as Error).message; }
  const dir = join(options.workspace, '.readers', `yt-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const stopped = (ran: Ran) => (ran.aborted ? 'Stopped by the founder.' : ran.timedOut ? 'Reading the video took more than 90 seconds, so it was stopped. Try again later.' : null);
  try {
    await mkdir(dir, { recursive: true });
    // First what the video is, and which captions it has. Written down, so the second run reads it back instead of
    // asking YouTube again: two page loads a minute apart is what gets a machine told to slow down.
    const first = await exec('yt-dlp', [...YTDLP_BASE, '--dump-json', '--', url], { cwd: dir, timeoutMs: YTDLP_MS, signal });
    const early = stopped(first);
    if (early) return early;
    let info: Info;
    try { info = JSON.parse(first.stdout) as Info; } catch { return `yt-dlp could not read this video: ${said(first.stderr) || 'it gave nothing back'}.`; }
    const head = header(info, url, now());
    const track = pickTrack(info);
    if (!track) return `${UNTRUSTED}${head}\n\nThis video has no English captions, so there is no transcript to read.`;
    await writeFile(join(dir, 'info.json'), first.stdout);
    const second = await exec('yt-dlp', [...YTDLP_BASE, '--load-info-json', 'info.json', track.auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', track.lang, '--sub-format', 'json3/vtt', '-o', join(dir, 'v.%(ext)s')], { cwd: dir, timeoutMs: YTDLP_MS, signal });
    const late = stopped(second);
    if (late) return late;
    const files = await readdir(dir);
    const json3 = files.find((one) => one.endsWith('.json3'));
    const vtt = files.find((one) => one.endsWith('.vtt'));
    if (!json3 && !vtt) return `${UNTRUSTED}${head}\n\nThe captions could not be fetched${second.stderr ? ` (${said(second.stderr)})` : ''}. Try again in a minute.`;
    const body = await readFile(join(dir, (json3 ?? vtt)!), 'utf8');
    const lines = json3 ? fromJson3(body) : fromVtt(body);
    if (!lines.length) return `${UNTRUSTED}${head}\n\nThis video's captions are empty, so there is no transcript to read.`;
    const { text, cutAt } = flatten(lines);
    const kind = track.auto ? `made automatically by YouTube (${track.lang}), so names and numbers may be misheard` : `written for the video (${track.lang})`;
    const cut = cutAt === null ? '' : `\n\n(Cut here at ${clock(cutAt)} of ${info.duration ? clock(info.duration) : 'the video'}: only the first ${TRANSCRIPT_CHARS.toLocaleString('en-US')} characters are shown.)`;
    return `${UNTRUSTED}${head}\nCaptions: ${kind}\n\nTranscript:\n${text}${cut}`;
  } catch (error) {
    return `The video could not be read: ${(error as Error).message}.`;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function header(info: Info, url: string, now: number): string {
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(info.upload_date ?? '');
  const uploaded = day ? when(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])), now) : 'not given';
  return [
    `Video: ${oneLine(info.title ?? '(no title)')}`,
    `Channel: ${info.channel ?? info.uploader ?? 'not given'}`,
    `Uploaded: ${uploaded}`,
    ...(info.duration ? [`Length: ${clock(info.duration)}`] : []),
    ...(typeof info.view_count === 'number' ? [`Views: ${info.view_count.toLocaleString('en-US')} (as of today)`] : []),
    `Address: ${info.webpage_url ?? url}`,
    ...(info.description?.trim() ? [`Description: ${clip(oneLine(info.description), 500)}`] : []),
  ].join('\n');
}

// ---------------------------------------------------------------- fetching

// A site's own page names its feed in a `<link rel="alternate">` in its head.
export function feedLinks(html: string, base: string): string[] {
  const found: string[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    const type = (attr(tag, 'type') ?? '').toLowerCase();
    const href = attr(tag, 'href');
    if (!href || !rel.includes('alternate') || !/application\/(rss\+xml|atom\+xml|feed\+json)/.test(type)) continue;
    try { found.push(new URL(href, base).href); } catch { /* a broken link is no feed */ }
  }
  return [...new Set(found)];
}

export function showFeed(feed: Feed, address: string, limit: number, now: number): string {
  // Newest first, whatever order the feed keeps; an item without a date goes to the end.
  const items = feed.items.map((item, index) => ({ item, index })).sort((a, b) => (b.item.at ?? -Infinity) - (a.item.at ?? -Infinity) || a.index - b.index).slice(0, limit).map(({ item }) => item);
  if (!items.length) return `${UNTRUSTED}Feed: ${feed.title || address}\nIt has no posts in it right now.`;
  const lines = items.map((item, index) => [
    `${index + 1}. ${item.title || '(no title)'}`,
    `   ${item.at === null ? 'date not given' : `${new Date(item.at).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z')} (${age(item.at, now)})`}${item.link ? ` · ${item.link}` : ''}`,
    ...(item.summary ? [`   ${clip(item.summary, SUMMARY_CHARS)}`] : []),
  ].join('\n'));
  const newest = items[0].at;
  return `${UNTRUSTED}Feed: ${feed.title || '(no title)'} (${feed.kind}, ${address})\n${items.length} of ${feed.items.length} posts, newest first.${newest === null ? '' : ` The newest is from ${when(newest, now)}.`}\n\n${lines.join('\n\n')}`;
}

async function readFeed(raw: string, limit: number, options: ReaderOptions, signal?: AbortSignal): Promise<string> {
  const { http = fetch, resolveHost = dnsResolve, now = Date.now } = options;
  const get = (url: string) => getPublic(url, { http, resolveHost, agent: FEED_AGENT, timeoutMs: FEED_MS, signal, accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5' });
  let got: Got;
  try { got = await get(raw); } catch (error) { return `The feed could not be read: ${failure(error)}.`; }
  if (got.status >= 400) return `The feed could not be read: the site answered ${got.status}.`;
  let feed = parseFeed(got.body);
  // A page, not a feed: follow the first feed it names, once.
  if (!feed) {
    const [link] = feedLinks(got.body, got.url);
    if (!link) return 'That page is not a feed and names no feed. Read it with web_fetch, or look on the site for an RSS link.';
    try { got = await get(link); } catch (error) { return `The page names a feed at ${link}, but it could not be read: ${failure(error)}.`; }
    if (got.status >= 400) return `The page names a feed at ${link}, but the site answered ${got.status}.`;
    feed = parseFeed(got.body);
    if (!feed) return `The page names a feed at ${link}, but what came back is not a feed.`;
  }
  return showFeed(feed, got.url, limit, now());
}

// ---------------------------------------------------------------- Reddit

type Post = { title?: string; subreddit?: string; author?: string; score?: number; num_comments?: number; created_utc?: number; permalink?: string; selftext?: string; url?: string; is_self?: boolean };
type Comment = { author?: string; body?: string; score?: number; created_utc?: number; replies?: Listing<Comment> | '' };
type Listing<T> = { kind?: string; data?: { children?: { kind: string; data: T }[] } };

export const SORTS = ['relevance', 'new', 'top', 'hot'] as const;
export const TIMES = ['hour', 'day', 'week', 'month', 'year', 'all'] as const;
const REDDIT_HOST = /(^|\.)reddit\.com$/;

export type RedditAsk = { kind: 'search' | 'listing' | 'thread'; json: string; rss: string; about: string };
// What was asked, as the two addresses that answer it: the JSON Reddit gives anyone, and its public feed of the same
// thing, used when the JSON is refused. Throws a sentence when the ask cannot be read.
export function redditAsk(args: Record<string, unknown>): RedditAsk {
  const str = (key: string) => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
  const sort = str('sort') || undefined;
  const time = str('time') || undefined;
  if (sort && !(SORTS as readonly string[]).includes(sort)) throw new Error(`"sort" must be one of: ${SORTS.join(', ')}.`);
  if (time && !(TIMES as readonly string[]).includes(time)) throw new Error(`"time" must be one of: ${TIMES.join(', ')}.`);
  const sub = str('subreddit').replace(/^\/?r\//i, '').replace(/\/+$/, '');
  if (sub && !/^[A-Za-z0-9_]{2,21}$/.test(sub)) throw new Error(`"${sub}" is not a subreddit name. Write it without spaces, like startups.`);
  const url = str('url');
  if (url) {
    let parsed: URL;
    try { parsed = new URL(/^https?:/i.test(url) ? url : `https://${url}`); } catch { throw new Error('That is not a Reddit address.'); }
    const host = parsed.hostname.toLowerCase();
    const path = host === 'redd.it' ? `/comments/${parsed.pathname.replace(/^\/+|\/+$/g, '')}` : parsed.pathname.replace(/\/+$/, '').replace(/\.(json|rss)$/, '');
    if (host !== 'redd.it' && !REDDIT_HOST.test(host)) throw new Error('That is not a Reddit address. Give a thread address (reddit.com/r/…/comments/…), or use "query".');
    if (/\/comments\/[a-z0-9]+/i.test(path)) return { kind: 'thread', json: `https://www.reddit.com${path}.json?sort=top&limit=100&raw_json=1`, rss: `https://www.reddit.com${path}/.rss?sort=top`, about: 'thread' };
    const listed = /^\/r\/([A-Za-z0-9_]{2,21})$/.exec(path);
    if (!listed) throw new Error('Give a thread address (reddit.com/r/…/comments/…) or a subreddit, or search with "query".');
    return redditAsk({ subreddit: listed[1], sort, time });
  }
  const query = str('query');
  const window = time ? `&t=${time}` : '';
  if (query) {
    const where = sub ? `/r/${sub}/search` : '/search';
    const params = `?q=${encodeURIComponent(query)}${sub ? '&restrict_sr=1' : ''}&sort=${sort ?? 'relevance'}${window}&limit=25`;
    return { kind: 'search', json: `https://www.reddit.com${where}.json${params}&raw_json=1`, rss: `https://www.reddit.com${where}.rss${params}`, about: `Reddit search for "${query}"${sub ? ` in r/${sub}` : ''}, by ${sort ?? 'relevance'}${time ? `, past ${time}` : ''}` };
  }
  if (sub) {
    const order = sort && sort !== 'relevance' ? sort : 'hot';
    return { kind: 'listing', json: `https://www.reddit.com/r/${sub}/${order}.json?limit=25${window}&raw_json=1`, rss: `https://www.reddit.com/r/${sub}/${order}/.rss?limit=25${window}`, about: `r/${sub}, ${order} posts${time && order === 'top' ? `, past ${time}` : ''}` };
  }
  throw new Error('Say what to read: "query" to search, "subreddit" to list a community, or "url" for one thread.');
}

const postLine = (post: Post, now: number) => [post.subreddit ? `r/${post.subreddit}` : '', post.author ? `u/${post.author}` : '', typeof post.score === 'number' ? `${post.score} points` : '', typeof post.num_comments === 'number' ? `${post.num_comments} comments` : '', post.created_utc ? when(post.created_utc * 1000, now) : 'date not given'].filter(Boolean).join(' · ');
const link = (permalink?: string) => (permalink ? `https://www.reddit.com${permalink}` : '');

export function showPosts(listing: Listing<Post>, about: string, now: number): string {
  const posts = (listing.data?.children ?? []).filter((one) => one.kind === 't3').map((one) => one.data);
  if (!posts.length) return `${about}: nothing was found. Try other words, or a wider "time".`;
  const lines = posts.map((post, index) => [
    `${index + 1}. ${oneLine(post.title ?? '(no title)')}`,
    `   ${postLine(post, now)}`,
    `   ${link(post.permalink)}${post.is_self === false && post.url ? ` (links to ${post.url})` : ''}`,
    ...(post.selftext?.trim() ? [`   ${clip(oneLine(post.selftext), 300)}`] : []),
  ].join('\n'));
  return clip(`${about}. ${posts.length} posts.\n\n${lines.join('\n\n')}`, REDDIT_CHARS);
}

export function showThread(data: [Listing<Post>, Listing<Comment>], now: number): string {
  const post = data[0]?.data?.children?.[0]?.data;
  if (!post) return 'That thread came back empty; it may have been removed.';
  const comments = (data[1]?.data?.children ?? []).filter((one) => one.kind === 't1').map((one) => one.data).filter((one) => one.body && one.body !== '[deleted]' && one.body !== '[removed]');
  const byScore = (a: Comment, b: Comment) => (b.score ?? 0) - (a.score ?? 0);
  const top = [...comments].sort(byScore).slice(0, 20);
  const say = (comment: Comment, max: number) => `u/${comment.author ?? '[deleted]'} · ${comment.score ?? 0} points · ${comment.created_utc ? when(comment.created_utc * 1000, now) : 'date not given'}: ${clip(oneLine(comment.body ?? ''), max)}`;
  const shown = top.map((comment) => {
    const replies = (comment.replies && comment.replies.data?.children ? comment.replies.data.children : []).filter((one) => one.kind === 't1').map((one) => one.data).filter((one) => one.body).sort(byScore).slice(0, 3);
    return [`- ${say(comment, 600)}`, ...replies.map((reply) => `  - ${say(reply, 300)}`)].join('\n');
  });
  const body = post.selftext?.trim() ? `\n\n${clip(post.selftext.trim(), 4000)}` : '';
  const out = `${oneLine(post.title ?? '(no title)')}\n${postLine(post, now)}\n${link(post.permalink)}${post.is_self === false && post.url ? `\nLinks to: ${post.url}` : ''}${body}\n\n`
    + (shown.length ? `Top ${shown.length} comments by score (of ${comments.length} loaded), each with its best replies:\n${shown.join('\n')}` : 'No comments yet.');
  return clip(out, REDDIT_CHARS);
}

// The same read through Reddit's public feed: authors, dates and words, but no scores. A thread's feed is the post
// first, then its comments in Reddit's own order.
export function showRedditFeed(body: string, ask: RedditAsk, now: number): string | null {
  const entries = atomEntries(body).map((entry) => ({
    ...entry,
    author: entry.author.replace(/^\/u\//, 'u/'),
    text: oneLine(htmlToText(entry.content).replace(/\s*submitted by[\s\S]*$/, '')),
  }));
  if (!/<feed[\s>]/i.test(body)) return null;
  const note = 'Reddit refused its data, so this came through its public feed: no scores or comment counts.';
  const dated = (at: number | null) => (at === null ? 'date not given' : when(at, now));
  if (!entries.length) return `${ask.about === 'thread' ? 'That thread' : ask.about}: nothing was found.`;
  if (ask.kind === 'thread') {
    const [post, ...comments] = entries;
    const shown = comments.slice(0, 20).map((one) => `- ${one.author} · ${dated(one.at)}: ${clip(one.text, 600)}`);
    return clip(`${note}\n\n${post.title}\n${post.author} · ${dated(post.at)}\n${post.link}\n\n${clip(post.text, 4000)}\n\n${shown.length ? `First ${shown.length} comments, in Reddit's order:\n${shown.join('\n')}` : 'No comments yet.'}`, REDDIT_CHARS);
  }
  const lines = entries.map((one, index) => `${index + 1}. ${one.title}\n   ${one.author} · ${dated(one.at)}\n   ${one.link}${one.text ? `\n   ${clip(one.text, 300)}` : ''}`);
  return clip(`${note}\n${ask.about}. ${entries.length} posts.\n\n${lines.join('\n\n')}`, REDDIT_CHARS);
}

// Where Reddit has refused its data from this machine, its feed is asked first for a while instead of being asked
// twice every time. Kept per process, like the pace.

async function readReddit(args: Record<string, unknown>, options: ReaderOptions, signal?: AbortSignal): Promise<string> {
  const { http = fetch, now = Date.now, pace = reddit.pace } = options;
  let ask: RedditAsk;
  try { ask = redditAsk(args); } catch (error) { return (error as Error).message; }
  const get = async (url: string) => { await pace(); return getPublic(url, { http, agent: REDDIT_AGENT, timeoutMs: FEED_MS, signal, only: REDDIT_HOST }); };
  try {
    if (now() < reddit.refusedUntil) return REDDIT_REFUSED;
    if (now() >= reddit.jsonRefusedUntil) {
      const got = await get(ask.json);
      if (got.status === 429) { reddit.refusedUntil = now() + REDDIT_REST; return REDDIT_REFUSED; }
      if (got.status === 404) return 'Reddit has no such thread or community.';
      if (got.status < 400) {
        let data: unknown;
        try { data = JSON.parse(got.body); } catch { data = null; }
        if (data) return UNTRUSTED + (ask.kind === 'thread' ? showThread(data as [Listing<Post>, Listing<Comment>], now()) : showPosts(data as Listing<Post>, ask.about, now()));
      }
      // Refused (403) or handed a page instead of data: Reddit walls this machine's JSON; its feed often still works.
      reddit.jsonRefusedUntil = now() + 10 * 60_000;
    }
    const feed = await get(ask.rss);
    if (feed.status === 404) return 'Reddit has no such thread or community.';
    if (feed.status === 429) reddit.refusedUntil = now() + REDDIT_REST;
    if (feed.status >= 400) return REDDIT_REFUSED;
    const shown = showRedditFeed(feed.body, ask, now());
    return shown ? UNTRUSTED + shown : REDDIT_REFUSED;
  } catch (error) {
    return `Reddit could not be read: ${failure(error)}.`;
  }
}

// ---------------------------------------------------------------- the tools

export function readerTools(options: ReaderOptions): Tool[] {
  const { hasYtdlp = () => hasProgram('yt-dlp') } = options;
  const words = (args: Record<string, unknown>, key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '');
  // The same video, feed or Reddit ask within fifteen minutes is read once; the second answer says when it was read.
  const cache = webCache(options.cache ? options.workspace : null, options.now);
  return [
    {
      name: 'read_youtube',
      perTurn: 2,
      description: 'Read a YouTube video without watching it: its title, channel, upload date, length, views and the full transcript with a timestamp every minute. '
        + 'Give one video address in "url". Use it for talks, interviews, product demos and reviews. Quote the timestamp when you cite something said.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'One YouTube video address' } }, required: ['url'] },
      ready: () => (hasYtdlp() ? null : 'Videos cannot be read on this machine yet: yt-dlp is not installed. Tell the founder; pnpm health says how to add it.'),
      async run(args, context: ToolContext) {
        if (!words(args, 'url').trim()) return { text: 'Give the video\'s address in "url".' };
        return { text: await cache.one(['youtube', words(args, 'url').trim()], () => readYoutube(words(args, 'url'), options, context.signal)) };
      },
    },
    {
      name: 'read_feed',
      perTurn: 3,
      description: 'Read the latest posts of a blog, newsletter, podcast, changelog or news site through its feed (RSS, Atom or JSON Feed). '
        + 'Give the feed address, or just the site\'s page: the feed is found from it. Returns each post\'s title, date, address and a short summary, newest first. '
        + 'Open a post with web_fetch to read all of it.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The feed, or the site whose feed to read' }, limit: { type: 'number', description: `How many posts, ${FEED_LIMIT} unless you say, at most ${FEED_MAX}` } },
        required: ['url'],
      },
      async run(args, context) {
        if (!words(args, 'url').trim()) return { text: 'Give the feed or the site in "url".' };
        const asked = Number(args.limit);
        const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(FEED_MAX, Math.floor(asked)) : FEED_LIMIT;
        return { text: await cache.one(['feed', words(args, 'url').trim(), limit], () => readFeed(words(args, 'url'), limit, options, context.signal)) };
      },
    },
    {
      name: 'read_reddit',
      perTurn: 3,
      description: 'Read Reddit without signing in, to hear how people describe a problem in their own words. '
        + 'Search posts with "query"; add "subreddit" to search one community. Give "subreddit" alone to list its posts. Give "url" to read one thread: the post and its top comments. '
        + 'Every post and comment shows its date. Quote people as they wrote, and say how old a post is.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to search for' },
          subreddit: { type: 'string', description: 'A community name, like startups' },
          url: { type: 'string', description: 'A thread address, to read the post and its comments' },
          sort: { type: 'string', enum: [...SORTS], description: 'relevance (the default for a search), new, top or hot' },
          time: { type: 'string', enum: [...TIMES], description: 'How far back: hour, day, week, month, year or all' },
        },
      },
      async run(args, context) {
        const ask = ['query', 'subreddit', 'url', 'sort', 'time'].map((key) => words(args, key).trim());
        return { text: await cache.one(['reddit', ...ask], () => readReddit(args, options, context.signal)) };
      },
    },
  ];
}

export default {
  name: 'readers',
  install(deps: Deps) { return { tools: readerTools({ workspace: deps.workspace, cache: !deps.fake }) }; },
} satisfies Slice;
