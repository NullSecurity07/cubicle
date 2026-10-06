import { execFile, execFileSync, spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Check } from '../shared/openends.ts';

// The app as a systemd user service: the server keeps running when the window is closed, so the morning note, the
// bet checks, the watches and the backup happen on their own time rather than whenever the founder next opens it.
// Nothing here switches the service on by itself. That is the founder's call: the one command `enableLine` names, or
// the one Turn on button in Health (`serviceRunner`), never the app on its own.

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
// A systemctl with no user session to talk to (a container, a login without one) is as good as none: null too.
export const systemctl: Ask = (args) => new Promise((settle) => {
  execFile('systemctl', ['--user', ...args], { timeout: 5000 }, (error, stdout, stderr) => {
    if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return settle(null);
    if (error && noSession(String(stderr ?? ''))) return settle(null);
    settle(String(stdout ?? '').trim());
  });
});
export const noSession = (said: string) => /failed to connect to (user scope )?bus|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR/i.test(said);

// `handover`: switched on while this very app holds the port it would run on, so it starts the moment the app closes
// (and at every login) rather than now, when it would only fall over on a port that is taken.
export type ServiceState = { systemd: boolean; installed: boolean; enabled: boolean; active: string; path: string; handover?: boolean };

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
// The button that switches it on, where one may: only ever pressed by the founder.
export const TURN_ON = { label: 'Turn on', path: '/api/service/on' };
export function serviceRow(state: ServiceState): Check {
  const name = 'Runs while closed';
  const waits = 'the morning note, bet checks, page watches and the daily copy of your work wait until you open the app again';
  const install = `Turn on writes the service and switches it on. Or in app/, run pnpm service:install, then ${enableLine}. It is off until you do one of them.`;
  if (!state.systemd) return { name, ok: true, warn: true, detail: `no: this machine has no systemd user session, so ${waits}`, fix: 'Nothing to do: the app works while its window is open.' };
  if (!state.installed) return { name, ok: true, warn: true, detail: `no: ${waits}`, fix: install, act: TURN_ON };
  if (!state.enabled) return { name, ok: true, warn: true, detail: `no: the service is installed but not switched on. Switch it on with: systemctl --user enable --now ${SERVICE}`, fix: `Turn on, or run systemctl --user enable --now ${SERVICE}.`, act: TURN_ON };
  if (state.handover && state.active === 'inactive') return { name, ok: true, detail: 'yes: switched on. It takes over when you close the app, and starts at every login', fix: `pnpm service:remove in app/ takes it away.` };
  if (state.active !== 'active') return { name, ok: false, detail: `no: the service is switched on but ${state.active === 'failed' ? 'fell over' : 'is not running'}`, fix: `See why with journalctl --user -u ${SERVICE} -n 50. If node moved (an upgrade), run pnpm service:install in app/ again; then systemctl --user restart ${SERVICE}.` };
  return { name, ok: true, detail: 'yes: it runs as a service, starts at login and comes back if it falls over', fix: `pnpm service:remove in app/ takes it away.` };
}

// The api port the installed service holds: the one its unit names, or the app's own default.
export async function servicePort(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const text = await readFile(unitPath(env), 'utf8').catch(() => '');
  return Number(/^Environment="STAGE_API_PORT=(\d+)"$/m.exec(text)?.[1]) || 7421;
}

// Where the service runs from: the main checkout's app folder even when this runs in a worktree (a service is the
// founder's app, not a branch), the node running now, and the PATH of the founder's login shell, not of a pnpm run.
export function serviceInput(options: { from: string; workspace?: string; env?: NodeJS.ProcessEnv }): UnitInput {
  const env = options.env ?? process.env;
  const main = (() => {
    try { return dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: options.from, encoding: 'utf8' }).trim()); }
    catch { return options.from; }
  })();
  // printenv reads the same in bash, zsh and fish.
  const loginPath = (() => {
    try { return execFileSync(env.SHELL || '/bin/sh', ['-lc', 'printenv PATH'], { encoding: 'utf8', timeout: 10_000 }).trim(); }
    catch { return env.PATH ?? ''; }
  })();
  const port = Number(env.STAGE_API_PORT) || undefined;
  return { node: process.execPath, app: resolve(main, 'app'), workspace: resolve(options.workspace ?? env.STAGE_WORKSPACE ?? resolve(main, 'workspace')), path: cleanPath(loginPath) || '/usr/bin:/bin', ...(port ? { port } : {}) };
}

// The Turn on button behind Health's row, and what reads the row. Nothing switches the service on but `turnOn`, and only
// the founder's click calls it.
export type ServiceRunner = { state(): Promise<ServiceState>; turnOn(): Promise<{ ok: boolean; said: string }>; handover(): Promise<boolean> };

export function serviceRunner(options: { input: () => UnitInput; ownPort: number; env?: NodeJS.ProcessEnv; ask?: Ask }): ServiceRunner {
  const env = options.env ?? process.env;
  const ask = options.ask ?? systemctl;
  // This app holds the very port the service would run on, and is not the service itself (systemd gives its own an
  // INVOCATION_ID): starting it now would only fall over five times on a taken port, so it waits for the app to close.
  const holdsItsPort = async () => !env.INVOCATION_ID && await servicePort(env) === options.ownPort;
  const state = async () => {
    const found = await serviceState({ env, ask });
    return found.enabled && found.active === 'inactive' && await holdsItsPort() ? { ...found, handover: true } : found;
  };
  return {
    state,
    async turnOn() {
      const before = await serviceState({ env, ask });
      if (!before.systemd) return { ok: false, said: 'This machine has no systemd user session, so the app can only run while its window is open.' };
      await installService(options.input(), { env, ask });
      await ask(['daemon-reload']);
      await ask(['enable', SERVICE]);
      if (await holdsItsPort()) {
        const now = await state();
        return now.enabled ? { ok: true, said: 'Switched on. It takes over when you close the app, and starts at every login.' }
          : { ok: false, said: `The service was written but did not switch on. In a terminal: ${enableLine}` };
      }
      await ask(['start', SERVICE]);
      const now = await serviceState({ env, ask });
      return now.enabled && now.active === 'active' ? { ok: true, said: 'Switched on and running. It starts at every login and keeps going while the app is closed.' }
        : { ok: false, said: `It was switched on but is not running. See why with journalctl --user -u ${SERVICE} -n 50.` };
    },
    // True when the app is closing and the service waits for it: called on the way out, so it starts at once.
    async handover() { return !!(await state()).handover; },
  };
}

// Starts the switched-on service as the app leaves, so the work goes on with the window closed. The service's own
// Restart= covers the seconds while this app still holds the port.
export function startDetached() {
  try { spawn('systemctl', ['--user', 'start', SERVICE], { detached: true, stdio: 'ignore' }).unref(); } catch { /* no systemctl: nothing to hand over to */ }
}

// For a check run: a service that lives only in memory, so a click can be proven without touching the machine.
// `nosession`: a machine with no systemd user session.
export function stubRunner(kind = '1'): ServiceRunner & { calls: string[] } {
  const calls: string[] = [];
  const now: ServiceState = { systemd: kind !== 'nosession', installed: false, enabled: false, active: 'inactive', path: '/stub/.config/systemd/user/' + SERVICE };
  return {
    calls,
    async state() { return { ...now }; },
    async turnOn() {
      calls.push('turnOn');
      if (!now.systemd) return { ok: false, said: 'This machine has no systemd user session, so the app can only run while its window is open.' };
      Object.assign(now, { installed: true, enabled: true, active: 'active' });
      return { ok: true, said: 'Switched on and running. It starts at every login and keeps going while the app is closed.' };
    },
    async handover() { return false; },
  };
}
