import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVICE, cleanPath, servicePort, enableLine, installService, removeService, serviceRow, serviceState, unitPath, unitText, type ServiceState } from './service.ts';

const base = { node: '/usr/bin/node', app: '/home/me/cublicle/app', workspace: '/home/me/cublicle/workspace', path: '/usr/bin:/home/me/.local/bin' };

describe('the unit file', () => {
  it('runs the server from the main checkout with the workspace, comes back after a fall, and starts at login', () => {
    const text = unitText(base);
    expect(text).toContain('[Service]');
    expect(text).toContain('WorkingDirectory=/home/me/cublicle/app');
    expect(text).toContain('ExecStart=/usr/bin/node server/index.ts');
    expect(text).toContain('Environment="STAGE_WORKSPACE=/home/me/cublicle/workspace"');
    expect(text).toContain('Environment="PATH=/usr/bin:/home/me/.local/bin"');
    expect(text).toContain('Restart=on-failure');
    expect(text).toContain('WantedBy=default.target');
    // A port somebody else holds is five tries in two minutes, then the unit stays down and Health says it fell over.
    expect(text).toContain('StartLimitIntervalSec=120');
    expect(text).toContain('StartLimitBurst=5');
    expect(text.indexOf('StartLimitBurst')).toBeLessThan(text.indexOf('[Service]'));
    // Never the fake model, and never tied to a window that is not there.
    expect(text).not.toContain('STAGE_FAKE_MODEL');
    expect(text).not.toContain('STAGE_EXIT_WITH_PARENT');
  });

  it('keeps a space, a quote, a percent and a dollar in a path from meaning anything to systemd', () => {
    const text = unitText({ ...base, app: '/home/me/my app', workspace: '/home/me/100% "work" $x', node: '/opt/n$de/bin/node' });
    expect(text).toContain('WorkingDirectory=/home/me/my app');
    // systemd expands $ only on the Exec lines: anywhere else it is written as it is.
    expect(text).toContain('Environment="STAGE_WORKSPACE=/home/me/100%% \\"work\\" $x"');
    expect(text).toContain('ExecStart="/opt/n$$de/bin/node" server/index.ts');
  });

  it('names its own api port only when one was asked for', () => {
    expect(unitText(base)).not.toContain('STAGE_API_PORT');
    expect(unitText({ ...base, port: 7521 })).toContain('Environment="STAGE_API_PORT=7521"');
  });

  it('lives with the founder\'s own systemd units, under XDG_CONFIG_HOME when that is set', () => {
    expect(unitPath({ HOME: '/home/me' })).toBe(`/home/me/.config/systemd/user/${SERVICE}`);
    expect(unitPath({ HOME: '/home/me', XDG_CONFIG_HOME: '/tmp/cfg' })).toBe(`/tmp/cfg/systemd/user/${SERVICE}`);
  });
});

describe('installing and removing', () => {
  it('writes the file and switches nothing on: the command that would is handed back to be printed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'service-'));
    const asked: string[][] = [];
    const done = await installService(base, { env: { HOME: home }, ask: async (args) => { asked.push(args); return ''; } });
    expect(done.path).toBe(unitPath({ HOME: home }));
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(done.path, 'utf8')).toBe(unitText(base));
    expect(asked.some((args) => args.includes('enable'))).toBe(false);
    expect(done.next).toBe(enableLine);
    expect(enableLine).toContain(`systemctl --user enable --now ${SERVICE}`);
  });

  it('takes the service off and the file away, and says so when there was nothing there', async () => {
    const home = mkdtempSync(join(tmpdir(), 'service-'));
    const asked: string[][] = [];
    const ask = async (args: string[]) => { asked.push(args); return ''; };
    expect((await removeService({ env: { HOME: home }, ask })).removed).toBe(false);
    await installService(base, { env: { HOME: home }, ask });
    expect((await removeService({ env: { HOME: home }, ask })).removed).toBe(true);
    expect(asked).toContainEqual(['disable', '--now', SERVICE]);
    expect((await serviceState({ env: { HOME: home }, ask })).installed).toBe(false);
  });
});

describe('the state of the service', () => {
  const home = () => {
    const dir = mkdtempSync(join(tmpdir(), 'service-'));
    mkdirSync(join(dir, '.config/systemd/user'), { recursive: true });
    writeFileSync(join(dir, '.config/systemd/user', SERVICE), unitText(base));
    return dir;
  };
  const answers = (enabled: string | null, active: string | null) => async (args: string[]) => (args[0] === 'is-enabled' ? enabled : args[0] === 'is-active' ? active : '');

  it('reads installed, switched on and running from systemd', async () => {
    expect(await serviceState({ env: { HOME: home() }, ask: answers('enabled', 'active') })).toMatchObject({ systemd: true, installed: true, enabled: true, active: 'active' });
    expect(await serviceState({ env: { HOME: home() }, ask: answers('disabled', 'inactive') })).toMatchObject({ installed: true, enabled: false, active: 'inactive' });
  });

  it('says there is no systemd when systemctl cannot be run', async () => {
    const state = await serviceState({ env: { HOME: mkdtempSync(join(tmpdir(), 'service-')) }, ask: async () => null });
    expect(state).toMatchObject({ systemd: false, installed: false, enabled: false });
  });
});

describe('the row that says whether it runs while closed', () => {
  const state = (over: Partial<ServiceState>): ServiceState => ({ systemd: true, installed: true, enabled: true, active: 'active', path: '/x', ...over });

  it('says yes, and Fine, only when it starts at login and is running', () => {
    expect(serviceRow(state({}))).toMatchObject({ name: 'Runs while closed', ok: true });
    expect(serviceRow(state({})).warn).toBeUndefined();
    expect(serviceRow(state({})).detail).toMatch(/^yes/);
  });

  it('says no as worth a look, with the command that switches it on as the fix, when it was never installed or not switched on', () => {
    const never = serviceRow(state({ installed: false, enabled: false, active: 'inactive' }));
    expect(never).toMatchObject({ ok: true, warn: true });
    expect(never.detail).toMatch(/^no/);
    expect(never.detail).toContain('pnpm service:install');
    expect(never.fix).toContain('pnpm service:install');
    expect(never.fix).toContain(enableLine);
    const off = serviceRow(state({ enabled: false, active: 'inactive' }));
    expect(off).toMatchObject({ ok: true, warn: true });
    expect(off.detail).toMatch(/^no/);
    expect(off.fix).toContain(`systemctl --user enable --now ${SERVICE}`);
  });

  it('is a fault when it is switched on and not running', () => {
    const fallen = serviceRow(state({ active: 'failed' }));
    expect(fallen.ok).toBe(false);
    expect(fallen.detail).toMatch(/^no/);
    expect(fallen.fix).toContain('journalctl --user');
    // A node that moved (a version manager's upgrade) is fixed by writing the unit again.
    expect(fallen.fix).toContain('pnpm service:install');
  });

  it('says plainly when the machine has no systemd', () => {
    const none = serviceRow(state({ systemd: false, installed: false, enabled: false }));
    expect(none.detail).toMatch(/^no.*systemd/);
    expect(none).toMatchObject({ ok: true, warn: true });
  });
});

describe('the PATH the service is given', () => {
  it('leaves out what pnpm put in front for its own scripts, and anything said twice', () => {
    const shell = '/app/node_modules/.bin:/home/me/.local/share/pnpm/node_modules/pnpm/dist/node-gyp-bin:/home/me/.local/bin:/usr/bin:/usr/bin';
    expect(cleanPath(shell)).toBe('/home/me/.local/bin:/usr/bin');
  });
});

describe('the port the service holds', () => {
  it('is the one its unit names, and 7421 when it names none or there is no unit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'service-'));
    expect(await servicePort({ HOME: home })).toBe(7421);
    await installService(base, { env: { HOME: home }, ask: async () => '' });
    expect(await servicePort({ HOME: home })).toBe(7421);
    await installService({ ...base, port: 7521 }, { env: { HOME: home }, ask: async () => '' });
    expect(await servicePort({ HOME: home })).toBe(7521);
  });
});
