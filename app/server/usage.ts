import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ModelInfo, Usage } from '../shared/model.ts';
import type { ModelClient, Quota } from './providers.ts';

type Count = { requests: number; input: number; output: number };
type State = { day: string; providers: Record<string, Count> };
type Seen = { at: number; tokens: number };

export type UsageBook = ReturnType<typeof createUsage>;

const WINDOW = 60_000;
const today = (now: number) => new Date(now).toISOString().slice(0, 10);
const share = (used: number, limit?: number) => (limit ? Math.max(0, 1 - used / limit) : 1);

// Keeps count of what each free provider has been asked today, so a person can move on before a limit bites.
// Published limits are a guide; a provider's own headers and its 429s are the truth and override them.
export function createUsage(path: string | null, now: () => number = Date.now) {
  let state: State = { day: today(now()), providers: {} };
  const recent: Record<string, Seen[]> = {};
  const quotas: Record<string, { at: number; quota: Quota }> = {};
  const cooling: Record<string, number> = {};
  let saving: Promise<unknown> = Promise.resolve();

  const roll = () => { if (state.day !== today(now())) state = { day: today(now()), providers: {} }; };
  const count = (name: string) => (state.providers[name] ??= { requests: 0, input: 0, output: 0 });
  const window = (name: string) => (recent[name] = (recent[name] ?? []).filter((seen) => now() - seen.at < WINDOW));
  const save = () => {
    if (!path) return;
    const text = JSON.stringify(state, null, 2);
    saving = saving.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, text);
      await rename(`${path}.tmp`, path);
    }).catch(() => {});
  };

  function left(client: ModelClient) {
    roll();
    const used = count(client.name);
    const header = quotas[client.name];
    const fromHeader = header && today(header.at) === state.day && header.quota.limitRequests && header.quota.remainingRequests !== undefined
      ? header.quota.remainingRequests / header.quota.limitRequests : 1;
    return Math.min(share(used.requests, client.limits.rpd), share(used.input + used.output, client.limits.tpd), fromHeader);
  }

  return {
    async load() {
      if (!path) return;
      try {
        const saved = JSON.parse(await readFile(path, 'utf8')) as State;
        if (saved.day === today(now())) state = saved;
      } catch { /* first run, or a damaged file: start the day at zero */ }
    },
    settled: () => saving,
    record(name: string, usage?: Usage, quota?: Quota) {
      roll();
      const used = count(name);
      used.requests += 1;
      used.input += usage?.input ?? 0;
      used.output += usage?.output ?? 0;
      window(name).push({ at: now(), tokens: (usage?.input ?? 0) + (usage?.output ?? 0) });
      if (quota) quotas[name] = { at: now(), quota };
      save();
    },
    // A provider said "not now": leave it alone for as long as it asked, or a minute.
    cool(name: string, milliseconds = WINDOW) { cooling[name] = now() + milliseconds; },
    left,
    // True when one more request of this size would likely hit the per-minute wall.
    hot(client: ModelClient, promptChars: number) {
      if ((cooling[client.name] ?? 0) > now()) return true;
      const seen = window(client.name);
      const tokens = Math.ceil(promptChars / 4);
      if (client.limits.rpm && seen.length >= client.limits.rpm) return true;
      if (client.limits.tpm && seen.reduce((sum, one) => sum + one.tokens, 0) + tokens > client.limits.tpm) return true;
      const header = quotas[client.name];
      return !!header && now() - header.at < WINDOW && header.quota.remainingTokens !== undefined && header.quota.remainingTokens < tokens;
    },
    info(clients: ModelClient[]): ModelInfo[] {
      roll();
      return clients.map((client) => {
        const used = count(client.name);
        return { name: client.name, model: client.model, ready: true, left: left(client), requests: used.requests, tokens: used.input + used.output };
      });
    },
  };
}
