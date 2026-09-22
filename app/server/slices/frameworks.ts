import { resolve } from 'node:path';
import type { Case, Framework } from '../../shared/frameworks.ts';
import { FRAMEWORK_ID } from '../../shared/frameworks.ts';
import { copyBuiltIns, createFrameworks } from '../frameworks/store.ts';
import { frameworkFrom, place } from '../frameworks/place.ts';
import type { Slice } from '../install.ts';
import { createLibrary, inUse } from '../library/notes.ts';

// Frameworks: teams the founder does not have to build twice. A framework holds the people, their briefs, the docs
// they share, the cards they need and the wires between them; placing it mints fresh ids and hands the window one
// piece of stage to merge. Saving one goes the other way, from whatever is selected on the canvas.
const ONE = /^\/api\/frameworks\/([a-z0-9][a-z0-9-]{0,79})$/;
const PLACE = /^\/api\/frameworks\/([a-z0-9][a-z0-9-]{0,79})\/place$/;
const MOST_CASE_CHARS = 4000;
const MOST_KEYS = 8;

// What the founder typed into the cases list, made safe to write down: an id that is an id, text that is text, and
// nothing longer than a test case has any business being.
const words = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, MOST_CASE_CHARS) : '');
function tidyCase(held: Record<string, unknown> | undefined, at: number): Case {
  const [expected, rubric] = [words(held?.expected), words(held?.rubric)];
  return {
    id: (words(held?.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)) || `case-${at + 1}`,
    keys: Array.isArray(held?.keys) ? [...new Set(held.keys.map(String).filter(Boolean))].slice(0, MOST_KEYS) : [],
    input: words(held?.input),
    ...(expected ? { expected } : {}), ...(rubric ? { rubric } : {}),
    addedBy: held?.addedBy === 'forge' ? 'forge' : 'founder',
  };
}

export default {
  name: 'frameworks',
  async install(deps) {
    const frameworks = createFrameworks(deps.workspace);
    const library = createLibrary(deps.workspace);

    // The library has to be able to ask, in the middle of a delete, whether a framework is holding a note — and it
    // cannot wait for a file to be read. So who holds what is kept here and read again after every change.
    let holders = new Map<string, string>();
    const refresh = async () => { holders = await frameworks.holders().catch(() => holders); };
    inUse.by = (id) => holders.get(id) ?? null;

    // The built-ins ship in the repository and are copied in the first time this workspace starts without them,
    // with the founder's notes they were built from. A workspace that already has them is left exactly as it is.
    await copyBuiltIns(resolve(deps.root, 'app/frameworks'), frameworks, library)
      // A framework that will not copy is one feature missing, never a server that will not start.
      .catch((error: Error) => console.error(`frameworks: the built-ins could not be copied: ${error.message}`));
    await refresh();

    // Everything the founder selected, written down as a team: the docs carry the words they say right now, and a
    // note card in the selection is what tells the framework which of the founder's notes it was built from.
    async function fromSelection(id: string, asked: Record<string, unknown>): Promise<Framework> {
      const stage = await deps.store.loadStage();
      const ids = (asked.ids as unknown[]).map(String);
      const texts: Record<string, string> = {};
      for (const doc of stage.docs) if (ids.includes(doc.id)) texts[doc.id] = await deps.store.readDoc(doc.id);
      const hashes = new Map((await library.list()).map((note) => [note.id, note.hash]));
      const built = frameworkFrom({
        stage, ids, name: String(asked.name ?? ''), intent: asked.intent === undefined ? undefined : String(asked.intent),
        texts, hashOf: (note) => hashes.get(note), was: await frameworks.read(id).catch(() => null),
      });
      // The path is the address: a framework saved again under a name the founder has since changed stays where it
      // was, rather than quietly becoming a second one.
      return { ...built, id };
    }

    return {
      async route(req, res, path) {
        if (!path.startsWith('/api/frameworks')) return false;
        const method = req.method ?? 'GET';
        if (path === '/api/frameworks' && method === 'GET') { deps.json(res, 200, await frameworks.list()); return true; }

        const placing = PLACE.exec(path)?.[1];
        if (placing && method === 'POST') {
          const framework = await frameworks.read(placing);
          if (!framework) { deps.json(res, 404, { error: 'there is no framework by that name' }); return true; }
          const asked = await deps.body(req);
          const at = asked?.at ?? {};
          const stage = await deps.store.loadStage();
          const { placed, texts } = place(framework, stage, { x: Number(at.x) || 0, y: Number(at.y) || 0 });
          // The docs' words are written before the stage knows about them, so the cards have something to open the
          // moment they land. The window merges what comes back and saves the stage itself, as it does for a card.
          for (const [id, text] of Object.entries(texts)) await deps.store.writeDoc(id, text);
          deps.json(res, 200, placed);
          return true;
        }

        const id = ONE.exec(path)?.[1];
        if (!id) return false;
        if (method === 'GET') {
          const framework = await frameworks.read(id).catch(() => null);
          if (framework) deps.json(res, 200, framework);
          else deps.json(res, 404, { error: 'there is no framework by that name' });
          return true;
        }
        if (method === 'PUT') {
          const asked = (await deps.body(req)) ?? {};
          try {
            if (!FRAMEWORK_ID.test(id)) throw new Error(`bad id: ${id}`);
            // Two ways in, and the body says which: a selection on the canvas to write down, or a whole framework
            // handed back with something changed in it (the founder editing its test cases).
            const framework = Array.isArray(asked.ids) ? await fromSelection(id, asked) : {
              ...(asked as Framework), id,
              dataset: (Array.isArray(asked.dataset) ? asked.dataset : []).map(tidyCase),
            };
            if (!String(framework.name ?? '').trim()) throw new Error('A framework needs a name.');
            deps.json(res, 200, await frameworks.save(framework));
            await refresh();
          } catch (error) { deps.json(res, 400, { error: (error as Error).message }); }
          return true;
        }
        if (method === 'DELETE') {
          await frameworks.remove(id);
          await refresh();
          deps.json(res, 200, { ok: true });
          return true;
        }
        return false;
      },
      // The library knows of nobody again: another workspace opened in this process must not inherit this one's hold
      // on a note.
      close: async () => { inUse.by = () => null; },
    };
  },
} satisfies Slice;
