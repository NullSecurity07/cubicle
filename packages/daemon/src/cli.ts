#!/usr/bin/env node
import path from 'node:path';
import { scaffoldVault, Vault, VaultWatcher, openMemoryDb, EventLog, repoRoot, type ModelTier } from '@cubicle/core';
import { loadProvidersConfig, QuotaTracker, Router, providersTest, providersRefresh, formatTestRows, embedTexts } from '@cubicle/router';
import { MemoryIndex } from '@cubicle/harness';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

export function providersConfigPath(flags: Record<string, string | boolean>): string {
  return typeof flags.providers === 'string' ? path.resolve(flags.providers) : path.join(repoRoot(), 'config', 'providers.yaml');
}


type Handler = (args: string[], flags: Record<string, string | boolean>) => Promise<void>;

function parseArgs(argv: string[]): { cmd: string[]; flags: Record<string, string | boolean> } {
  const cmd: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else cmd.push(a);
  }
  return { cmd, flags };
}

export function resolveVaultPath(flags: Record<string, string | boolean>, positional?: string): string {
  const p = positional ?? (typeof flags.vault === 'string' ? flags.vault : process.env.CUBICLE_VAULT);
  if (!p) throw new Error('No vault given. Pass a path, --vault <path>, or set CUBICLE_VAULT.');
  return path.resolve(p);
}

const commands: Record<string, Handler> = {
  async init(args, flags) {
    const target = resolveVaultPath(flags, args[0]);
    const res = await scaffoldVault(target, { force: flags.force === true });
    console.log(`Vault scaffolded at ${res.vault.root}`);
    console.log(`  ${res.files.length} files, initial commit ${res.commit ?? '(none)'}`);
    console.log(`Next: open it in Obsidian ("Open folder as vault"), then run: cubicle start --vault "${res.vault.root}"`);
    res.vault.close();
  },
  async watch(args, flags) {
    const root = resolveVaultPath(flags, args[0]);
    const vault = Vault.open(root);
    const w = new VaultWatcher(vault);
    vault.events.on('owner.edited', (e) => console.log(`[owner.edited] ${e.payload.path}${e.payload.deleted ? ' (deleted)' : ''}`));
    await w.start();
    console.log(`Watching ${root} (Ctrl-C to stop)`);
    const stop = async () => { await w.stop(); vault.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  },
  async providers(args, flags) {
    const sub = args[0];
    const file = providersConfigPath(flags);
    if (sub === 'test') {
      const cfg = loadProvidersConfig(file);
      const rows = await providersTest(cfg, process.env, { toolsCheck: flags.tools === true, only: typeof flags.only === 'string' ? flags.only : undefined });
      console.log(formatTestRows(rows));
      const ok = rows.filter((r) => r.ok).length;
      console.log(`\n${ok}/${rows.length} models ok`);
      if (ok === 0) process.exitCode = 1;
      return;
    }
    if (sub === 'refresh') {
      const { count } = await providersRefresh(file);
      console.log(`openrouter block refreshed from ${count} :free models → ${file}`);
      return;
    }
    throw new Error('usage: cubicle providers test [--tools] [--only <provider>] | refresh');
  },
  async chat(args, flags) {
    // Debug helper: one completion through the cascade. `cubicle chat --tier strong "prompt"`
    const prompt = args.join(' ') || 'Reply with the single word: pong';
    const cfg = loadProvidersConfig(providersConfigPath(flags));
    const db = openMemoryDb();
    const events = new EventLog(db, mkdtempSync(path.join(tmpdir(), 'cubicle-chat-')));
    events.on('router.downgraded', (e) => console.error(`[router.downgraded] ${e.payload.requested_tier} → ${e.payload.chosen_tier} via ${e.payload.provider}/${e.payload.model}; tried: ${(e.payload.tried as string[]).join(', ') || 'none'}`));
    const router = new Router(cfg, new QuotaTracker(db), { events });
    const tier = (typeof flags.tier === 'string' ? flags.tier : 'medium') as ModelTier;
    const res = await router.chat({ tier, needsTools: false, privacy: flags.local === true ? 'local' : 'cloud' }, { messages: [{ role: 'user', content: prompt }], maxTokens: 256 });
    console.log(`[${res.provider}/${res.model} tier=${res.tier}${res.downgraded ? ' DOWNGRADED' : ''} tokens=${res.usage.prompt_tokens}/${res.usage.completion_tokens}]`);
    console.log(res.content.trim());
  },
  async memory(args, flags) {
    const sub = args[0];
    const vault = Vault.open(resolveVaultPath(flags, args[1]));
    try {
      const cfg = loadProvidersConfig(providersConfigPath(flags));
      const mem = new MemoryIndex(vault, (t) => embedTexts(cfg, t));
      if (sub === 'rebuild') { const n = await mem.rebuild(); console.log(`memory rebuilt: ${n} files indexed, ${mem.count()} chunks`); return; }
      if (sub === 'index') { const n = await mem.indexAll(); console.log(`memory updated: ${n} files (re)indexed, ${mem.count()} chunks`); return; }
      if (sub === 'search') { const hits = await mem.search(args.slice(2).join(' '), 5); for (const h of hits) console.log(`${h.score.toFixed(3)}  ${h.path}\n    ${h.text.slice(0, 120).replace(/\n/g, ' ')}`); return; }
      throw new Error('usage: cubicle memory rebuild|index|search <vault> [query]');
    } finally { vault.close(); }
  },
  async help() {
    console.log(`cubicle <command>

  init <vault>              scaffold a new vault and git repo
  watch <vault>             print owner.edited events (debug)
  start | stop | status     daemon (Phase 4)
  heartbeat                 force a heartbeat (Phase 4)
  providers test|refresh    model router (Phase 2)
  job add|cancel|list       job queue (Phase 4)
  replay <date>             event replay (Phase 4)
  doctor                    environment + keys check (Phase 6)
  rebuild                   rebuild the .cubicle cache from the vault (Phase 4)
  memory rebuild|index|search <vault> [query]   embedding index over Memory/ Skills/ Decisions/
  chat [--tier t] [--local] <prompt>            one completion through the cascade (debug)
`);
  },
};

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { cmd, flags } = parseArgs(argv);
  const name = cmd[0] ?? 'help';
  const handler = commands[name];
  if (!handler) {
    console.error(`Unknown command: ${name}`);
    await commands.help([], {});
    process.exitCode = 2;
    return;
  }
  try {
    await handler(cmd.slice(1), flags);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
