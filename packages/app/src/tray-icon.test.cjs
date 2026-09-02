const assert = require('node:assert');
const { trayIconPng } = require('./tray-icon.cjs');
for (const s of ['idle', 'running', 'attention', 'stopped']) { const png = trayIconPng(s); assert.ok(png.length > 100, s); assert.strictEqual(png.subarray(1, 4).toString(), 'PNG'); }
console.log('tray icon png ok');
