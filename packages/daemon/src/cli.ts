#!/usr/bin/env node
import path from 'node:path';
import { scaffoldVault, Vault, VaultWatcher } from '@cubicle/core';

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
