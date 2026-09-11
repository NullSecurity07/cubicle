import type { Anchor, Tile } from './map.js';
import type { AgentView } from '../state.js';

/** The room whose rectangle contains the tile, or null (corridors, street, shaft). */
export function roomContaining(rooms: Record<string, Anchor>, t: Tile): string | null {
  for (const r of Object.values(rooms)) if (t.tx >= r.tx && t.tx < r.tx + r.tw && t.ty >= r.ty && t.ty < r.ty + r.th) return r.name;
  return null;
}

/** Rooms with an agent inside them that is working or talking: the ones whose lamps are on at night. */
export function litRooms(agents: Record<string, AgentView>, sprites: Record<string, Tile>, rooms: Record<string, Anchor>): Set<string> {
  const lit = new Set<string>();
  for (const [role, v] of Object.entries(agents)) {
    if (v.state !== 'working' && v.state !== 'talking') continue;
    const t = sprites[role]; if (!t) continue;
    const r = roomContaining(rooms, t); if (r) lit.add(r);
  }
  return lit;
}
