// Draws the tray icon (a tiny office cubicle) as a PNG with no image assets: 22×22, 4 states.
const zlib = require('node:zlib');

function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }

/** state: 'idle' | 'running' | 'attention' | 'stopped' → PNG buffer */
function trayIconPng(state = 'stopped', size = 22) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => { if (x < 0 || y < 0 || x >= size || y >= size) return; const i = (y * size + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; };
  const rect = (x0, y0, x1, y1, r, g, b, a = 255) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, r, g, b, a); };
  const s = size / 22;
  const S = (v) => Math.round(v * s);
  // cubicle partition (grey), desk (brown), monitor (blue/dark), status dot
  rect(S(3), S(4), S(18), S(5), 150, 155, 170);
  rect(S(3), S(4), S(4), S(17), 150, 155, 170);
  rect(S(17), S(4), S(18), S(17), 150, 155, 170);
  rect(S(6), S(11), S(15), S(14), 165, 109, 54);
  rect(S(8), S(6), S(13), S(10), 43, 47, 58);
  const dot = { idle: [63, 163, 77], running: [42, 111, 219], attention: [224, 160, 48], stopped: [140, 140, 140] }[state] || [140, 140, 140];
  rect(S(9), S(7), S(12), S(9), ...dot);
  rect(S(15), S(15), S(20), S(20), ...dot);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
module.exports = { trayIconPng };
