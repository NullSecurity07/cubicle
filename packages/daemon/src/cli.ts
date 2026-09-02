#!/usr/bin/env node
import path from 'node:path';
import { scaffoldVault, Vault, VaultWatcher, openMemoryDb, EventLog, repoRoot, type ModelTier } from '@cubicle/core';
import { loadProvidersConfig, QuotaTracker, Router, providersTest, providersRefresh, formatTestRows, embedTexts } from '@cubicle/router';
import { MemoryIndex } from '@cubicle/harness';
import { Daemon, readDaemonInfo, isPidAlive } from './daemon.js';
import { defaultConfig } from './config.js';
import { rebuildCache } from './rebuild.js';
import { createHeartbeatJob } from './heartbeat.js';
import { createJob, listJobs, updateJob } from '@cubicle/core';
import { writeQueueMd } from './queue-md.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

export function providersConfigPath(flags: Record<string, string | boolean>): string {
  return typeof flags.providers === 'string' ? path.resolve(flags.providers) : path.join(repoRoot(), 'config', 'providers.yaml');
}


type Handler = (args: string[], flags: Record<string, string | boolean>) => Promise<void>;

const BOOLEAN_FLAGS = new Set(['force', 'tools', 'local', 'json']);

function parseArgs(argv: string[]): { cmd: string[]; flags: Record<string, string | boolean> } {
  const cmd: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (BOOLEAN_FLAGS.has(k)) flags[k] = true;
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
  async start(args, flags) {
    const root = resolveVaultPath(flags, args[0]);
    const daemon = new Daemon(defaultConfig(root, process.env, typeof flags.port === 'string' ? { port: Number(flags.port) } : {}));
    await daemon.start();
    console.log(`daemon running (pid ${process.pid}); vault ${root}. Ctrl-C or \`cubicle stop\` to checkpoint and exit.`);
    await new Promise(() => undefined); // run until a signal stops us
  },
  async stop(args, flags) {
    const root = resolveVaultPath(flags, args[0]);
    const info = readDaemonInfo(root);
    if (!info || !isPidAlive(info.pid)) { console.log('daemon is not running'); return; }
    process.kill(info.pid, 'SIGTERM');
    const t0 = Date.now();
    while (isPidAlive(info.pid) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 200));
    console.log(isPidAlive(info.pid) ? `daemon (pid ${info.pid}) did not exit within 10 s` : `daemon stopped in ${Date.now() - t0} ms`);
  },
  async status(args, flags) {
    const root = resolveVaultPath(flags, args[0]);
    const info = readDaemonInfo(root);
    const alive = info ? isPidAlive(info.pid) : false;
    console.log(`vault: ${root}`);
    console.log(`daemon: ${alive ? `running (pid ${info!.pid}, ws port ${info!.port ?? 'off'}, since ${info!.started})` : 'stopped'}`);
    const vault = Vault.open(root);
    try {
      const jobs = listJobs(vault);
      const counts: Record<string, number> = {};
      for (const j of jobs) counts[j.status] = (counts[j.status] ?? 0) + 1;
      console.log(`jobs: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);
      const hb = vault.events.last('heartbeat.completed');
      console.log(`last heartbeat: ${hb ? hb.ts : 'never'}`);
      console.log(`events: ${vault.events.count()}`);
    } finally { vault.close(); }
  },
  async heartbeat(args, flags) {
    // Force a heartbeat: if the daemon runs, it picks the job up; otherwise run one inline (no WS/workers).
    const root = resolveVaultPath(flags, args[0]);
    const info = readDaemonInfo(root);
    if (info && isPidAlive(info.pid)) {
      const vault = Vault.open(root);
      const id = createHeartbeatJob(vault, 'forced by cubicle heartbeat');
      vault.close();
      console.log(`queued heartbeat ${id}; the running daemon will execute it`);
      return;
    }
    const daemon = new Daemon(defaultConfig(root, process.env, { tickMs: 2000, maxConcurrentJobs: 2 }), { disableWs: true, disableSleepWatch: true, log: (m) => console.log(`[cubicle] ${m}`) });
    await daemon.start();
    daemon.requestHeartbeat('forced by cubicle heartbeat');
    const deadline = Date.now() + Number(flags.timeout ?? 20 * 60) * 1000;
    while (Date.now() < deadline) {
      const open = listJobs(daemon.vault, { status: ['queued', 'running', 'blocked'] }).some((j) => j.type === 'ceo.heartbeat' || j.type === 'cto.plan');
      if (!open && daemon.vault.events.last('heartbeat.completed')) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const hb = daemon.vault.events.last('heartbeat.completed');
    console.log(hb ? `heartbeat ${hb.payload.id} completed; brief: ${hb.payload.run}` : 'heartbeat did not complete in time (jobs remain; start the daemon to continue)');
    await daemon.stop();
  },
  async job(args, flags) {
    const sub = args[0];
    const root = resolveVaultPath(flags, typeof flags.vault === 'string' ? undefined : undefined);
    const vault = Vault.open(root);
    try {
      if (sub === 'add') {
        const title = args.slice(1).join(' ');
        if (!title) throw new Error('usage: cubicle job add "<title>" --role engineer --type custom --goal "..." [--priority 3] --vault <path>');
        const id = createJob(vault, { type: String(flags.type ?? 'custom'), title, assigned: String(flags.role ?? 'engineer'), goal: String(flags.goal ?? title), priority: flags.priority ? Number(flags.priority) : 3 }, 'owner');
        writeQueueMd(vault);
        console.log(`queued ${id}`);
      } else if (sub === 'cancel') {
        const id = args[1]; if (!id) throw new Error('usage: cubicle job cancel <id> --vault <path>');
        updateJob(vault, id, { status: 'cancelled' }, 'owner', `- ${new Date().toISOString()}: cancelled by owner (cli)`);
        console.log(`cancelled ${id}`);
      } else if (sub === 'list' || !sub) {
        for (const j of listJobs(vault)) console.log(`${j.status.padEnd(9)} p${j.priority} ${j.id}  ${j.assigned.padEnd(9)} ${j.type.padEnd(16)} step ${String(j.checkpoint_step).padStart(2)}  ${j.title}`);
      } else throw new Error('usage: cubicle job add|cancel|list');
    } finally { vault.close(); }
  },
  async replay(args, flags) {
    const date = args[0]; if (!date) throw new Error('usage: cubicle replay YYYY-MM-DD --vault <path>');
    const vault = Vault.open(resolveVaultPath(flags));
    try {
      const events = vault.events.query({ from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.999Z` });
      const byHour: Record<string, Record<string, number>> = {};
      for (const e of events) { const h = e.ts.slice(11, 13); (byHour[h] ??= {})[e.type] = ((byHour[h] ?? {})[e.type] ?? 0) + 1; }
      console.log(`${events.length} events on ${date}`);
      for (const [h, types] of Object.entries(byHour)) console.log(`${h}:00  ${Object.entries(types).map(([t, n]) => `${t}×${n}`).join('  ')}`);
      const info = readDaemonInfo(vault.root);
      console.log(`viewer: http://127.0.0.1:${(info?.port ?? 7411) + 1}/?replay=${date}  (Phase 9 serves the viewer; until then use the WS replay op)`);
    } finally { vault.close(); }
  },
  async rebuild(args, flags) {
    const root = resolveVaultPath(flags, args[0]);
    const cfg = loadProvidersConfig(providersConfigPath(flags));
    const r = await rebuildCache(root, { memory: async (v) => new MemoryIndex(v, (t) => embedTexts(cfg, t)).rebuild().catch(() => 0) });
    console.log(`rebuilt .cubicle cache: ${r.events} events, ${r.writtenSha} written_sha rows, ${r.jobs} jobs indexed, ${r.memoryFiles} memory files`);
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
