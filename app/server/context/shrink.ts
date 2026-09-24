import type { ModelMessage } from '../prompt.ts';
import type { ModelClient } from '../providers.ts';
import type { Handler } from '../seams.ts';
import type { UsageBook } from '../usage.ts';

// What a tool said, made smaller on its way into the prompt, before the model reads it once. `trimResults` in
// compact.ts cuts the rounds that are already old; this is the first pass, at the door, on every result: the same line
// over and over becomes one line and a count, a web page loses its menus and cookie banners, a long log keeps its
// start and its end, and nothing is longer than a quarter of the smallest model a turn may land on. What was folded
// is said in one line at the end, so the person knows there was more. Only tool results are touched: the founder's
// own words and the system prompt go in as they were written.
export const SHARE = 0.25;
export const HEAD_LINES = 40;
export const TAIL_LINES = 40;
const MARK = '[Shrunk for the prompt:';

// Pages read off the web, where menus and banners come along with the words.
const PAGES = new Set(['web_fetch', 'browse', 'search_source', 'crawl_site']);
// Everything that came from the web, pages or not: a cookie line in a feed is as empty as one on a page.
const WEB = new Set([...PAGES, 'web_search', 'read_feed', 'read_reddit']);
// Programs that print as they run: what matters is how they started and how they ended.
const COMMANDS = new Set(['run_code', 'code_task', 'code_status', 'code_reply']);

// Lines that are never the page: consent banners, "skip to content", share rows, copyright footers.
const BOILERPLATE = [
  /\b(we|this (site|website)) uses? cookies\b/i, /\baccept (all )?cookies\b/i, /\bcookie (policy|settings|preferences|consent)\b/i,
  /^(accept|reject|decline|allow)( all)?$/i, /\bmanage (your )?(cookie|privacy) (settings|preferences)\b/i,
  /^skip (to|navigation)\b/i, /^jump to (content|navigation|main)\b/i, /^(toggle|open|close) (navigation|menu)$/i, /^(menu|search|close|back to top|scroll to top)$/i,
  /^share (this|on)\b/i, /^(sign in|log in|sign up|register|subscribe)( now)?$/i, /^(©|copyright ©?)\s*\d{4}/i, /^all rights reserved\.?$/i,
];
const boilerplate = (line: string) => BOILERPLATE.some((pattern) => pattern.test(line.trim()));
// A line of link text in a menu: a word or three, no sentence, no figure, no address, no heading mark.
const linkText = (line: string) => {
  const text = line.trim();
  return !!text && text.length <= 28 && text.split(/\s+/).length <= 4 && !/[.!?:;,\d$€£%/@#|]/.test(text);
};
const NAV_RUN = 5;
// Menus sit at the top and the bottom of a page. A run of short lines in the middle is more likely a list of features.
const EDGE = 0.2;

export type Shrunk = { text: string; before: number; after: number };

// Five, ten, fifty times the same line in a row is one line with a count. Blank lines in a row are one blank line.
export function foldRepeats(lines: string[]): { lines: string[]; folded: number } {
  const out: string[] = [];
  let folded = 0;
  for (let at = 0; at < lines.length;) {
    let run = 1;
    while (at + run < lines.length && lines[at + run].trim() === lines[at].trim()) run += 1;
    if (!lines[at].trim()) out.push(''); else if (run > 1) { out.push(`${lines[at]} ×${run}`); folded += run - 1; } else out.push(lines[at]);
    at += run;
  }
  return { lines: out, folded };
}

// Banner lines anywhere, and runs of five or more menu-like lines in a row near the top or the bottom of a page.
export function stripChrome(lines: string[], pages: boolean): { lines: string[]; dropped: number } {
  const kept = lines.filter((line) => !boilerplate(line));
  let dropped = lines.length - kept.length;
  if (!pages) return { lines: kept, dropped };
  const out: string[] = [];
  for (let at = 0; at < kept.length;) {
    let run = 0;
    while (at + run < kept.length && linkText(kept[at + run])) run += 1;
    const edge = at < kept.length * EDGE || at + run > kept.length * (1 - EDGE);
    if (run >= NAV_RUN && edge) { dropped += run; at += run; continue; }
    out.push(...kept.slice(at, at + Math.max(run, 1)));
    at += Math.max(run, 1);
  }
  return { lines: out, dropped };
}

export function headTail(lines: string[], head = HEAD_LINES, tail = TAIL_LINES): { lines: string[]; folded: number } {
  if (lines.length <= head + tail) return { lines, folded: 0 };
  const folded = lines.length - head - tail;
  return { lines: [...lines.slice(0, head), `… ${folded} lines folded …`, ...lines.slice(-tail)], folded };
}

// Cut at the last whole line that fits.
export function cutAtLine(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const cut = text.lastIndexOf('\n', cap);
  return cut > cap / 2 ? text.slice(0, cut) : text.slice(0, cap);
}

// A JSON answer is shortened by whole items, so what is left still parses: the first entries of a list, the first
// fields of an object. When not even one fits it is left as it was; the loop's own cap is the last word then.
export function cutJson(text: string, cap: number): { text: string; left: number; of: number } | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const indent = /\n( +)"/.exec(text)?.[1].length ?? /\n( +)[[{"\d]/.exec(text)?.[1].length ?? 0;
  const show = (one: unknown) => JSON.stringify(one, null, indent || undefined);
  if (Array.isArray(value)) {
    let keep = value.length;
    while (keep > 0 && show(value.slice(0, keep)).length > cap) keep -= 1;
    return keep ? { text: show(value.slice(0, keep)), left: value.length - keep, of: value.length } : null;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  let keep = entries.length;
  while (keep > 0 && show(Object.fromEntries(entries.slice(0, keep))).length > cap) keep -= 1;
  return keep ? { text: show(Object.fromEntries(entries.slice(0, keep))), left: entries.length - keep, of: entries.length } : null;
}

const isJson = (text: string) => { try { JSON.parse(text); return true; } catch { return false; } };
const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

// One result, shrunk for the named tool under `cap` characters. Unchanged when there was nothing to take out.
export function shrinkResult(tool: string, text: string, cap = Infinity): Shrunk {
  const before = text.length;
  const said: string[] = [];
  const body = text.trim();
  // JSON is never folded or cut mid-structure: it fits, or it loses whole entries from the end.
  if (/^[[{]/.test(body) && isJson(body)) {
    if (body.length <= cap) return { text, before, after: before };
    const cut = cutJson(body, cap - 160);
    if (!cut) return { text, before, after: before };
    const shrunk = `${cut.text}\n${MARK} only the first ${plural(cut.of - cut.left, body.startsWith('[') ? 'entry' : 'field', body.startsWith('[') ? 'entries' : 'fields')} of ${cut.of} fit here; ask for the rest by name if you need it.]`;
    return { text: shrunk, before, after: shrunk.length };
  }
  let lines = text.split('\n');
  if (WEB.has(tool)) {
    const chrome = stripChrome(lines, PAGES.has(tool));
    lines = chrome.lines;
    if (chrome.dropped) said.push(`${plural(chrome.dropped, 'menu or banner line')} dropped`);
  }
  const repeats = foldRepeats(lines);
  lines = repeats.lines;
  if (repeats.folded) said.push(`${plural(repeats.folded, 'repeated line')} folded`);
  if (COMMANDS.has(tool)) {
    const ends = headTail(lines);
    lines = ends.lines;
    if (ends.folded) said.push(`the middle ${plural(ends.folded, 'line')} of the output folded, first ${HEAD_LINES} and last ${TAIL_LINES} kept`);
  }
  let out = lines.join('\n');
  if (out.length > cap - 200) {
    const cut = cutAtLine(out, Math.max(0, cap - 200));
    said.push(`cut at a line after ${cut.length.toLocaleString('en-US')} of ${out.length.toLocaleString('en-US')} characters`);
    out = cut;
  }
  if (!said.length) return { text, before, after: before };
  out = `${out}\n${MARK} ${said.join('; ')}. Ask again for a narrower part if what you need was in there.]`;
  // Saying what was folded must not cost more than the folding saved: a small result goes in as it came.
  if (out.length >= before) return { text, before, after: before };
  return { text: out, before, after: out.length };
}

// A quarter of the smallest prompt any model a turn can land on will hold. The side model is left out: it never answers a turn.
export const resultCap = (clients: ModelClient[]) => {
  const sizes = clients.filter((client) => !client.side).map((client) => client.maxPromptChars);
  return sizes.length ? Math.min(...sizes) * SHARE : Infinity;
};

// The `step:before` handler: every tool result that has not been through the door yet goes through it now, once.
// What each tool's results came to before and after is written down for the insights.
export function createShrinking(deps: { clients: ModelClient[]; usage?: Pick<UsageBook, 'shrunk'> }) {
  const seen = new Set<string>();
  return (async (payload, next) => {
    const cap = resultCap(deps.clients);
    const names = new Map<string, string>();
    for (const message of payload.messages) {
      if (message.role === 'assistant' && message.tool_calls) for (const call of message.tool_calls) names.set(call.id, call.function.name);
    }
    let changed = false;
    const messages = payload.messages.map((message): ModelMessage => {
      if (message.role !== 'tool' || seen.has(message.tool_call_id) || message.content.includes(MARK)) return message;
      if (seen.size > 5000) seen.clear();
      seen.add(message.tool_call_id);
      const tool = names.get(message.tool_call_id) ?? '';
      const shrunk = shrinkResult(tool, message.content, cap);
      deps.usage?.shrunk(tool || 'unknown', shrunk.before, shrunk.after);
      if (shrunk.text === message.content) return message;
      changed = true;
      return { ...message, content: shrunk.text };
    });
    return next(changed ? { ...payload, messages } : payload);
  }) satisfies Handler<'step:before'>;
}
