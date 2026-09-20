import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { UPDATES, type ReachChat, type ReachGroup, type ReachHook, type ReachPairing, type ReachUpdates } from '../../shared/reach.ts';

// A hook's secret lives here beside the bot token, because verifying a signature needs the secret itself. Nothing
// in this file is ever answered to a GET.
export type Kept = {
  on: boolean; token?: string; voice: boolean; cloudSpeech: boolean; paired: ReachChat[]; hooks: (ReachHook & { secret: string })[];
  updates: ReachUpdates; group?: ReachGroup;
};
export type Reach = ReturnType<typeof createReach>;

const EMPTY: Kept = { on: false, voice: false, cloudSpeech: false, paired: [], hooks: [], updates: UPDATES };
// No O, 0, I or 1: the founder reads this off one screen and types it on a phone.
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HOUR = 3_600_000;
export const TRIES = 5;

export const newCode = (random = randomBytes) => [...random(8)].map((byte) => LETTERS[byte % LETTERS.length]).join('');

// `reach.json`: the founder's switch, the bot token they pasted in, who is paired, and the hooks they made. The file
// is written for this user alone (0600), because everything in it is a key to something.
export function createReach(dir: string, env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now) {
  const path = join(dir, 'reach.json');
  let kept: Kept | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  // The pairing code is never written down: it lives for an hour, on the screen that is showing it.
  let pairing: ReachPairing | null = null;

  async function read(): Promise<Kept> {
    if (kept) return kept;
    let saved: Partial<Kept> = {};
    try { saved = JSON.parse(await readFile(path, 'utf8')); } catch { /* nothing set up yet */ }
    // A file written before a switch existed is missing it, and a missing switch means the founder never said no.
    kept = { ...EMPTY, ...saved, paired: saved.paired ?? [], hooks: saved.hooks ?? [], updates: { ...UPDATES, ...saved.updates } };
    return kept;
  }
  async function save(change: (held: Kept) => void): Promise<Kept> {
    const held = await read();
    change(held);
    const text = JSON.stringify(held, null, 2);
    queue = queue.then(async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(`${path}.tmp`, text, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      // The rename keeps the temporary file's mode, but a file written before this app ever cared may be wider.
      await chmod(path, 0o600).catch(() => {});
    }).catch(() => {});
    return held;
  }

  async function speaks(chatId: number): Promise<boolean> {
    const held = await read();
    return held.group?.chatId === chatId ? !!held.group.speak : !!held.paired.find((one) => one.chatId === chatId)?.speak;
  }

  return {
    read,
    save,
    settled: () => queue,
    // The environment wins: a token in `.env` is the owner's own choice, made before the app started.
    token: async () => env.TELEGRAM_BOT_TOKEN || (await read()).token || null,
    fromEnv: () => !!env.TELEGRAM_BOT_TOKEN,
    paired: async (chatId: number) => (await read()).paired.some((one) => one.chatId === chatId),
    // Who may be listened to in a group. A chat paired before any of this was written has no user id of its own,
    // and a private chat's id *is* the person's id, so the one it was paired with still stands.
    founder: async (userId?: number) => !!userId && (await read()).paired.some((one) => (one.userId ?? one.chatId) === userId),
    // Where the things nobody asked for go: the group's Company topic once there is a group, and the paired phones
    // otherwise. Sending to both would mean reading every update twice.
    async where(): Promise<{ chatId: number; threadId?: number }[]> {
      const held = await read();
      if (held.group) return [{ chatId: held.group.chatId, ...(held.group.company ? { threadId: held.group.company } : {}) }];
      return held.paired.map((one) => ({ chatId: one.chatId }));
    },
    // "Answer me out loud", which the founder sets where they are: their phone, or the group, each on its own.
    speaks,
    async speak(chatId: number): Promise<boolean> {
      const on = !(await speaks(chatId));
      await save((held) => {
        if (held.group?.chatId === chatId) held.group = { ...held.group, speak: on };
        else held.paired = held.paired.map((one) => (one.chatId === chatId ? { ...one, speak: on } : one));
      });
      return on;
    },
    hook: async (id: string) => (await read()).hooks.find((one) => one.id === id) ?? null,
    pairing: () => (pairing && pairing.until > now() && pairing.tries < TRIES ? pairing : null),
    // A new code puts the old one out of use at once, so only what the founder is looking at can pair.
    newPairing(code = newCode()) { pairing = { code, until: now() + HOUR, tries: 0 }; return pairing; },
    // Five wrong tries burn the code: whoever is guessing has to wait for the founder to make another.
    missed() { if (pairing) pairing.tries += 1; },
    clearPairing() { pairing = null; },
  };
}
