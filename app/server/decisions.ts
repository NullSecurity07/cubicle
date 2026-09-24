import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attention, Decision } from '../shared/model.ts';
import { localDay, shortDay, trashStamp } from './clock.ts';
import { folderCache, freshId, safeId, slugOf, writeAtomic } from './fsx.ts';

export type Decisions = ReturnType<typeof createDecisions>;
const safe = (id: string) => safeId(id, 100);
const dayOf = localDay;
const isDay = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(`${text}T00:00:00`).getTime());
const SECTIONS = ['Context', 'Options', 'Chosen', 'Why', 'Expected effect', 'Review date'] as const;

// The file is what the founder would write by hand: a title, a few facts on top, six sections. Empty sections stay,
// so a proposal shows at a glance what is still to be decided.
export function writeDecision(decision: Decision): string {
  const facts = [`status: ${decision.status}`, decision.proposedBy ? `proposed by: ${decision.proposedBy}` : '', `at: ${new Date(decision.at).toISOString()}`, decision.decidedAt ? `decided: ${new Date(decision.decidedAt).toISOString()}` : ''].filter(Boolean);
  const options = [...decision.options.map((option, index) => `${index + 1}. ${option}`), ...(decision.recommendation ? ['', `Recommended: ${decision.recommendation}`] : [])].join('\n');
  const body: Record<(typeof SECTIONS)[number], string> = { Context: decision.context, Options: options, Chosen: decision.chosen ?? '', Why: decision.why ?? '', 'Expected effect': decision.effect ?? '', 'Review date': decision.review ?? '' };
  return `# ${decision.title}\n\n${facts.map((fact) => `- ${fact}`).join('\n')}\n\n${SECTIONS.map((name) => `## ${name}\n\n${body[name].trim()}`.trimEnd()).join('\n\n')}\n`;
}

export function parseDecision(id: string, file: string): Decision {
  const title = /^# (.+)$/m.exec(file)?.[1]?.trim();
  const fact = (name: string) => new RegExp(`^- ${name}: (.+)$`, 'm').exec(file)?.[1]?.trim();
  const status = fact('status');
  if (!title || (status !== 'proposed' && status !== 'decided')) throw new Error(`${id} is not a decision file`);
  const section = (name: string) => new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(file)?.[1]?.trim() ?? '';
  const listed = section('Options').split('\n');
  const recommendation = listed.find((line) => line.startsWith('Recommended: '))?.slice('Recommended: '.length).trim();
  const time = (text?: string) => { const at = text ? new Date(text).getTime() : NaN; return Number.isNaN(at) ? undefined : at; };
  const review = section('Review date');
  const optional = { proposedBy: fact('proposed by'), decidedAt: time(fact('decided')), recommendation, chosen: section('Chosen'), why: section('Why'), effect: section('Expected effect'), review: isDay(review) ? review : '' };
  return {
    id, title, status, at: time(fact('at')) ?? 0, context: section('Context'),
    options: listed.flatMap((line) => { const option = /^\d+\.\s+(.+)$/.exec(line.trim())?.[1]; return option ? [option] : []; }),
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined && value !== '')),
  };
}

const words = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// The decided ones as every person reads them in their instructions. Each line carries the day it was decided:
// "newest first" with nothing to date it is how a decision made in the spring gets worked from as if it were this
// morning's. Newest first is the order `list` already puts them in.
export const decidedLines = (all: Decision[], many = 12): string[] => all.filter((one) => one.status === 'decided').slice(0, many)
  .map((one) => `- ${shortDay(one.decidedAt ?? one.at)} — ${one.title}: ${(one.chosen ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);

// The founder's decisions, one markdown file each in `decisions/`. People may add proposals; deciding, recording and
// removing are the founder's and go through the api only.
export function createDecisions(dir: string, now: () => number = Date.now) {
  const folder = join(dir, 'decisions');
  const listeners = new Set<() => void>();
  const path = (id: string) => join(folder, `${safe(id)}.md`);

  async function read(): Promise<Decision[]> {
    const names = await readdir(folder).catch(() => [] as string[]);
    const found: Decision[] = [];
    for (const name of names.filter((one) => one.endsWith('.md'))) {
      try { found.push(parseDecision(name.slice(0, -3), await readFile(join(folder, name), 'utf8'))); } catch { /* not a decision: left alone */ }
    }
    return found.sort((a, b) => (b.decidedAt ?? b.at) - (a.decidedAt ?? a.at) || b.id.localeCompare(a.id));
  }
  // Every person's prompt reads the decisions, so they are read off the disk only when something changed.
  const cache = folderCache(folder, read);
  const list = () => cache.get();
  async function save(decision: Decision) {
    await writeAtomic(path(decision.id), writeDecision(decision), { mkdir: true });
    cache.drop();
    for (const tell of listeners) tell();
    return decision;
  }
  const newId = (title: string) => freshId(folder, `${dayOf(now())}-${slugOf(title, 'decision')}`, '.md');
  const checked = (input: Record<string, unknown>) => {
    const title = words(input.title, 160);
    if (!title) throw new Error('a decision needs a title');
    const options = (Array.isArray(input.options) ? input.options : []).map((option) => words(option, 300).replace(/\n+/g, ' ')).filter(Boolean).slice(0, 9);
    return { title: title.replace(/\n+/g, ' '), context: words(input.context, 4000), options };
  };
  const verdict = (input: Record<string, unknown>) => {
    const chosen = words(input.chosen, 600);
    const review = words(input.review, 20);
    if (!chosen) throw new Error('"chosen" is missing: say what was decided');
    if (review && !isDay(review)) throw new Error('the review date must be a date like 2026-10-31');
    return { chosen, why: words(input.why, 4000), effect: words(input.effect, 2000), review };
  };
  const tidy = (decision: Decision): Decision => Object.fromEntries(Object.entries(decision).filter(([key, value]) => key === 'context' || (value !== '' && value !== undefined))) as Decision;

  return {
    list,
    onChange(tell: () => void) { listeners.add(tell); return () => { listeners.delete(tell); }; },
    async propose(input: Record<string, unknown>): Promise<Decision> {
      const base = checked(input);
      if (base.options.length < 2) throw new Error('a proposal needs at least two options for the founder to choose between');
      return save(tidy({ id: await newId(base.title), status: 'proposed', at: now(), proposedBy: words(input.proposedBy, 80), ...base, recommendation: words(input.recommendation, 600) }));
    },
    async record(input: Record<string, unknown>): Promise<Decision> {
      const base = checked(input);
      return save(tidy({ id: await newId(base.title), status: 'decided', at: now(), decidedAt: now(), ...base, ...verdict(input) }));
    },
    async decide(id: string, input: Record<string, unknown>): Promise<Decision> {
      const held = (await list()).find((one) => one.id === id);
      if (!held) throw new Error('unknown decision');
      return save(tidy({ ...held, status: 'decided', decidedAt: held.decidedAt ?? now(), ...verdict(input) }));
    },
    async remove(id: string) {
      await mkdir(join(dir, 'trash'), { recursive: true });
      await rename(path(id), join(dir, 'trash', `${trashStamp(now())}-${id}.md`));
      cache.drop();
      for (const tell of listeners) tell();
    },
  };
}

// What the log holds for the founder: proposals to decide, and decisions whose review date has come.
export const decisionAttention = (decisions: Decisions, now: () => number = Date.now) => async (): Promise<Attention[]> => (await decisions.list()).flatMap((decision): Attention[] => {
  if (decision.status === 'proposed') return [{ id: `proposed-decision:${decision.id}`, kind: 'proposed-decision', title: decision.title, detail: decision.context.slice(0, 240) || undefined, at: decision.at, who: decision.proposedBy, decisionId: decision.id }];
  if (decision.review && decision.review <= dayOf(now())) return [{ id: `review-due:${decision.id}:${decision.review}`, kind: 'review-due', title: decision.title, detail: `Decided: ${decision.chosen ?? ''}. You asked to look at this again on ${decision.review}.`, at: new Date(`${decision.review}T00:00:00`).getTime(), decisionId: decision.id }];
  return [];
});
