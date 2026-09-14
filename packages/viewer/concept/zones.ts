/**
 * SP9 concept — the zone layout table.
 *
 * One open plan, 46 x 32 cells, no floors. The whole campus is data: a zone table, the desk rows in each zone, the
 * ten screens, the glass partitions, the planting and the walkways. Nothing here draws; `scene.ts` turns this into
 * props and people, which is what lets the real generator (`scripts/world/campus.ts`) emit the same shape as JSON
 * later without the renderer knowing the difference.
 *
 * Geography, reading the diamond with the grid origin at the top vertex:
 *
 *                        Board room · CEO's cabin · Meeting room · Operations      <- the back walls
 *                Pantry · Lobby · Research · Revenue floor
 *                        Dev studio · QA lab · Lounge
 */
import type { Facing, HairStyle, Pose } from './characters.js';
import type { Rect } from './iso.js';
import type { AccentName, OutfitName } from './palette.js';
import type { Axis } from './shapes.js';

export const CAMPUS = { w: 46, h: 32, wall: 0.55 };

export interface Zone {
  id: string;
  label: string;
  accent: AccentName;
  rect: Rect;
  /** where the zone plate sits, as a fraction of the rect; the default is its middle */
  labelAt?: { fx: number; fy: number };
}

/**
 * Every zone plate sits on the zone's *lower* edge, where the walkways are. The screens name themselves above the
 * panels along the zones' upper edges, so the two families of label never queue for the same pixels.
 */
const PLATE = { fx: 0.3, fy: 1.03 };

export const ZONES: Zone[] = [
  { id: 'board', label: 'Board room', accent: 'slate', rect: { x0: 3, y0: 1.6, x1: 15, y1: 10 }, labelAt: PLATE },
  { id: 'cabin', label: 'CEO’s cabin', accent: 'slate', rect: { x0: 16.5, y0: 1.6, x1: 24, y1: 8 }, labelAt: { fx: 0.02, fy: 0.52 } },
  { id: 'meeting', label: 'Meeting room', accent: 'slate', rect: { x0: 25.5, y0: 1.6, x1: 32.5, y1: 7.5 }, labelAt: PLATE },
  { id: 'ops', label: 'Operations', accent: 'sage', rect: { x0: 35, y0: 1.6, x1: 44.5, y1: 12 }, labelAt: { fx: 0.06, fy: 1.04 } },
  { id: 'lobby', label: 'Lobby', accent: 'neutral', rect: { x0: 16, y0: 10.5, x1: 25, y1: 18 }, labelAt: { fx: 0.05, fy: 0.66 } },
  { id: 'pantry', label: 'Pantry', accent: 'neutral', rect: { x0: 3.5, y0: 12.5, x1: 14, y1: 19.5 }, labelAt: { fx: 0.06, fy: 0.72 } },
  { id: 'research', label: 'Research', accent: 'indigo', rect: { x0: 26.5, y0: 10, x1: 34, y1: 19.6 }, labelAt: PLATE },
  { id: 'sales', label: 'Revenue floor', accent: 'amber', rect: { x0: 35.5, y0: 14.5, x1: 44.5, y1: 30 }, labelAt: { fx: 0.28, fy: 1.02 } },
  { id: 'dev', label: 'Dev studio', accent: 'indigo', rect: { x0: 3, y0: 22, x1: 15, y1: 30.5 }, labelAt: PLATE },
  { id: 'qa', label: 'QA lab', accent: 'indigo', rect: { x0: 16.5, y0: 21, x1: 25.5, y1: 30.5 }, labelAt: PLATE },
  { id: 'lounge', label: 'Lounge', accent: 'neutral', rect: { x0: 27, y0: 22.5, x1: 34, y1: 30.5 }, labelAt: PLATE },
];

export const zoneOf = (id: string): Zone => {
  const z = ZONES.find((q) => q.id === id);
  if (!z) throw new Error(`no zone ${id}`);
  return z;
};

/** The zone rail, in the spec's own order. */
export const RAIL: { id: string; label: string; accent: AccentName }[] = [
  { id: 'board', label: 'Executive', accent: 'slate' },
  { id: 'pantry', label: 'Pantry', accent: 'neutral' },
  { id: 'dev', label: 'Dev', accent: 'indigo' },
  { id: 'qa', label: 'QA', accent: 'indigo' },
  { id: 'research', label: 'Research', accent: 'indigo' },
  { id: 'sales', label: 'Sales', accent: 'amber' },
  { id: 'ops', label: 'Ops', accent: 'sage' },
];

/* --------------------------------------------------------------------------------------------------------------- */
/* walkways                                                                                                        */
/* --------------------------------------------------------------------------------------------------------------- */

/** The paths agents walk. They run in the gaps the zone table already leaves, so nothing is ever laid over a zone. */
export const PATHS: Rect[] = [
  { x0: 15.15, y0: 1.6, x1: 16.4, y1: 31 },      // the long spine, top to bottom
  { x0: 34.35, y0: 1.6, x1: 35.45, y1: 31 },     // the spine on the revenue side
  { x0: 2.4, y0: 10.2, x1: 15.3, y1: 11.7 },     // board room to the pantry
  { x0: 16.3, y0: 8.3, x1: 34.5, y1: 10.1 },     // under the executive suite
  { x0: 2.4, y0: 19.9, x1: 34.5, y1: 20.9 },     // the studio cross-walk
  { x0: 35.4, y0: 12.4, x1: 45.2, y1: 14 },      // ops to revenue
  { x0: 16.3, y0: 18.1, x1: 25.6, y1: 20.9 },    // the lobby's throat
];

/* --------------------------------------------------------------------------------------------------------------- */
/* people                                                                                                          */
/* --------------------------------------------------------------------------------------------------------------- */

export interface Body {
  id: string;
  x: number; y: number;
  pose: Pose;
  facing: Facing;
  outfit: OutfitName;
  style?: HairStyle;
  glasses?: boolean;
  tag?: string;
  /** a line over their head, at room zoom */
  says?: string[];
}

export interface DeskEntry {
  x: number; y: number;
  w?: number; d?: number;
  accent: AccentName;
  side?: 'far' | 'near';
  label?: string;
  lamp?: boolean;
  papers?: boolean;
}

const DESK_W = 2.5, DESK_D = 1.3, PITCH = 2.95;
const FAR: Facing[] = ['se', 'sw'];
const NEAR: Facing[] = ['nw', 'ne'];

/**
 * A row of desks with someone at each. `side: 'far'` seats them on the low-y side, so they face the camera and their
 * monitors turn away; `'near'` puts their backs to us and their screens in view. A real floor has both.
 */
export function deskRow(o: {
  id: string; x: number; y: number; n: number; accent: AccentName;
  side?: 'far' | 'near'; outfits: OutfitName[]; labels?: string[]; lamp?: boolean; papers?: boolean; styles?: HairStyle[];
}): { desks: DeskEntry[]; bodies: Body[] } {
  const side = o.side ?? 'far';
  const desks: DeskEntry[] = [];
  const bodies: Body[] = [];
  for (let i = 0; i < o.n; i++) {
    const x = o.x + i * PITCH;
    desks.push({ x, y: o.y, accent: o.accent, side, label: o.labels?.[i], lamp: o.lamp, papers: o.papers && i === 0 });
    bodies.push({
      id: `${o.id}-${i}`,
      x: x + DESK_W / 2 - 0.1,
      y: side === 'far' ? o.y - 0.92 : o.y + DESK_D + 0.92,
      pose: 'sit',
      facing: (side === 'far' ? FAR : NEAR)[i % 2],
      outfit: o.outfits[i % o.outfits.length],
      style: o.styles?.[i % o.styles.length],
    });
  }
  return { desks, bodies };
}

const rows = [
  deskRow({ id: 'dev-a', x: 4.0, y: 24.0, n: 3, accent: 'indigo', outfits: ['maker', 'member', 'maker'], labels: ['Ada', 'Ravi', 'Ines'], lamp: true }),
  deskRow({ id: 'dev-b', x: 4.0, y: 28.3, n: 3, accent: 'indigo', outfits: ['member', 'manager', 'maker'], labels: ['Tom', 'Ling', 'Joon'], papers: true, lamp: true }),
  deskRow({ id: 'qa-a', x: 17.5, y: 23.4, n: 2, accent: 'indigo', outfits: ['member', 'maker'], labels: ['Nia', 'Piet'], lamp: true }),
  deskRow({ id: 'qa-b', x: 17.5, y: 27.6, n: 2, accent: 'indigo', side: 'near', outfits: ['maker', 'member'] }),
  deskRow({ id: 'res-a', x: 27.4, y: 12.6, n: 2, accent: 'indigo', outfits: ['advisor', 'member'], labels: ['Mira', 'Ozan'], lamp: true }),
  deskRow({ id: 'res-b', x: 27.4, y: 16.4, n: 2, accent: 'indigo', outfits: ['member', 'advisor'] }),
  deskRow({ id: 'sales-a', x: 37.0, y: 17.6, n: 2, accent: 'amber', outfits: ['seller', 'member'], labels: ['Dara', 'Yuki'], lamp: true }),
  deskRow({ id: 'sales-b', x: 37.0, y: 21.0, n: 2, accent: 'amber', side: 'near', outfits: ['seller', 'seller'] }),
  deskRow({ id: 'sales-c', x: 37.0, y: 26.4, n: 2, accent: 'amber', outfits: ['member', 'seller'], labels: ['Ivo', 'Hana'], lamp: true }),
  deskRow({ id: 'ops-a', x: 37.5, y: 4.4, n: 2, accent: 'sage', outfits: ['chief', 'advisor'], labels: ['COO', 'CFO'], lamp: true }),
  deskRow({ id: 'ops-b', x: 37.5, y: 8.6, n: 2, accent: 'sage', outfits: ['chief', 'advisor'], labels: ['CISO', 'CTO'], lamp: true }),
  deskRow({ id: 'cabin', x: 18.4, y: 4.6, n: 1, accent: 'slate', outfits: ['chief'], labels: ['CEO'], lamp: true, papers: true }),
];

export const DESKS: DeskEntry[] = rows.flatMap((r) => r.desks);

/** Everyone who is not at a desk: the board table, the pantry, the lobby and the four on the move. */
export const STANDING: Body[] = [
  // the board table, mid-argument
  { id: 'b1', x: 6.7, y: 3.7, pose: 'sit', facing: 'se', outfit: 'chief', style: 'short', glasses: true, tag: '#6B788F', says: ['We ship the viewer first.'] },
  { id: 'b2', x: 9.1, y: 3.6, pose: 'sit', facing: 'sw', outfit: 'advisor', style: 'bun' },
  { id: 'b3', x: 11.5, y: 3.7, pose: 'sit', facing: 'sw', outfit: 'manager', style: 'curls', says: ['Not before the ledger balances.'] },
  { id: 'b4', x: 7.9, y: 7.9, pose: 'sit', facing: 'nw', outfit: 'member', style: 'bob' },
  { id: 'b5', x: 10.4, y: 7.9, pose: 'sit', facing: 'ne', outfit: 'seller', style: 'ponytail', says: ['Revenue says yes.'] },
  // the meeting room
  { id: 'm1', x: 27.8, y: 2.9, pose: 'sit', facing: 'se', outfit: 'member', style: 'long' },
  { id: 'm2', x: 30.2, y: 2.9, pose: 'sit', facing: 'sw', outfit: 'manager', style: 'crop', glasses: true },
  { id: 'm3', x: 29.0, y: 6.0, pose: 'sit', facing: 'nw', outfit: 'advisor', style: 'bald' },
  // the pantry counter
  { id: 'p1', x: 6.4, y: 15.6, pose: 'lean', facing: 'se', outfit: 'maker', style: 'bob', says: ['Third build today.'] },
  { id: 'p2', x: 8.5, y: 15.9, pose: 'lean', facing: 'sw', outfit: 'member', style: 'crop', glasses: true },
  // the lobby, and the post office
  { id: 'l1', x: 19.4, y: 14.6, pose: 'stand', facing: 'se', outfit: 'owner', style: 'short', tag: '#C97B5A' },
  { id: 'l2', x: 21.6, y: 15.6, pose: 'stand', facing: 'sw', outfit: 'member', style: 'ponytail' },
  { id: 's3', x: 36.9, y: 19.6, pose: 'stand', facing: 'sw', outfit: 'seller', style: 'bun' },
  { id: 'lg1', x: 30.0, y: 26.4, pose: 'stand', facing: 'sw', outfit: 'member', style: 'curls' },
  { id: 'lg2', x: 31.6, y: 27.6, pose: 'sit', facing: 'nw', outfit: 'maker', style: 'crop' },
  // on the move, along the walkways
  { id: 'w1', x: 15.75, y: 13.2, pose: 'walk', facing: 'se', outfit: 'manager', style: 'crop' },
  { id: 'w2', x: 15.75, y: 21.8, pose: 'walk', facing: 'nw', outfit: 'member', style: 'long' },
  { id: 'w3', x: 24.0, y: 9.2, pose: 'walk', facing: 'se', outfit: 'advisor', style: 'bald', glasses: true },
  { id: 'w4', x: 34.9, y: 17.5, pose: 'walk', facing: 'nw', outfit: 'seller', style: 'short' },
  { id: 'w5', x: 22.4, y: 20.4, pose: 'walk', facing: 'sw', outfit: 'maker', style: 'ponytail' },
  { id: 'w6', x: 8.2, y: 10.9, pose: 'walk', facing: 'se', outfit: 'member', style: 'bob' },
];

export const BODIES: Body[] = [...rows.flatMap((r) => r.bodies), ...STANDING];

/* --------------------------------------------------------------------------------------------------------------- */
/* the ten screens                                                                                                 */
/* --------------------------------------------------------------------------------------------------------------- */

export interface ScreenEntry {
  id: string; name: string; line: string;
  x: number; y: number; axis: Axis; len: number; z: number; h: number;
  accent: AccentName;
  kind?: 'screen' | 'board' | 'paper';
  plateBelow?: boolean;
  pier?: boolean;
}

export const SCREENS: ScreenEntry[] = [
  // on the board room's own side wall, not the curtain wall: against the window it fought both the sunset and the
  // speech bubbles of the five people sitting under it.
  { id: 'whiteboard', name: 'Whiteboard', line: 'Q3 — ship the viewer', x: 3.02, y: 3.1, axis: 'y', len: 5.2, z: 0.66, h: 1.74, accent: 'slate', kind: 'board' },
  { id: 'cabin', name: 'Cabin', line: 'pricing — your call', x: 19.6, y: 1.62, axis: 'x', len: 4.0, z: 0.76, h: 1.56, accent: 'slate', pier: false },
  { id: 'noticeboard', name: 'Notice board', line: '6 jobs · 2 blocked', x: 17.6, y: 10.52, axis: 'x', len: 4.2, z: 0.7, h: 1.56, accent: 'neutral', kind: 'paper' },
  { id: 'terminal', name: 'Terminal', line: '$ pnpm test · 128 ok', x: 5.5, y: 22.02, axis: 'x', len: 4.6, z: 0.82, h: 1.64, accent: 'indigo' },
  { id: 'workshop', name: 'Workshop', line: 'build #412 — green', x: 18.0, y: 21.02, axis: 'x', len: 4.2, z: 0.82, h: 1.56, accent: 'indigo' },
  { id: 'bank', name: 'Bank', line: 'balance ₹412,900', x: 35.02, y: 2.3, axis: 'y', len: 3.6, z: 0.76, h: 1.5, accent: 'sage' },
  { id: 'vault', name: 'Vault', line: '2 keys · rotated 12d', x: 35.02, y: 7.4, axis: 'y', len: 3.4, z: 0.76, h: 1.5, accent: 'sage' },
  { id: 'billboard', name: 'Billboard', line: 'campaign: quiet office', x: 40.5, y: 14.52, axis: 'x', len: 3.9, z: 0.9, h: 1.78, accent: 'amber' },
  { id: 'postoffice', name: 'Post office', line: '3 proposals waiting', x: 35.52, y: 15.5, axis: 'y', len: 3.8, z: 0.74, h: 1.58, accent: 'amber' },
  { id: 'newsstand', name: 'Newsstand', line: 'today’s brief is out', x: 35.52, y: 21.6, axis: 'y', len: 3.4, z: 0.7, h: 1.44, accent: 'amber', kind: 'paper' },
];

/* --------------------------------------------------------------------------------------------------------------- */
/* partitions, planting, the rest of the furniture                                                                 */
/* --------------------------------------------------------------------------------------------------------------- */

export interface PartitionEntry { x: number; y: number; axis: Axis; len: number; h?: number; accent: AccentName }

/** Glass, not walls: every run is partial, so the plan stays open and the eye crosses every boundary. */
export const PARTITIONS: PartitionEntry[] = [
  { x: 3, y: 10, axis: 'x', len: 5.4, accent: 'slate' },
  { x: 10.4, y: 10, axis: 'x', len: 4.6, accent: 'slate' },
  { x: 15, y: 1.9, axis: 'y', len: 8.1, accent: 'slate' },
  { x: 16.5, y: 8, axis: 'x', len: 3.1, accent: 'slate' },
  { x: 21.3, y: 8, axis: 'x', len: 2.7, accent: 'slate' },
  { x: 24, y: 1.9, axis: 'y', len: 6.1, accent: 'slate' },
  { x: 25.5, y: 7.5, axis: 'x', len: 7, accent: 'slate' },
  { x: 32.5, y: 1.9, axis: 'y', len: 5.6, accent: 'slate' },
  { x: 35, y: 11.2, axis: 'y', len: 0.8, accent: 'sage' },
  { x: 35, y: 12, axis: 'x', len: 5.2, accent: 'sage' },
  { x: 26.5, y: 10.4, axis: 'y', len: 9.2, accent: 'indigo' },
  { x: 26.5, y: 19.6, axis: 'x', len: 7.5, accent: 'indigo' },
  { x: 35.5, y: 19.6, axis: 'y', len: 1.8, accent: 'amber' },
  { x: 35.5, y: 25.2, axis: 'y', len: 4.4, accent: 'amber' },
  { x: 3, y: 22, axis: 'x', len: 2.3, accent: 'indigo' },
  { x: 10.2, y: 22, axis: 'x', len: 4.8, accent: 'indigo' },
  { x: 16.5, y: 21, axis: 'x', len: 1.4, accent: 'indigo' },
  { x: 22.3, y: 21, axis: 'x', len: 3.2, accent: 'indigo' },
  { x: 3.5, y: 12.5, axis: 'x', len: 1.3, accent: 'neutral' },
  { x: 10.2, y: 12.5, axis: 'x', len: 3.8, accent: 'neutral' },
  { x: 16, y: 10.9, axis: 'y', len: 6.9, accent: 'neutral' },
];

export interface PlantEntry { x: number; y: number; size?: number }
export const PLANTS: PlantEntry[] = [
  { x: 2.2, y: 9.2, size: 1.25 }, { x: 15.7, y: 10.8, size: 1.1 }, { x: 15.7, y: 2.6, size: 0.95 },
  { x: 24.7, y: 8.7, size: 1.15 }, { x: 33.2, y: 8.6, size: 1.0 }, { x: 34.9, y: 13.2, size: 1.2 },
  { x: 25.9, y: 20.3, size: 1.1 }, { x: 15.8, y: 20.4, size: 1.15 }, { x: 2.3, y: 20.5, size: 1.05 },
  { x: 2.4, y: 30.9, size: 1.2 }, { x: 15.6, y: 30.4, size: 1.0 }, { x: 26.2, y: 30.6, size: 1.1 },
  { x: 44.9, y: 13.1, size: 1.0 }, { x: 44.9, y: 26.6, size: 1.2 }, { x: 34.6, y: 26.8, size: 0.95 },
  { x: 13.3, y: 11.1, size: 0.9 }, { x: 12.2, y: 3.1, size: 1.3 }, { x: 4.1, y: 12.9, size: 1.15 }, { x: 20.1, y: 17.2, size: 1.25 }, { x: 4.4, y: 20.6, size: 0.9 },
  { x: 28.4, y: 21.4, size: 1.0 }, { x: 44.8, y: 2.6, size: 1.1 },
  // the walk round the southern edge of the plate: planting, so the margin reads as a margin and not as a blank
  { x: 8.4, y: 31.2, size: 1.15 }, { x: 20.6, y: 31.3, size: 1.05 }, { x: 31.4, y: 31.2, size: 1.2 },
  { x: 39.2, y: 31.1, size: 1.0 }, { x: 1.6, y: 24.4, size: 1.1 }, { x: 1.7, y: 16.2, size: 0.95 },
];

export interface ShelfEntry { x: number; y: number; w?: number; accent: AccentName }
export const SHELVES: ShelfEntry[] = [
  { x: 3.4, y: 25.4, w: 0, accent: 'indigo' },       // w: 0 means "use the default"
  { x: 12.6, y: 23.2, w: 2.1, accent: 'indigo' },
  { x: 23.1, y: 24.4, w: 2.0, accent: 'indigo' },
  { x: 27.6, y: 17.9, w: 2.4, accent: 'indigo' },
  { x: 41.7, y: 17.0, w: 2.4, accent: 'amber' },
  { x: 41.5, y: 5.0, w: 2.6, accent: 'sage' },
  { x: 21.2, y: 2.3, w: 2.3, accent: 'slate' },
  { x: 10.6, y: 12.9, w: 3.0, accent: 'neutral' },
  { x: 5.4, y: 8.7, w: 4.2, accent: 'slate' },
  { x: 3.7, y: 16.6, w: 0, accent: 'neutral' },
  { x: 30.6, y: 23.3, w: 2.4, accent: 'neutral' },
  { x: 17.2, y: 15.4, w: 3.4, accent: 'neutral' },   // the lobby's credenza, under the notice board
];

/** The board table, the meeting table, the pantry counter and the lounge bench. */
export const TABLES: { id: string; rect: Rect; kind: 'board' | 'counter' }[] = [
  { id: 'board-table', rect: { x0: 5.6, y0: 4.6, x1: 12.6, y1: 7.0 }, kind: 'board' },
  { id: 'meeting-table', rect: { x0: 27.4, y0: 3.9, x1: 31.2, y1: 5.5 }, kind: 'board' },
  { id: 'pantry-counter', rect: { x0: 5.0, y0: 13.7, x1: 9.8, y1: 14.9 }, kind: 'counter' },
  { id: 'lounge-bench', rect: { x0: 28.2, y0: 27.4, x1: 32.6, y1: 28.5 }, kind: 'counter' },
];

export const STOOLS: { x: number; y: number; colour?: string }[] = [
  { x: 5.0, y: 17.0 }, { x: 6.5, y: 17.6 }, { x: 8.4, y: 17.2 }, { x: 9.9, y: 17.8 },
  { x: 11.9, y: 16.2 }, { x: 12.6, y: 17.9 }, { x: 19.0, y: 12.9 }, { x: 22.2, y: 13.2 },
  { x: 29.6, y: 25.6 }, { x: 31.4, y: 25.2 },
];

/** The high tables the pantry stools belong to, and the two the lobby keeps for waiting. */
export const HIGH_TABLES: { x: number; y: number }[] = [
  { x: 5.75, y: 17.3 }, { x: 9.15, y: 17.5 }, { x: 12.25, y: 17.05 }, { x: 20.6, y: 13.05 }, { x: 30.5, y: 25.4 },
];

/** Floor lamps: the warm points a dusk campus needs, and the one lamp the room shot is asked for. */
export const FLOOR_LAMPS: { x: number; y: number }[] = [
  { x: 13.2, y: 8.6 }, { x: 3.9, y: 14.0 }, { x: 24.2, y: 16.6 }, { x: 33.0, y: 28.6 }, { x: 43.6, y: 15.6 },
];

/** Chairs that belong to a table rather than a desk: the board room, the meeting room. */
export const LOOSE_CHAIRS: { x: number; y: number; facing: Facing }[] = [
  { x: 6.35, y: 3.35, facing: 'se' }, { x: 8.75, y: 3.25, facing: 'sw' }, { x: 11.15, y: 3.35, facing: 'sw' },
  { x: 7.55, y: 7.55, facing: 'nw' }, { x: 10.05, y: 7.55, facing: 'ne' }, { x: 13.1, y: 5.5, facing: 'sw' },
  { x: 27.45, y: 2.55, facing: 'se' }, { x: 29.85, y: 2.55, facing: 'sw' }, { x: 28.65, y: 5.65, facing: 'nw' },
];
