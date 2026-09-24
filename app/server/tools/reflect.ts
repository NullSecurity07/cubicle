import type { Decision, Hit } from '../../shared/model.ts';
import { shortDay } from '../clock.ts';
import type { Decisions } from '../decisions.ts';
import type { createMemory } from '../memory.ts';
import { mayRecall, type createRecall } from '../recall.ts';
import { text, type Tool } from './registry.ts';

// Reflect: what is known about one thing, laid out in the order it became known, so a price that went from 15 to 19
// reads as a change rather than as two answers. No model is asked: this is recall, the person's own notes and the
// founder's decisions, sorted by day.

export type Entry = { at?: number; where: string; text: string };

const CAP = 2500;
const LINE = 240;
const WHERE: Record<Hit['kind'], string> = { doc: 'Doc', chat: 'Conversation', memory: 'Your memory', decision: 'Decision', file: 'Shared file', link: 'Web page', skill: 'Playbook skill', library: "The founder's notes" };
const SMALL = new Set('the a an and or but of to in on at for with by from as is are was were be been it its this that these those we you they he she i our your their my me us them has have had do does did will would can could should not no so if then than there here what which who when where how about into over just also very really know known change changed changes time times over did does'.split(' '));
const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)/i;
// A word cut back to its stem, so "prices" and "price" are one subject.
const stem = (word: string) => (word.length > 4 ? word.replace(/(?:ing|s)$/, '') : word);
export const keywordsOf = (text: string) => [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 2 && !SMALL.has(word) && !/^\d+$/.test(word)).map(stem))];
const holds = (line: string, keys: string[]) => { const mine = new Set(keywordsOf(line)); return keys.some((key) => mine.has(key)); };
const clip = (line: string) => { const flat = line.replace(/\s+/g, ' ').trim(); return flat.length > LINE ? `${flat.slice(0, LINE - 1)}…` : flat; };

// The parts of a long passage that are about this, rather than the whole passage.
export function relevant(passage: string, keys: string[]): string[] {
  const parts = passage.split(/\n+|(?<=[.!?])\s+/).map((one) => one.trim()).filter(Boolean);
  return parts.filter((one) => holds(one, keys)).slice(0, 3).map(clip);
}

// A memory line: "- 24 Sep 2026 · the price is 19". Its day is in the line; a line written by the founder by hand may have none.
export function memoryEntries(notes: string, keys: string[]): Entry[] {
  return notes.split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim()).filter((line) => line && holds(line, keys)).map((line) => {
    const dated = /^(\d{1,2} \p{L}{3,9} \d{4}) · (.*)$/u.exec(line);
    const at = dated ? Date.parse(dated[1]) : NaN;
    return Number.isNaN(at) ? { where: WHERE.memory, text: clip(line) } : { at, where: WHERE.memory, text: clip(dated![2]) };
  });
}

export const decisionEntry = (decision: Decision): Entry => ({
  at: decision.decidedAt ?? decision.at, where: WHERE.decision,
  text: clip(decision.status === 'decided' ? `${decision.title}: ${decision.chosen ?? ''}` : `${decision.title} (proposed, not decided yet)`),
});

// A figure said near one of the subject's words: "price set to 15", "price raised to 19". A year or a day of a month
// is not a figure about the subject.
export function figureOf(line: string, key: string): string | undefined {
  const tokens = line.toLowerCase().match(/[\p{L}]+|\d+(?:[.,]\d+)?%?/gu) ?? [];
  const at = tokens.findIndex((token) => stem(token) === key);
  if (at < 0) return undefined;
  for (let next = at + 1; next < Math.min(tokens.length, at + 7); next += 1) {
    const token = tokens[next];
    if (!/^\d/.test(token)) continue;
    if (/^(19|20)\d{2}$/.test(token) || MONTHS.test(tokens[next + 1] ?? '')) continue;
    return token;
  }
  return undefined;
}

// "Changed over time: 15 (12 Aug) → 19 (3 Sep). The latest is 19." for each subject whose figure moved, oldest first.
export function changesOf(entries: Entry[], keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const steps: { figure: string; at: number }[] = [];
    for (const entry of entries) {
      if (entry.at === undefined) continue;
      const figure = figureOf(entry.text, key);
      if (figure && steps.at(-1)?.figure !== figure) steps.push({ figure, at: entry.at });
    }
    if (new Set(steps.map((one) => one.figure)).size < 2) continue;
    out.push(`Changed over time: ${steps.map((one) => `${one.figure} (${shortDay(one.at)})`).join(' → ')}. The latest is ${steps.at(-1)!.figure}.`);
    if (out.length >= 2) break;
  }
  return out;
}

// The whole answer, oldest first, the undated at the end, then what changed, all inside the cap.
export function timeline(entries: Entry[], keys: string[]): string {
  const seen = new Set<string>();
  const once = entries.filter((entry) => { const key = `${entry.where}|${entry.text}`; if (seen.has(key)) return false; seen.add(key); return true; });
  const dated = once.filter((entry) => entry.at !== undefined).sort((a, b) => a.at! - b.at!);
  const undated = once.filter((entry) => entry.at === undefined);
  const changes = changesOf(dated, keys);
  const tail = changes.length ? `\n\n${changes.join('\n')}` : '';
  const lines = [...dated.map((entry) => `[${shortDay(entry.at!)} · ${entry.where}] ${entry.text}`), ...(undated.length ? ['', 'Undated:', ...undated.map((entry) => `[${entry.where}] ${entry.text}`)] : [])];
  let body = '';
  for (const line of lines) {
    if (body.length + line.length + 1 + tail.length > CAP) { body += '\n…and more; ask about something narrower.'; break; }
    body += `${body ? '\n' : ''}${line}`;
  }
  return `${body}${tail}`.trim();
}

export function reflectTools(deps: { recall: ReturnType<typeof createRecall>; decisions: Decisions; memory: Pick<ReturnType<typeof createMemory>, 'read'> }): Tool[] {
  return [{
    name: 'reflect',
    perTurn: 2,
    description: 'Show what is known about one thing, oldest first, and how it changed over time. Use it before you state a price, a plan or a name that may have moved since. Give the thing in a few words.',
    parameters: { type: 'object', properties: { about: { type: 'string', description: 'The thing, in a few words: "our price", "the launch date"' } }, required: ['about'] },
    async run(args, context) {
      const about = text(args, 'about', 300);
      const keys = keywordsOf(about);
      const may = mayRecall(context.stage, context.roomId);
      // This room's memory is read line by line below, and each decision once from the book, so recall brings the rest.
      const hits = await deps.recall.search(about, { top: 10, allow: (piece) => may(piece) && piece.kind !== 'memory' && piece.kind !== 'decision' });
      // A passage found by meaning alone, with none of the thing's words in it, is about something else: a timeline
      // is only worth reading when every line in it is about the same thing.
      const entries: Entry[] = hits.flatMap((hit) => {
        const parts = keys.length ? relevant(hit.text, keys) : [clip(hit.text)];
        return parts.map((part) => ({ at: hit.at, where: hit.kind === 'doc' || hit.kind === 'file' || hit.kind === 'link' ? `${WHERE[hit.kind]}: ${hit.title}` : WHERE[hit.kind], text: part }));
      });
      const notes = (await deps.memory.read(context.roomId).catch(() => ({ notes: '' }))).notes;
      entries.push(...memoryEntries(notes, keys));
      const decided = (await deps.decisions.list().catch(() => [] as Decision[])).filter((one) => holds(`${one.title} ${one.chosen ?? ''} ${one.context}`, keys));
      entries.push(...decided.slice(0, 8).map(decisionEntry));
      if (!entries.length) return { text: 'Nothing written down about that. Ask the founder rather than guess.' };
      return { text: timeline(entries, keys) };
    },
  }];
}
