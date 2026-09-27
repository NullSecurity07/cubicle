import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// What each message the bot sent belongs to, so that replying to it answers the person who wrote it.
export type Route = { messageId: number; chatId: number; roomId: string };
// `morning` is the day the partner's morning note last went to the phone.
export type Kept = { routes: Route[]; told: string[]; digestAt: number; menu: string; morning?: string };
export type Book = ReturnType<typeof createBook>;

const EMPTY: Kept = { routes: [], told: [], digestAt: 0, menu: '' };
// A few hundred of each is a week of talking, and small enough that the file is nothing to write.
const ROUTES = 400;
const TOLD = 500;
const SOON = 400;

// The slice's own memory, next to its settings but apart from them: none of this is the founder's to change, and all
// of it has to survive a restart — an update already sent must not arrive again, and a reply on the phone from before
// lunch must still know whose it was. Written a moment after the last change rather than on every one, because a
// busy afternoon changes it with every message.
export function createBook(dir: string) {
  const path = join(dir, 'reach-state.json');
  let kept: Kept | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function read(): Promise<Kept> {
    if (kept) return kept;
    let saved: Partial<Kept> = {};
    try { saved = JSON.parse(await readFile(path, 'utf8')); } catch { /* nothing has been said yet */ }
    kept = { ...EMPTY, ...saved, routes: saved.routes ?? [], told: saved.told ?? [] };
    return kept;
  }
  function write() {
    const text = JSON.stringify(kept, null, 2);
    queue = queue.then(async () => { await mkdir(dir, { recursive: true }); await writeFile(`${path}.tmp`, text); await rename(`${path}.tmp`, path); }).catch(() => {});
    return queue;
  }
  function soon() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; void write(); }, SOON);
    timer.unref?.();
  }

  return {
    read,
    async settled() { if (timer) { clearTimeout(timer); timer = null; await write(); } await queue; },
    async remember(route: Route) {
      const held = await read();
      held.routes = [...held.routes, route].slice(-ROUTES);
      soon();
    },
    async routeOf(chatId: number, messageId: number): Promise<string | undefined> {
      return (await read()).routes.findLast((one) => one.chatId === chatId && one.messageId === messageId)?.roomId;
    },
    told: async (key: string) => (await read()).told.includes(key),
    async mark(key: string) {
      const held = await read();
      if (held.told.includes(key)) return;
      held.told = [...held.told, key].slice(-TOLD);
      soon();
    },
    // Whether this is new, and marking it told in the same breath: an update is sent once, whatever restarts.
    async fresh(key: string): Promise<boolean> {
      const held = await read();
      if (held.told.includes(key)) return false;
      held.told = [...held.told, key].slice(-TOLD);
      soon();
      return true;
    },
    async forget(key: string) {
      const held = await read();
      if (!held.told.includes(key)) return;
      held.told = held.told.filter((one) => one !== key);
      soon();
    },
    async set(change: (held: Kept) => void) { change(await read()); soon(); },
  };
}
