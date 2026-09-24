import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Skill } from '../../shared/model.ts';
import type { Slice } from '../install.ts';
import { checkFields, type Skills } from '../skills.ts';

// The skills that ship with the app: a playbook the founder's people can open on day one instead of learning every
// craft from scratch. Each is a file in `app/skills/<id>.json` holding only the words — name, when, procedure,
// pitfalls, verify — and is copied into the workspace's playbook the first time it starts without it. From then on it
// is an ordinary skill: the founder may edit it, switch it off or delete it, and the curator ages it like any other.

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const BUILT_IN_BY = { roomId: '', name: 'Built in' };
export const BUILT_IN_SOURCE = { kind: 'taught' as const, ref: 'builtin' };

// A file the founder let go of sits in trash as `<when>-<id>.json`. A built-in the founder deleted stays deleted: it is
// not handed back on the next start as if nothing had happened.
const trashed = (names: string[], id: string) => names.some((name) => name.endsWith(`-${id}.json`) && /^\d{4}-\d\d-\d\dT[\d-]+Z-/.test(name));

// Copies every built-in the workspace does not hold yet and gives back the ids it copied. A workspace that already has
// a skill under that id keeps its own, whatever it says — the founder's edits, the uses it has counted. A built-in
// that fails the playbook's own checks is named and skipped, never cut to fit.
export async function copyBuiltInSkills(from: string, workspace: string, skills: Pick<Skills, 'settled'>, now: () => number = Date.now,
  say: (line: string) => void = (line) => console.error(line)): Promise<string[]> {
  const files = (await readdir(from).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort();
  if (!files.length) return [];
  await skills.settled();
  const folder = join(workspace, 'skills');
  const held = new Set(await readdir(folder).catch(() => [] as string[]));
  const gone = await readdir(join(workspace, 'trash')).catch(() => [] as string[]);
  const copied: string[] = [];
  for (const file of files) {
    const id = file.slice(0, -'.json'.length);
    if (!ID.test(id) || held.has(file) || trashed(gone, id)) continue;
    let fields;
    try { fields = checkFields(JSON.parse(await readFile(join(from, file), 'utf8')) as Record<string, unknown>); }
    catch (error) { say(`skills: the built-in "${id}" was not copied: ${(error as Error).message}`); continue; }
    const skill: Skill = { id, ...fields, state: 'active', by: BUILT_IN_BY, source: BUILT_IN_SOURCE, uses: 0, patches: 0, createdAt: now(), history: [] };
    // Written the way the playbook writes: whole, or not at all.
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${id}.json.tmp`), JSON.stringify(skill, null, 2));
    await rename(join(folder, `${id}.json.tmp`), join(folder, file));
    copied.push(id);
  }
  return copied;
}

export default {
  name: 'skills-builtin',
  async install(deps) {
    const copied = await copyBuiltInSkills(resolve(deps.root, 'app/skills'), deps.workspace, deps.skills)
      // A skill that will not copy is one lesson missing, never a server that will not start.
      .catch((error: Error) => { console.error(`skills: the built-ins could not be copied: ${error.message}`); return [] as string[]; });
    // Anybody already watching the playbook hears about what arrived, the way they hear about anything learned.
    if (copied.length) deps.skills.tell({ skills: await deps.skills.list() });
    return {};
  },
} satisfies Slice;
