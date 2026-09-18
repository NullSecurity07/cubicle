// Room art. Draws the flat-shaded isometric rooms as SVG and rasterises them, with a transparent background,
// to assets/raw/<room>.png. Run `pnpm assets` afterwards to produce the WebP files the stage loads.
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const W = 1440, H = 1056, S = 105, CX = W / 2, CY = 390;
const COS = Math.cos(Math.PI / 6), SIN = 0.5;
const iso = (x, y, z = 0) => [CX + (x - y) * COS * S, CY + (x + y) * SIN * S - z * S];
const pts = (list) => list.map((p) => iso(...p).map((n) => n.toFixed(1)).join(',')).join(' ');

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - amount)));
  return `rgb(${c.join(',')})`;
}
const poly = (list, fill) => `<polygon points="${pts(list)}" fill="${fill}" stroke="${fill}" stroke-width="5" stroke-linejoin="round"/>`;

function box([x, y, z, w, d, h], color) {
  const shadow = `<polygon points="${pts([[x, y + d, 0], [x + w, y + d, 0], [x + w + 0.35, y + d + 0.35, 0], [x + 0.35, y + d + 0.35, 0]])}" fill="#000" opacity=".10"/>`;
  return (z === 0 ? shadow : '')
    + poly([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]], shade(color, 0.14))
    + poly([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]], shade(color, 0.28))
    + poly([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]], color);
}

function plant(x, y) {
  const [px, py] = iso(x + 0.25, y + 0.25, 0.5);
  const leaves = [[0, -95, 58], [-42, -55, 46], [44, -50, 44]].map(([dx, dy, r]) => `<circle cx="${px + dx}" cy="${py + dy}" r="${r}" fill="#6f9a72"/>`).join('');
  return box([x, y, 0, 0.5, 0.5, 0.5], '#c9b8a3') + leaves;
}

function person(x, y, z, color, seated = false) {
  const [px, py] = iso(x, y, z);
  const body = seated ? 78 : 118;
  return `<ellipse cx="${px}" cy="${py + 4}" rx="40" ry="17" fill="#000" opacity=".16"/>`
    + `<rect x="${px - 29}" y="${py - body}" width="58" height="${body}" rx="29" fill="${color}"/>`
    + `<circle cx="${px}" cy="${py - body - 30}" r="31" fill="#e9c9ab"/>`;
}

const shell = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
  + poly([[0, 0, 0], [0, 6, 0], [0, 6, 3.3], [0, 0, 3.3]], '#bdb5a9')
  + poly([[0, 0, 0], [6, 0, 0], [6, 0, 3.3], [0, 0, 3.3]], '#cec7bb')
  + poly([[0, 0, 0], [6, 0, 0], [6, 6, 0], [0, 6, 0]], '#e1dacf')
  + inner + '</svg>';

const rooms = {
  founder: shell(
    box([0.5, 0.5, 0, 0.12, 0.12, 2.3], '#55514c') + box([0.3, 0.3, 2.3, 0.55, 0.55, 0.5], '#f0b35a')
    + plant(5.1, 0.5)
    + box([1.2, 2.9, 0, 2.3, 1.05, 0.9], '#b98a5a') + box([2.0, 3.2, 0.9, 0.7, 0.5, 0.06], '#8d9299')
    + person(4.3, 4.1, 0, '#f0b35a'),
  ),
  marketing: shell(
    box([0.25, 1.4, 0, 0.14, 2.6, 2.2], '#f4f2ee')
    + box([2.6, 0.35, 0, 2.5, 0.35, 1.1], '#e2745c') + box([2.6, 0.7, 0, 2.5, 0.8, 0.5], '#ee8a72')
    + plant(5.3, 5.0)
    + person(1.5, 3.0, 0, '#ee8a72'),
  ),
  build: shell(
    box([0.25, 3.4, 0, 0.55, 1.9, 2.0], '#c9b8a3')
    + box([1.6, 0.5, 0, 2.8, 1.05, 0.9], '#b98a5a')
    + box([1.9, 0.75, 0.9, 1.0, 0.1, 0.62], '#2c3550') + box([3.1, 0.75, 0.9, 1.0, 0.1, 0.62], '#2c3550')
    + box([2.65, 1.95, 0, 0.75, 0.75, 0.5], '#4e8cff')
    + person(3.02, 2.32, 0.5, '#4e8cff', true),
  ),
};

await mkdir('assets/raw', { recursive: true });
for (const [name, svg] of Object.entries(rooms)) {
  await sharp(Buffer.from(svg)).png().toFile(`assets/raw/${name}.png`);
}
console.log('rooms written');
