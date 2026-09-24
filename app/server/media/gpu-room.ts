import { execFile } from 'node:child_process';
import { basename } from 'node:path';

// Room on the graphics card before a local model is started on it.
//
// The founder's card has 4 GB, and the same card answers the people's own chat: Ollama keeps a model it has just used
// sitting on it for minutes afterwards. Measured on 2026-09-24, qwen2.5:7b held 2.5 GB, the picture renderer asked for
// 2.1 GB of what was left, got told no, and the founder saw "generate failed". With the chat model let go, the same
// picture was drawn in 57 seconds. So before a picture, a clip or a voice starts, this looks at the card, lets go of
// whatever is only resting on it — Ollama's loaded weights (Ollama itself stays up and loads them again on the next
// ask, in a few seconds) and an idle OmniVoice worker — and says so in one line. If there is still not enough, it says
// who holds the card before anything is started, rather than after a minute of loading.

// What each local job was measured to ask of the card, in MB. The picture renderer asked for 2124.76 MB; a clip peaked
// at 3.2 GB but starts within 3 GB; OmniVoice's worker holds about 2.4 GB once loaded.
export const NEEDS_MB = { picture: 2200, clip: 3000, voice: 2500 } as const;

export const OLLAMA = 'http://127.0.0.1:11434';

// Something of ours that may be resting on the card and can be let go of on request. `release` says whether anything
// was running; `pids` names its processes so the card's own list can say whose they are.
export type Holder = { name: string; release: () => boolean; pids: () => number[] };
const ours = new Set<Holder>();
export const holdsTheCard = (holder: Holder): Holder => { ours.add(holder); return holder; };

export type Card = { used: number; total: number };
export type Process = { pid: number; name: string; mb: number };
export type Smi = (args: string[]) => Promise<string | null>;

const smiReally: Smi = (args) => new Promise((done) => {
  execFile('nvidia-smi', args, { timeout: 5000 }, (error, out) => done(error ? null : String(out)));
});

export async function readCard(smi: Smi = smiReally): Promise<Card | null> {
  const out = await smi(['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits']);
  const found = out && /^\s*(\d+)\s*,\s*(\d+)/m.exec(out);
  return found ? { used: Number(found[1]), total: Number(found[2]) } : null;
}

export async function whoHolds(smi: Smi = smiReally): Promise<Process[]> {
  const out = await smi(['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits']);
  if (!out) return [];
  return out.split('\n').flatMap((line) => {
    const found = /^\s*(\d+)\s*,\s*(.+?)\s*,\s*(\d+)(?:\s*MiB)?\s*$/.exec(line);
    return found ? [{ pid: Number(found[1]), name: basename(found[2]), mb: Number(found[3]) }] : [];
  });
}

export const gb = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;
const freeOf = (card: Card) => card.total - card.used;

export type RoomDeps = {
  env?: NodeJS.ProcessEnv;
  smi?: Smi;
  fetch?: typeof fetch;
  ollama?: string;
  // How long to wait for the card to show what was let go of. The driver takes a moment to hand memory back.
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  // A job that has somewhere else to go when the card is full (OmniVoice falls back to the processor) makes room but
  // is not stopped when there is still not enough.
  soft?: boolean;
};

// Lets go of every model Ollama has loaded, and says which ones and how big. Only what /api/ps lists is touched; the
// server keeps running and loads a model again when somebody next asks it something.
async function unloadOllama(http: typeof fetch, at: string): Promise<string[]> {
  const listed = await http(`${at}/api/ps`, { signal: AbortSignal.timeout(3000) })
    .then((answer) => (answer.ok ? answer.json() as Promise<{ models?: { name?: string; model?: string; size_vram?: number }[] }> : null))
    .catch(() => null);
  const let_go: string[] = [];
  for (const one of listed?.models ?? []) {
    const name = one.name ?? one.model;
    if (!name) continue;
    const done = await http(`${at}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name, keep_alive: 0 }), signal: AbortSignal.timeout(10_000),
    }).then((answer) => answer.ok, () => false);
    if (done) let_go.push(one.size_vram ? `${name} (${gb(one.size_vram / 1024 / 1024)})` : name);
  }
  return let_go;
}

// Makes `need` MB of room on the graphics card, or says plainly why it cannot. Silent when there is room already, and
// when this machine has no NVIDIA card to ask about.
export async function makeRoom(need: number, report: (line: string) => void, deps: RoomDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const smi = deps.smi ?? smiReally;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  let card = await readCard(smi);
  if (!card || freeOf(card) >= need) return;

  const let_go: string[] = [];
  const keepOllama = env.STAGE_KEEP_OLLAMA === '1';
  if (!keepOllama) let_go.push(...await unloadOllama(deps.fetch ?? fetch, deps.ollama ?? env.OLLAMA_URL?.trim() ?? OLLAMA));
  for (const holder of ours) if (holder.release()) let_go.push(`the ${holder.name} worker`);

  if (let_go.length) {
    const until = Date.now() + (deps.waitMs ?? 10_000);
    while (true) {
      card = (await readCard(smi)) ?? card;
      if (freeOf(card) >= need || Date.now() >= until) break;
      await sleep(250);
    }
    report(`Made room on the graphics card: unloaded ${let_go.join(', ')}`);
  }
  if (freeOf(card) >= need) return;

  const pids = new Map<number, string>();
  for (const holder of ours) for (const pid of holder.pids()) pids.set(pid, holder.name);
  const held = (await whoHolds(smi)).sort((a, b) => b.mb - a.mb).map((one) => {
    const whose = pids.get(one.pid) ?? (/ollama/i.test(one.name) ? 'Ollama' : '');
    return `${one.name}${whose && whose.toLowerCase() !== one.name.toLowerCase() ? ` (${whose})` : ''} holds ${gb(one.mb)}`;
  });
  const line = `Not enough room on the graphics card: ${gb(freeOf(card))} free, ${gb(need)} needed`
    + (held.length ? `; ${held.join(', ')}` : '')
    + (keepOllama ? '. Ollama is kept loaded because STAGE_KEEP_OLLAMA=1' : '');
  if (deps.soft) { report(line); return; }
  throw new Error(line);
}

// The card in one line, for the checks.
export async function cardLine(smi: Smi = smiReally): Promise<string | null> {
  const card = await readCard(smi);
  return card && `the graphics card has ${gb(freeOf(card))} of ${gb(card.total)} free`;
}

// What the renderer said when it went wrong, most telling first. It prints pages of chatter and ends with the same two
// generic lines whatever the cause, so the line that names the cause — the card was full, the device was lost — is
// put ahead of the last thing it said.
export const TELLING = /cannot make enough memory|out of memory|ErrorDeviceLost|failed during weight preparation/i;
export const WRONG = /\b(error|failed|cannot|out of memory|no such)\b|ErrorDevice/i;
export const plainLine = (line: string): string => line.replace(/^\[\w+\s*\]\s*[\w./-]+:\d+\s*-\s*/, '').trim();
export function whatWentWrong(lines: string[], cap = 240): string {
  const telling = lines.find((line) => TELLING.test(line));
  const last = lines.at(-1);
  return [telling, last].filter((one, at, all): one is string => !!one && all.indexOf(one) === at).join('; ').slice(0, cap);
}
