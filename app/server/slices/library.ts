import type { Card } from '../../shared/model.ts';
import type { Slice } from '../install.ts';
import { noteOf, notesBlock, NOTE_FLOOR, TOP_CHUNKS } from '../library/notes.ts';
import { wired } from '../prompt.ts';
import type { Handler } from '../seams.ts';
import { sharedLibrary } from '../slice-kit.ts';

// The founder's library: the notes they learn from, kept as files, and the passages of them a person is given when
// one is wired to their room. A note is never pasted whole — what goes into a turn is the two or three passages that
// answer the question in front of that person, so the founder's own documents keep their room in the prompt.
const NOTE_ID = /^\/api\/library\/([a-z0-9][a-z0-9-]{0,79})$/;

export default {
  name: 'library',
  install(deps) {
    // The workspace's one library and recall, shared with the evals, the forge and the frameworks, and warmed once.
    const { library, recall } = sharedLibrary(deps);

    // Every note wired to this person, each asked what it has to say about the question, best passages first.
    const before: Handler<'turn:before'> = async (payload, next) => {
      const [system, ...rest] = payload.messages;
      if (system?.role !== 'system' || !payload.query.trim()) return next(payload);
      const stage = await deps.store.loadStage().catch(() => null);
      if (!stage) return next(payload);
      const cards = (stage.cards ?? []).filter((card): card is Card & { kind: 'library' } => card.kind === 'library');
      const mine = new Set(wired(stage, payload.roomId, cards.map((card) => card.id)));
      const ids = [...new Set(cards.filter((card) => mine.has(card.id)).map((card) => card.noteId).filter(Boolean))];
      if (!ids.length) return next(payload);
      const titles = new Map((await library.list()).map((note) => [note.id, note.title]));
      const found: { title: string; chunks: string[] }[] = [];
      for (const id of ids) {
        const title = titles.get(id);
        if (!title) continue;
        const hits = (await recall.search(payload.query, { allow: (piece) => noteOf(piece.id) === id, top: TOP_CHUNKS })).filter((hit) => hit.score >= NOTE_FLOOR);
        if (hits.length) found.push({ title, chunks: hits.map((hit) => hit.text) });
      }
      const block = notesBlock(found);
      if (!block) return next(payload);
      return next({ ...payload, messages: [{ ...system, content: `${system.content}\n\n${block}` }, ...rest] });
    };
    // A check script hands round stub deps with no seams in them; the routes still work, and half a feature is
    // better than a slice that refuses to install.
    if (deps.seams) deps.seams.on('turn:before', before);

    return {
      async route(req, res, path) {
        if (!path.startsWith('/api/library')) return false;
        const method = req.method ?? 'GET';
        if (path === '/api/library' && method === 'GET') { deps.json(res, 200, await library.list()); return true; }
        if (path === '/api/library' && method === 'POST') {
          const asked = await deps.body(req);
          try {
            const note = await library.add({
              title: String(asked?.title ?? ''), text: String(asked?.text ?? ''),
              tags: Array.isArray(asked?.tags) ? asked.tags.map(String) : [], source: asked?.source === 'file' ? 'file' : 'paste',
            });
            deps.json(res, 200, note);
          } catch (error) { deps.json(res, 400, { error: (error as Error).message }); }
          return true;
        }
        // Before the id below, which a search would otherwise look like.
        if (path === '/api/library/search' && method === 'GET') {
          const asked = new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? '';
          // The founder is looking for a note, not a passage: the id that goes back is the note's, so pressing the
          // answer opens it.
          const hits = (await recall.search(asked, { top: 5 })).map((hit) => ({ ...hit, id: noteOf(hit.id) }));
          deps.json(res, 200, { hits, mode: recall.mode() });
          return true;
        }
        const id = NOTE_ID.exec(path)?.[1];
        if (id && method === 'GET') {
          const [note, text] = [(await library.list()).find((held) => held.id === id), await library.read(id)];
          if (!note || text === null) deps.json(res, 404, { error: 'that note is not in the library' });
          else deps.json(res, 200, { ...note, text });
          return true;
        }
        if (id && method === 'DELETE') {
          try { await library.remove(id); deps.json(res, 200, { ok: true }); }
          // Not a 400: nothing about the request is wrong, something else is holding on to the note.
          catch (error) { deps.json(res, 409, { error: (error as Error).message }); }
          return true;
        }
        return false;
      },
    };
  },
} satisfies Slice;
