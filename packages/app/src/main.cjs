// CUBICLE tray shell (Electron). The daemon is a separate process (packages/daemon); this app only
// starts/stops it, opens the office and the vault, and forwards suspend/quit as SIGTERM so the daemon checkpoints.
const { app, Tray, Menu, BrowserWindow, dialog, shell, nativeImage, powerMonitor, Notification } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { trayIconPng } = require('./tray-icon.cjs');

const SMOKE = process.argv.includes('--smoke');
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const configFile = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { vault: process.env.CUBICLE_VAULT || '' };
let daemon = null;          // child process
let tray = null;
let office = null;          // BrowserWindow
let lastState = 'stopped';
const log = (m) => console.log(`[cubicle-app] ${m}`);

function loadCfg() { try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) }; } catch { /* first run */ } }
function saveCfg() { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2)); }
function daemonInfo() { try { return JSON.parse(fs.readFileSync(path.join(cfg.vault, '.cubicle', 'daemon.json'), 'utf8')); } catch { return null; } }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function running() { const i = daemonInfo(); return !!(i && pidAlive(i.pid)); }
function pendingCount() {
  try { return fs.readdirSync(path.join(cfg.vault, '00 Inbox')).filter((f) => f.endsWith('.md') && f !== 'README.md').filter((f) => { const t = fs.readFileSync(path.join(cfg.vault, '00 Inbox', f), 'utf8'); return /^kind:\s*(?!message)/m.test(t) && /^approved:\s*null/m.test(t); }).length; } catch { return 0; }
}

async function pickVault() {
  const r = await dialog.showOpenDialog({ title: 'Choose your CUBICLE vault (an Obsidian vault folder)', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return false;
  cfg.vault = r.filePaths[0]; saveCfg();
  if (!fs.existsSync(path.join(cfg.vault, 'Memory', 'constitution.md'))) {
    const init = spawn(process.execPath, [path.join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js'), 'init', cfg.vault], { cwd: repoRoot, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    await new Promise((res) => init.on('exit', res));
  }
  return true;
}

function startDaemon() {
  if (running()) { log('daemon already running'); return; }
  if (!cfg.vault) { log('no vault configured'); return; }
  daemon = spawn(process.execPath, [path.join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js'), 'start', cfg.vault], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  daemon.stdout.on('data', (d) => process.stdout.write(`[daemon] ${d}`));
  daemon.stderr.on('data', (d) => process.stderr.write(`[daemon] ${d}`));
  daemon.on('exit', (code) => { log(`daemon exited (${code})`); daemon = null; refresh(); });
  log(`daemon started (pid ${daemon.pid})`);
  setTimeout(refresh, 1500);
}

/** SIGTERM the daemon (whichever process owns daemon.json) and wait ≤ 6 s. Resolves with the exit time in ms. */
function stopDaemon() {
  return new Promise((resolve) => {
    const info = daemonInfo();
    const pid = daemon?.pid ?? info?.pid;
    if (!pid || !pidAlive(pid)) return resolve(0);
    const t0 = Date.now();
    try { process.kill(pid, 'SIGTERM'); } catch { return resolve(0); }
    const iv = setInterval(() => { if (!pidAlive(pid) || Date.now() - t0 > 6000) { clearInterval(iv); resolve(Date.now() - t0); } }, 100);
  });
}

function officeUrl() { const i = daemonInfo(); return i && i.port ? `http://127.0.0.1:${i.port + 1}/?token=${i.token || ''}&vault=${encodeURIComponent(path.basename(cfg.vault))}` : null; }

function openOffice() {
  const url = officeUrl();
  if (!url) { new Notification({ title: 'CUBICLE', body: 'Start the daemon first.' }).show(); return; }
  if (office && !office.isDestroyed()) { office.loadURL(url); office.show(); office.focus(); return; }
  office = new BrowserWindow({ width: 1280, height: 800, title: 'CUBICLE — the office', backgroundColor: '#0f1115', webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  office.loadURL(url);
  office.on('closed', () => { office = null; });
}

function openVault() {
  if (!cfg.vault) return;
  const name = path.basename(cfg.vault);
  shell.openExternal(`obsidian://open?vault=${encodeURIComponent(name)}`).catch(() => shell.openPath(cfg.vault));
}

function refresh() {
  if (!tray) return;
  const on = running();
  const pending = on ? pendingCount() : 0;
  const state = !on ? 'stopped' : pending ? 'attention' : 'running';
  if (state !== lastState) { tray.setImage(nativeImage.createFromBuffer(trayIconPng(state))); lastState = state; }
  tray.setToolTip(`CUBICLE — ${on ? `running${pending ? `, ${pending} to approve` : ''}` : 'stopped'}${cfg.vault ? `\n${cfg.vault}` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: cfg.vault ? `Vault: ${path.basename(cfg.vault)}` : 'No vault chosen', enabled: false },
    { label: on ? 'Stop daemon' : 'Start daemon', click: async () => { if (on) await stopDaemon(); else startDaemon(); refresh(); } },
    { label: 'Open Office', enabled: on, click: openOffice },
    { label: 'Open Vault in Obsidian', enabled: !!cfg.vault, click: openVault },
    { label: pending ? `${pending} proposal(s) waiting for you` : 'Nothing to approve', enabled: false },
    { type: 'separator' },
    { label: 'Choose vault…', click: async () => { if (await pickVault()) refresh(); } },
    { label: 'Quit (checkpoints the daemon)', click: async () => { await stopDaemon(); app.quit(); } },
  ]));
}

app.whenReady().then(async () => {
  loadCfg();
  tray = new Tray(nativeImage.createFromBuffer(trayIconPng('stopped')));
  refresh();
  if (!cfg.vault && !SMOKE) await pickVault();
  // Sleep: checkpoint and exit the daemon before suspend; restart it on resume (spec §14 test 9 "on wake, resumes").
  powerMonitor.on('suspend', async () => { const ms = await stopDaemon(); log(`suspend: daemon checkpointed and exited in ${ms} ms`); });
  powerMonitor.on('resume', () => { log('resume: restarting daemon'); startDaemon(); });
  powerMonitor.on('shutdown', () => { stopDaemon(); });
  app.on('before-quit', () => { if (daemon) { try { daemon.kill('SIGTERM'); } catch { /* ignore */ } } });
  setInterval(refresh, 5000);
  if (cfg.vault) startDaemon();
  if (SMOKE) {
    // Headless self-check: start → verify daemon.json → stop within 5 s → quit. Prints SMOKE PASS/FAIL.
    await new Promise((r) => setTimeout(r, 4000));
    const up = running();
    const url = officeUrl();
    const ms = await stopDaemon();
    const ok = up && !!url && ms > 0 && ms < 5000 && !running();
    console.log(`SMOKE ${ok ? 'PASS' : 'FAIL'}: daemon up=${up} office=${!!url} stop=${ms}ms`);
    app.exit(ok ? 0 : 1);
  }
});
app.on('window-all-closed', () => { /* tray app keeps running */ });
