import Phaser from 'phaser';
import EasyStar from 'easystarjs';
import { TILE } from './tileset.js';

export interface Anchor { name: string; type: string; tx: number; ty: number; tw: number; th: number; props: Record<string, string | number> }

export interface World {
  map: Phaser.Tilemaps.Tilemap;
  width: number; height: number;
  anchors: Record<string, Anchor>;
  seats: Record<string, { tx: number; ty: number }[]>;
  desks: Record<string, { tx: number; ty: number }>;
  grid: number[][]; // 0 walkable, 1 blocked
  finder: EasyStar.js;
  findPath(from: { tx: number; ty: number }, to: { tx: number; ty: number }): Promise<{ tx: number; ty: number }[] | null>;
  standTile(name: string): { tx: number; ty: number } | null;
}

export function buildWorld(scene: Phaser.Scene, mapKey = 'office'): World {
  const map = scene.make.tilemap({ key: mapKey });
  const tiles = map.addTilesetImage('office', 'office', TILE, TILE, 0, 0)!;
  const ground = map.createLayer('ground', tiles, 0, 0)!;
  const walls = map.createLayer('walls', tiles, 0, 0)!;
  const furniture = map.createLayer('furniture', tiles, 0, 0)!;
  ground.setDepth(0); walls.setDepth(1); furniture.setDepth(2);
  const grid: number[][] = [];
  for (let y = 0; y < map.height; y++) {
    const row: number[] = [];
    for (let x = 0; x < map.width; x++) {
      const w = walls.getTileAt(x, y)?.index ?? -1;
      const f = furniture.getTileAt(x, y)?.index ?? -1;
      const blocked = (w > 0 && w !== 6) || (f > 0 && f !== 8 && f !== 14); // doors (6) and chairs (8) walkable
      row.push(blocked ? 1 : 0);
    }
    grid.push(row);
  }
  const anchors: Record<string, Anchor> = {};
  const seats: Record<string, { tx: number; ty: number }[]> = {};
  const desks: Record<string, { tx: number; ty: number }> = {};
  const objLayer = map.getObjectLayer('objects');
  for (const o of objLayer?.objects ?? []) {
    const props: Record<string, string | number> = {};
    for (const p of (o.properties as { name: string; value: string | number }[] | undefined) ?? []) props[p.name] = p.value;
    const a: Anchor = { name: o.name, type: String(o.type ?? ''), tx: Math.round((o.x ?? 0) / TILE), ty: Math.round((o.y ?? 0) / TILE), tw: Math.round((o.width ?? TILE) / TILE), th: Math.round((o.height ?? TILE) / TILE), props };
    anchors[o.name] = a;
    if (a.type === 'seat') (seats[String(props.room)] ??= []).push({ tx: a.tx, ty: a.ty });
    if (a.type === 'desk') desks[o.name] = { tx: a.tx, ty: a.ty };
  }
  const finder = new EasyStar.js();
  finder.setGrid(grid);
  finder.setAcceptableTiles([0]);
  finder.enableDiagonals();
  finder.disableCornerCutting();
  const world: World = {
    map, width: map.width, height: map.height, anchors, seats, desks, grid, finder,
    findPath(from, to) {
      return new Promise((resolve) => {
        const clampT = (t: { tx: number; ty: number }) => ({ tx: Math.max(0, Math.min(map.width - 1, t.tx)), ty: Math.max(0, Math.min(map.height - 1, t.ty)) });
        const f = clampT(from), t = nearestWalkable(grid, clampT(to));
        if (!t) return resolve(null);
        finder.findPath(f.tx, f.ty, t.tx, t.ty, (p) => resolve(p ? p.map((n) => ({ tx: n.x, ty: n.y })) : null));
        finder.calculate();
      });
    },
    standTile(name) {
      if (name.startsWith('desk:')) { const d = desks[name.slice(5)]; return d ?? null; }
      const a = anchors[name];
      if (!a) return null;
      if (typeof a.props.stand_x === 'number') return { tx: Number(a.props.stand_x), ty: Number(a.props.stand_y) };
      return { tx: a.tx + Math.floor(a.tw / 2), ty: a.ty + a.th };
    },
  };
  return world;
}

export function nearestWalkable(grid: number[][], t: { tx: number; ty: number }, radius = 4): { tx: number; ty: number } | null {
  if (grid[t.ty]?.[t.tx] === 0) return t;
  for (let r = 1; r <= radius; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = t.tx + dx, y = t.ty + dy; if (grid[y]?.[x] === 0) return { tx: x, ty: y }; }
  return null;
}

export const toPx = (t: { tx: number; ty: number }) => ({ x: t.tx * TILE + TILE / 2, y: t.ty * TILE + TILE / 2 });
