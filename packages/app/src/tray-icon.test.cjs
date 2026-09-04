const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { trayIconPng } = require('./tray-icon.cjs');
const { resolveDaemonEntry } = require('./daemon-entry.cjs');

for (const s of ['idle', 'running', 'attention', 'stopped']) { const png = trayIconPng(s); assert.ok(png.length > 100, s); assert.strictEqual(png.subarray(1, 4).toString(), 'PNG'); }
console.log('tray icon png ok');

// The tray spawns the daemon on the system node, so a checkout that was never built must say so, not no-op.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cubicle-app-'));
try {
  assert.throws(() => resolveDaemonEntry(root), /daemon not built: run pnpm -r build/);
  const dist = path.join(root, 'packages', 'daemon', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'cli.js'), '// built\n');
  assert.strictEqual(resolveDaemonEntry(root), path.join(dist, 'cli.js'));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('daemon entry ok');
