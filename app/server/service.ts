import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Check } from '../shared/openends.ts';

// The app as a systemd user service: the server keeps running when the window is closed, so the morning note, the
// bet checks, the watches and the backup happen on their own time rather than whenever the founder next opens it.
// Nothing here switches the service on. That is the founder's call, made with the one command `enableLine` names.

export const SERVICE = 'cubicle.service';
export const enableLine = `systemctl --user daemon-reload && systemctl --user enable --now ${SERVICE}`;

// Where it runs from and with what: the main checkout's app folder, the node that installed it, the workspace, and
// the PATH of the shell that installed it, so ffmpeg, opencode and uvx are found the way they are in a terminal.
export type UnitInput = { node: string; app: string; workspace: string; path: string; port?: number };
// systemd's own `ask` for a sub-command: what it printed, or null when there is no systemctl to ask.
export type Ask = (args: string[]) => Promise<string | null>;
type Where = { env?: NodeJS.ProcessEnv; ask?: Ask };

// `%` and `$` mean something to systemd in these lines; a quoted value keeps a space from ending it.
// `%` is a specifier on every line; `$` is expanded only on the Exec lines, so it is doubled only there.
const escaped = (value: string) => value.replace(/%/g, '%%');
const quoted = (value: string) => `"${escaped(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const setting = (name: string, value: string) => `Environment=${quoted(`${name}=${value}`)}`;
const command = (path: string) => (/[\s"'\\$%]/.test(path) ? quoted(path).replace(/\$/g, '$$$$') : path);

// The PATH as the founder's own login shell has it, less what pnpm puts in front while it runs a script (the
// checkout's node_modules/.bin, its own node-gyp) and anything said twice.
export const cleanPath = (path: string) => [...new Set(path.split(':').filter((one) => one && !one.includes('node_modules/.bin') && !/\/pnpm\/.*(dist|node-gyp-bin)/.test(one)))].join(':');

export function unitText(input: UnitInput): string {
  return [
    '[Unit]',
    'Description=Cubicle, running while its window is closed',
    // Five falls in two minutes (a port somebody else holds) and it stays down, which Health says, rather than
    // trying every five seconds for ever.
    'StartLimitIntervalSec=120',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    // A folder name is taken as it is here: systemd reads this line whole, spaces and all.
    `WorkingDirectory=${escaped(input.app)}`,
    setting('STAGE_WORKSPACE', input.workspace),
    setting('PATH', input.path),
    ...(input.port ? [setting('STAGE_API_PORT', String(input.port))] : []),
    `ExecStart=${command(input.node)} server/index.ts`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function unitPath(env: NodeJS.ProcessEnv = process.env): string {
  const config = env.XDG_CONFIG_HOME || join(env.HOME ?? '', '.config');
  return join(config, 'systemd', 'user', SERVICE);
}

// `systemctl --user <args>`, read and never waited on for long. A state it reports with a failing exit (disabled,
// inactive) is still its answer; only a systemctl that is not there at all is null.
export const systemctl: Ask = (args) => new Promise((settle) => {
  execFile('systemctl', ['--user', ...args], { timeout: 5000 }, (error, stdout) => {
    if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return settle(null);
    settle(String(stdout ?? '').trim());
  });
});

export type ServiceState = { systemd: boolean; installed: boolean; enabled: boolean; active: string; path: string };

export async function serviceState(where: Where = {}): Promise<ServiceState> {
  const ask = where.ask ?? systemctl;
  const path = unitPath(where.env);
  const installed = await access(path).then(() => true, () => false);
  const enabled = await ask(['is-enabled', SERVICE]);
  const active = enabled === null ? null : await ask(['is-active', SERVICE]);
  return { systemd: enabled !== null, installed, enabled: installed && enabled === 'enabled', active: (installed && active) || 'inactive', path };
}

// Written, never switched on: the next step is handed back for the founder to run, or not.
export async function installService(input: UnitInput, where: Where = {}): Promise<{ path: string; next: string }> {
  const path = unitPath(where.env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, unitText(input));
  return { path, next: enableLine };
}

export async function removeService(where: Where = {}): Promise<{ path: string; removed: boolean }> {
  const ask = where.ask ?? systemctl;
  const path = unitPath(where.env);
  if (!await access(path).then(() => true, () => false)) return { path, removed: false };
  await ask(['disable', '--now', SERVICE]);
  await rm(path, { force: true });
  await ask(['daemon-reload']);
  return { path, removed: true };
}

// Health's row, in the founder's words: does the app keep working when they close it. Not having the service is a
// choice, not a fault, but it is not Fine either: the morning note and the bet checks wait, so it is worth a look,
// with the command that switches it on. A service that is switched on and not running is a fault.
export function serviceRow(state: ServiceState): Check {
  const name = 'Runs while closed';
  const waits = 'the morning note, bet checks, page watches and the daily copy of your work wait until you open the app again';
  const install = `In app/, run pnpm service:install, then ${enableLine}. It is off until you run that.`;
  if (!state.systemd) return { name, ok: true, warn: true, detail: `no: this machine has no systemd user services, so ${waits}`, fix: 'Nothing to do: the app works while its window is open.' };
  if (!state.installed) return { name, ok: true, warn: true, detail: `no: ${waits}. pnpm service:install in app/ keeps it running`, fix: install };
  if (!state.enabled) return { name, ok: true, warn: true, detail: `no: the service is installed but not switched on. Switch it on with: systemctl --user enable --now ${SERVICE}`, fix: `Run systemctl --user enable --now ${SERVICE}.` };
  if (state.active !== 'active') return { name, ok: false, detail: `no: the service is switched on but ${state.active === 'failed' ? 'fell over' : 'is not running'}`, fix: `See why with journalctl --user -u ${SERVICE} -n 50. If node moved (an upgrade), run pnpm service:install in app/ again; then systemctl --user restart ${SERVICE}.` };
  return { name, ok: true, detail: 'yes: it runs as a service, starts at login and comes back if it falls over', fix: `pnpm service:remove in app/ takes it away.` };
}

// The api port the installed service holds: the one its unit names, or the app's own default.
export async function servicePort(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const text = await readFile(unitPath(env), 'utf8').catch(() => '');
  return Number(/^Environment="STAGE_API_PORT=(\d+)"$/m.exec(text)?.[1]) || 7421;
}
