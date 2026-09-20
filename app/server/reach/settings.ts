import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { ReachChat, ReachHook, ReachPairing } from '../../shared/reach.ts';

// A hook's secret lives here beside the bot token, because verifying a signature needs the secret itself. Nothing
// in this file is ever answered to a GET.
export type Kept = { on: boolean; token?: string; cloudSpeech: boolean; paired: ReachChat[]; hooks: (ReachHook & { secret: string })[] };
export type Reach = ReturnType<typeof createReach>;

const EMPTY: Kept = { on: false, cloudSpeech: false, paired: [], hooks: [] };
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
    kept = { ...EMPTY, ...saved, paired: saved.paired ?? [], hooks: saved.hooks ?? [] };
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

  return {
    read,
    save,
    settled: () => queue,
    // The environment wins: a token in `.env` is the owner's own choice, made before the app started.
    token: async () => env.TELEGRAM_BOT_TOKEN || (await read()).token || null,
    fromEnv: () => !!env.TELEGRAM_BOT_TOKEN,
    paired: async (chatId: number) => (await read()).paired.some((one) => one.chatId === chatId),
    hook: async (id: string) => (await read()).hooks.find((one) => one.id === id) ?? null,
    pairing: () => (pairing && pairing.until > now() && pairing.tries < TRIES ? pairing : null),
    // A new code puts the old one out of use at once, so only what the founder is looking at can pair.
    newPairing(code = newCode()) { pairing = { code, until: now() + HOUR, tries: 0 }; return pairing; },
    // Five wrong tries burn the code: whoever is guessing has to wait for the founder to make another.
    missed() { if (pairing) pairing.tries += 1; },
    clearPairing() { pairing = null; },
  };
}
