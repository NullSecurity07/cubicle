import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { trashStamp } from './clock.ts';
import { folderCache, freshId, safeId, slugOf, writeAtomic } from './fsx.ts';
import type { Skill, SkillEvent, SkillSource, SkillState, SkillVersion } from '../shared/model.ts';

export type Skills = ReturnType<typeof createSkills>;
// What one change to a skill says: the field, the line it replaces, and what goes there instead.
// An empty `old` adds a line to a list; an empty `new` takes one away.
export type Change = { field: string; old: string; new: string };
export type Fields = Pick<Skill, 'name' | 'when' | 'procedure' | 'pitfalls' | 'verify'>;

// How much a skill may say. Past any of these it is an error and the whole lesson is dropped, never quietly cut:
// a procedure that loses its last step is worse than no procedure at all.
export const CAPS = { name: 60, when: 160, steps: 8, step: 240, pitfalls: 5, pitfall: 240, verify: 240, whole: 1500 };
const HISTORY = 5;
const SAME_WORK = 10 * 60_000;
const FIELDS = ['name', 'when', 'procedure', 'pitfalls', 'verify'] as const;
const safe = (id: string) => safeId(id, 80);
const flat = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

function line(value: unknown, what: string, max: number): string {
  const text = flat(value);
  if (!text) throw new Error(`"${what}" is missing`);
  if (text.length > max) throw new Error(`"${what}" is too long (${text.length} characters, the limit is ${max})`);
  return text;
}
function lines(value: unknown, what: string, most: number, max: number): string[] {
  if (value !== undefined && !Array.isArray(value)) throw new Error(`"${what}" must be a list of lines`);
  const items = ((value ?? []) as unknown[]).map(flat).filter(Boolean);
  if (items.length > most) throw new Error(`"${what}" has ${items.length} lines, and the limit is ${most}`);
  const over = items.find((item) => item.length > max);
  if (over) throw new Error(`a line of "${what}" is too long (${over.length} characters, the limit is ${max})`);
  return items;
}

// The words a skill is made of, checked. This is what the model is asked for and what the founder may edit, so the
// same rules answer both, and the length of the whole is counted before anything is written down.
export function checkFields(input: Record<string, unknown>): Fields {
  const fields: Fields = {
    name: line(input.name, 'name', CAPS.name),
    when: line(input.when, 'when', CAPS.when),
    procedure: lines(input.procedure, 'procedure', CAPS.steps, CAPS.step),
    pitfalls: lines(input.pitfalls, 'pitfalls', CAPS.pitfalls, CAPS.pitfall),
    verify: line(input.verify, 'verify', CAPS.verify),
  };
  if (!fields.procedure.length) throw new Error('"procedure" is missing: say what to do, step by step');
  const size = wordsOf(fields).length;
  if (size > CAPS.whole) throw new Error(`the whole skill is too long (${size} characters, the limit is ${CAPS.whole})`);
  return fields;
}
export const wordsOf = (fields: Fields) => [fields.name, fields.when, ...fields.procedure, ...fields.pitfalls, fields.verify].join('\n');
// What a person reads when they open a skill, and what recall searches.
export const bodyOf = (skill: Skill) => [`${skill.name}. ${skill.when}`, skill.procedure.map((step, at) => `${at + 1}. ${step}`).join('\n'),
  skill.pitfalls.length ? `Watch out for:\n${skill.pitfalls.map((one) => `- ${one}`).join('\n')}` : '', `Done when: ${skill.verify}`].filter(Boolean).join('\n\n');

// A file the founder edited by hand, or one written by an older version of this. Whatever it says, what leaves here is
// a whole skill or nothing: half a skill in a reply is a blank panel, and a lesson nobody can read is worse than none.
// Only the words are required; everything a skill is counted or sorted by has an answer that is true of a new one.
const list_ = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && !!one.trim()) : []);
const number_ = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
function whatIsThere(held: Partial<Skill>, id: string): Skill | null {
  const words = [held.name, held.when, held.verify];
  if (words.some((one) => typeof one !== 'string' || !one.trim()) || !list_(held.procedure).length) return null;
  return {
    id, name: held.name!, when: held.when!, verify: held.verify!, procedure: list_(held.procedure), pitfalls: list_(held.pitfalls),
    state: held.state === 'off' || held.state === 'stale' ? held.state : 'active',
    by: { roomId: typeof held.by?.roomId === 'string' ? held.by.roomId : '', name: held.by?.name?.trim() || 'Somebody' },
    source: { kind: held.source?.kind === 'chat' || held.source?.kind === 'taught' ? held.source.kind : 'run', ref: typeof held.source?.ref === 'string' ? held.source.ref : '' },
    uses: number_(held.uses), patches: number_(held.patches), createdAt: number_(held.createdAt),
    ...(number_(held.usedAt, 0) ? { usedAt: held.usedAt } : {}), ...(held.editedByFounder ? { editedByFounder: true } : {}),
    history: (Array.isArray(held.history) ? held.history : []).filter((one): one is SkillVersion => !!one && typeof one.verify === 'string' && Array.isArray(one.procedure)),
  };
}

// The one playbook every person shares: a file each under `skills/`, written the way the store writes everything.
// Nothing here asks the founder first — a skill is born quietly and they can switch it off, edit it or undo it after.
export function createSkills(dir: string, now: () => number = Date.now) {
  const folder = join(dir, 'skills');
  const path = (id: string) => join(folder, `${safe(id)}.json`);
  const watchers = new Set<(event: SkillEvent) => void>();
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<Skill[]> {
    const names = await readdir(folder).catch(() => [] as string[]);
    const found: Skill[] = [];
    for (const name of names.filter((one) => one.endsWith('.json') && !one.endsWith('.tmp'))) {
      try {
        const whole = whatIsThere(JSON.parse(await readFile(join(folder, name), 'utf8')) as Partial<Skill>, name.slice(0, -5));
        if (whole) found.push(whole);
      } catch { /* not a skill: left alone */ }
    }
    return found.sort((a, b) => b.createdAt - a.createdAt);
  }
  // Every turn's playbook reads the list, so it is read off the disk only when something changed.
  const cache = folderCache(folder, read);
  async function list(): Promise<Skill[]> {
    await queue;
    return cache.get();
  }
  const get = async (id: string) => (await list()).find((one) => one.id === id);
  function save(skill: Skill) {
    const text = JSON.stringify(skill, null, 2);
    const job = queue.then(async () => {
      await writeAtomic(path(skill.id), text, { mkdir: true });
      cache.drop();
    });
    queue = job.catch(() => {});
    // Told before the caller hears back, so a panel and whoever asked for the change never disagree about the playbook.
    return job.then(async () => { await tellAll(); return skill; });
  }
  async function tellAll() { if (watchers.size) { const skills = await list(); for (const tell of watchers) tell({ skills }); } }
  const version = (skill: Skill): SkillVersion => ({ name: skill.name, when: skill.when, procedure: skill.procedure, pitfalls: skill.pitfalls, verify: skill.verify, at: now() });
  const held = async (id: string) => { const skill = await get(id); if (!skill) throw new Error('unknown skill'); return skill; };
  const newId = (name: string) => freshId(folder, slugOf(name, 'skill'), '.json');

  return {
    list,
    get,
    settled: () => queue,
    async create(input: Record<string, unknown> & { by: Skill['by']; source: SkillSource }): Promise<Skill> {
      const fields = checkFields(input);
      return save({ id: await newId(fields.name), ...fields, state: 'active', by: input.by, source: input.source, uses: 0, patches: 0, createdAt: now(), history: [] });
    },
    // What the learner sends back: a field and the line to swap. Anything it cannot find is an error, because a patch
    // that half lands leaves a procedure nobody wrote.
    async patch(id: string, changes: Change[]): Promise<Skill> {
      const skill = await held(id);
      if (!Array.isArray(changes) || !changes.length) throw new Error('a patch needs at least one change');
      const next: Record<string, unknown> = { name: skill.name, when: skill.when, procedure: [...skill.procedure], pitfalls: [...skill.pitfalls], verify: skill.verify };
      for (const change of changes) {
        const field = (FIELDS as readonly string[]).includes(change?.field) ? (change.field as keyof Fields) : null;
        if (!field) throw new Error(`"${change?.field}" is not a field of a skill (${FIELDS.join(', ')})`);
        const old = flat(change.old);
        const fresh = flat(change.new);
        if (field === 'procedure' || field === 'pitfalls') {
          const items = next[field] as string[];
          if (!old) { if (!fresh) throw new Error(`a change to "${field}" says nothing`); items.push(fresh); continue; }
          const at = items.findIndex((item) => item === old || item.toLowerCase().startsWith(old.toLowerCase().slice(0, 40)));
          if (at < 0) throw new Error(`"${old.slice(0, 60)}" is not in "${field}" of this skill`);
          if (fresh) items[at] = fresh; else items.splice(at, 1);
        } else {
          if (!fresh) throw new Error(`"${field}" cannot be emptied`);
          next[field] = fresh;
        }
      }
      return save({ ...skill, ...checkFields(next), patches: skill.patches + 1, history: [...skill.history, version(skill)].slice(-HISTORY) });
    },
    // The founder's own edit: whole fields, and from here on the curator leaves this skill alone.
    async edit(id: string, input: Record<string, unknown>): Promise<Skill> {
      const skill = await held(id);
      const fields = checkFields({ name: skill.name, when: skill.when, procedure: skill.procedure, pitfalls: skill.pitfalls, verify: skill.verify, ...Object.fromEntries(FIELDS.filter((field) => input[field] !== undefined).map((field) => [field, input[field]])) });
      return save({ ...skill, ...fields, editedByFounder: true, history: [...skill.history, version(skill)].slice(-HISTORY) });
    },
    async setState(id: string, state: SkillState): Promise<Skill> {
      if (!['active', 'off', 'stale'].includes(state)) throw new Error('a skill is active, off or stale');
      return save({ ...(await held(id)), state });
    },
    async undo(id: string): Promise<Skill> {
      const skill = await held(id);
      const back = skill.history.at(-1);
      if (!back) throw new Error('this skill has no earlier version to go back to');
      const { at: _at, ...fields } = back;
      return save({ ...skill, ...fields, editedByFounder: true, history: skill.history.slice(0, -1) });
    },
    // The only thing that keeps a skill out of the curator's way. One piece of work is one use: a skill put in front of
    // a person and then opened by them in the same few minutes was used once, not twice.
    async used(id: string): Promise<Skill> {
      const skill = await held(id);
      if (skill.usedAt && now() - skill.usedAt < SAME_WORK) return skill;
      return save({ ...skill, uses: skill.uses + 1, usedAt: now() });
    },
    // Nothing is deleted: the file goes to trash, where everything else the founder let go of is kept.
    async remove(id: string) {
      await queue;
      await mkdir(join(dir, 'trash'), { recursive: true });
      await rename(path(id), join(dir, 'trash', `${trashStamp(now())}-${safe(id)}.json`));
      cache.drop();
      await tellAll();
    },
    watch(tell: (event: SkillEvent) => void) { watchers.add(tell); return () => { watchers.delete(tell); }; },
    tell(event: SkillEvent) { for (const tell of watchers) tell(event); },
  };
}
