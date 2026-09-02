/**
 * Generates config/world/office.json — a Tiled-format map (16 px tiles) for the viewer — from config/world/desks.yaml.
 * Tile ids index a tileset the viewer draws at runtime (no image assets): see packages/viewer/src/world/tileset.ts.
 * Usage: pnpm exec tsx scripts/gen-world.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desks = (YAML.parse(readFileSync(path.join(root, 'config/world/desks.yaml'), 'utf8')) as { desks: { id: string; x: number; y: number; room?: string }[] }).desks;

// Tile ids (1-based in Tiled; 0 = empty). Keep in sync with tileset.ts TILES.
export const T = { EMPTY: 0, GRASS: 1, PATH: 2, FLOOR: 3, WALL: 4, WALL_TOP: 5, DOOR: 6, DESK: 7, CHAIR: 8, TABLE: 9, WHITEBOARD: 10, PLANT: 11, KITCHEN: 12, NOTICE: 13, CARPET: 14, WINDOW: 15, TREE: 16, BENCH: 17, SIGN: 18 } as const;

const W = 72, H = 44;
const ground: number[] = new Array(W * H).fill(T.GRASS);
const walls: number[] = new Array(W * H).fill(T.EMPTY);
const furniture: number[] = new Array(W * H).fill(T.EMPTY);
const set = (layer: number[], x: number, y: number, v: number) => { if (x >= 0 && y >= 0 && x < W && y < H) layer[y * W + x] = v; };
const rect = (layer: number[], x0: number, y0: number, x1: number, y1: number, v: number) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(layer, x, y, v); };
const box = (x0: number, y0: number, x1: number, y1: number, floor: number) => { rect(ground, x0, y0, x1, y1, floor); for (let x = x0; x <= x1; x++) { set(walls, x, y0, T.WALL_TOP); set(walls, x, y1, T.WALL); } for (let y = y0; y <= y1; y++) { set(walls, x0, y, T.WALL); set(walls, x1, y, T.WALL); } };

// --- Office building: x 4..44, y 4..30 ---
box(4, 4, 44, 30, T.FLOOR);
// windows on the top wall
for (let x = 8; x < 44; x += 6) set(walls, x, 4, T.WINDOW);
// entrance door (bottom wall, centre)
set(walls, 24, 30, T.DOOR); set(walls, 25, 30, T.DOOR);
// interior rooms
box(30, 5, 44, 12, T.CARPET);            // CEO cabin (top right)
set(walls, 30, 9, T.DOOR);
box(30, 14, 44, 22, T.CARPET);           // board room
set(walls, 30, 18, T.DOOR);
for (let x = 33; x <= 41; x++) set(furniture, x, 15, T.WHITEBOARD);
rect(furniture, 34, 17, 40, 19, T.TABLE);
box(30, 23, 44, 29, T.FLOOR);            // meeting room
set(walls, 30, 26, T.DOOR);
rect(furniture, 34, 25, 39, 27, T.TABLE);
// kitchen (bottom left) and notice board (near door)
rect(furniture, 6, 26, 10, 27, T.KITCHEN);
set(furniture, 21, 29, T.NOTICE); set(furniture, 22, 29, T.NOTICE);
set(furniture, 12, 6, T.PLANT); set(furniture, 28, 6, T.PLANT); set(furniture, 6, 6, T.PLANT);
// cubicles: desk + chair at each desk anchor (chair one tile below), partition walls around 3×3
const objects: { id: number; name: string; type: string; x: number; y: number; width: number; height: number; properties?: { name: string; type: string; value: string | number }[] }[] = [];
let oid = 1;
const obj = (name: string, type: string, tx: number, ty: number, tw = 1, th = 1, props: Record<string, string | number> = {}) => objects.push({ id: oid++, name, type, x: tx * 16, y: ty * 16, width: tw * 16, height: th * 16, properties: Object.entries(props).map(([k, v]) => ({ name: k, type: typeof v === 'number' ? 'int' : 'string', value: v })) });
for (const d of desks) {
  if (d.room === 'cabin') { set(furniture, d.x, d.y, T.DESK); set(furniture, d.x, d.y + 1, T.CHAIR); obj(d.id, 'desk', d.x, d.y + 1, 1, 1, { room: 'cabin' }); continue; }
  set(furniture, d.x - 1, d.y - 1, T.WALL_TOP); set(furniture, d.x, d.y - 1, T.WALL_TOP); set(furniture, d.x + 1, d.y - 1, T.WALL_TOP);
  set(furniture, d.x - 1, d.y, T.WALL); set(furniture, d.x + 1, d.y, T.WALL);
  set(furniture, d.x, d.y, T.DESK); set(furniture, d.x, d.y + 1, T.CHAIR);
  obj(d.id, 'desk', d.x, d.y + 1);
}
// --- Courtyard / street anchors (outside) ---
rect(ground, 0, 31, W - 1, 33, T.PATH);                 // street in front
rect(ground, 24, 31, 25, 36, T.PATH);
for (let x = 2; x < W; x += 9) { set(furniture, x, 35, T.TREE); }
const place = (name: string, type: string, x: number, y: number, w: number, h: number, label: string) => { rect(ground, x, y, x + w - 1, y + h - 1, T.PATH); rect(walls, x, y, x + w - 1, y, T.WALL_TOP); for (let yy = y; yy < y + h; yy++) { set(walls, x, yy, T.WALL); set(walls, x + w - 1, yy, T.WALL); } rect(walls, x, y + h - 1, x + w - 1, y + h - 1, T.WALL); set(walls, x + Math.floor(w / 2), y + h - 1, T.DOOR); set(furniture, x + Math.floor(w / 2), y - 1, T.SIGN); obj(name, type, x, y, w, h, { label, stand_x: x + Math.floor(w / 2), stand_y: y + h }); };
place('billboard', 'surface', 48, 6, 10, 6, 'Billboard — live browser');
place('terminal', 'surface', 60, 6, 9, 6, 'Terminal shed — shell output');
place('postoffice', 'surface', 48, 14, 10, 6, 'Post office — mail & approvals');
place('newsstand', 'surface', 60, 14, 9, 6, 'Newsstand — briefs & decisions');
place('bank', 'surface', 48, 22, 10, 6, 'Bank — quota runway');
place('vault', 'surface', 60, 22, 9, 6, 'Vault — open in Obsidian');
place('workshop', 'surface', 8, 36, 14, 7, 'Workshop — site preview & deploys');
obj('door', 'anchor', 24, 31, 2, 1, { label: 'Entrance' });
obj('boardroom', 'room', 31, 15, 13, 7, { label: 'Board room' });
obj('meetingroom', 'room', 31, 24, 13, 5, { label: 'Meeting room' });
obj('cabin', 'room', 31, 6, 13, 6, { label: 'CEO cabin' });
obj('whiteboard', 'surface', 33, 15, 9, 1, { label: 'Whiteboard — Plans/plan.md' });
obj('noticeboard', 'surface', 21, 29, 2, 1, { label: 'Notice board — queue' });
obj('kitchen', 'room', 6, 26, 5, 2, { label: 'Kitchen' });
// seats in the board room and meeting room
const seats = { boardroom: [[33, 16], [35, 16], [37, 16], [39, 16], [41, 16], [33, 20], [35, 20], [37, 20], [39, 20], [41, 20]], meetingroom: [[33, 24], [35, 24], [37, 24], [39, 24], [33, 28], [35, 28], [37, 28], [39, 28]] };
for (const [room, list] of Object.entries(seats)) list.forEach(([x, y], i) => obj(`${room}_seat_${i + 1}`, 'seat', x, y, 1, 1, { room }));

const layer = (name: string, data: number[], visible = true) => ({ id: 0, name, type: 'tilelayer', width: W, height: H, x: 0, y: 0, opacity: 1, visible, data });
const map = {
  type: 'map', version: '1.10', tiledversion: 'cubicle-gen', orientation: 'orthogonal', renderorder: 'right-down', width: W, height: H, tilewidth: 16, tileheight: 16, infinite: false, nextlayerid: 5, nextobjectid: oid,
  tilesets: [{ firstgid: 1, name: 'office', tilewidth: 16, tileheight: 16, tilecount: 18, columns: 6, image: 'runtime:office', imagewidth: 96, imageheight: 48, margin: 0, spacing: 0 }],
  layers: [
    { ...layer('ground', ground), id: 1 },
    { ...layer('walls', walls), id: 2, properties: [{ name: 'collides', type: 'bool', value: true }] },
    { ...layer('furniture', furniture), id: 3, properties: [{ name: 'collides', type: 'bool', value: true }] },
    { id: 4, name: 'objects', type: 'objectgroup', visible: true, opacity: 1, x: 0, y: 0, draworder: 'topdown', objects },
  ],
  properties: [{ name: 'generated', type: 'string', value: 'scripts/gen-world.ts' }],
};
const out = path.join(root, 'config/world/office.json');
writeFileSync(out, JSON.stringify(map));
console.log(`wrote ${out}: ${W}×${H} tiles, ${objects.length} objects, ${desks.length} desks`);
