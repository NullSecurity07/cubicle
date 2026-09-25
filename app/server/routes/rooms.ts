import type { Attachment, ChatVia } from '../../shared/model.ts';
import type { createChat } from '../chat.ts';
import { answer, body, typeOf, type Route } from '../http.ts';
import type { createMemory } from '../memory.ts';
import type { ModelClient } from '../providers.ts';
import type { Store } from '../store.ts';
import type { UsageBook } from '../usage.ts';

// The documents, the models, and each person: their memory, their conversation, and a message to them.
export function roomRoutes(deps: { store: Store; busy: Set<string>; usage: UsageBook; clients: ModelClient[]; memory: Pick<ReturnType<typeof createMemory>, 'read' | 'write'>; chat: ReturnType<typeof createChat>['chat'] }): Route {
  const { store, busy, usage, clients, memory, chat } = deps;
  return async (req, res, path) => {
    const doc = /^\/api\/docs\/([^/]+)$/.exec(path)?.[1];
    const room = /^\/api\/rooms\/([^/]+)\/chat$/.exec(path)?.[1];
    if (doc && req.method === 'GET') return answer(res, 200, { text: await store.readDoc(doc) });
    if (doc && req.method === 'PUT') { await store.writeDoc(doc, String((await body(req)).text ?? '')); return answer(res, 200, { ok: true }); }
    if (path === '/api/models' && req.method === 'GET') return answer(res, 200, usage.info(clients));
    const cut = /^\/api\/rooms\/([^/]+)\/chat\/([\w-]{1,80})$/.exec(path);
    if (cut && req.method === 'DELETE') {
      if (busy.has(cut[1])) return answer(res, 409, { error: 'this person is still replying' });
      return answer(res, 200, await store.cutChat(cut[1], cut[2], false));
    }
    const remembered = /^\/api\/rooms\/([^/]+)\/memory$/.exec(path)?.[1];
    if (remembered && req.method === 'GET') { const { notes, summary } = await memory.read(remembered); return answer(res, 200, { notes, summary }); }
    if (remembered && req.method === 'PUT') { await memory.write(remembered, await body(req)); return answer(res, 200, { ok: true }); }
    if (room && req.method === 'GET') return answer(res, 200, await store.readChat(room));
    if (room && req.method === 'POST') {
      const sent = await body(req);
      const text = String(sent.text ?? '').trim();
      const attachments: Attachment[] = [];
      for (const file of Array.isArray(sent.attachments) ? sent.attachments.slice(0, 5) : []) {
        const bytes = typeof file?.path === 'string' && file.path.startsWith('uploads/') ? await store.readFileBytes(file.path) : null;
        if (bytes) attachments.push({ path: file.path, type: typeOf(file.path), size: bytes.length });
      }
      if (!text && !attachments.length) return answer(res, 400, { error: 'empty message' });
      // Where the founder was standing. Only what this app knows how to say back is kept; anything else is nobody.
      const via: ChatVia | undefined = sent.via === 'phone' || sent.via === 'call' ? sent.via : undefined;
      await chat(room, text || 'See the attached file.', res, { replace: typeof sent.replace === 'string' ? sent.replace : undefined, attachments, via });
      return true;
    }
    return false;
  };
}
