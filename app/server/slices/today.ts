import type { Slice } from '../install.ts';
import { todayFive, wave } from '../today/rank.ts';

// Today's five as a route: GET gives the five, POST /dismiss waves one away until tomorrow. The ranking lives in
// `../today/rank.ts` so the phone's daily note reads exactly the same five.
export default {
  name: 'today',
  install(deps) {
    return {
      async route(req, res, path) {
        if (path === '/api/today' && req.method === 'GET') { deps.json(res, 200, { at: Date.now(), items: await todayFive(deps) }); return true; }
        if (path === '/api/today/dismiss' && req.method === 'POST') {
          const id = String((await deps.body(req))?.id ?? '').trim();
          if (!id || id.length > 400) { deps.json(res, 400, { error: 'say which one' }); return true; }
          await wave(deps.workspace, id, Date.now());
          deps.json(res, 200, { at: Date.now(), items: await todayFive(deps) });
          return true;
        }
        return false;
      },
    };
  },
} satisfies Slice;
