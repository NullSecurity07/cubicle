/**
 * The campus: one open plan on a single isometric grid, 52 × 36 cells, no floors.
 *
 * This replaces scripts/world/tower.ts as the source of config/world/office.json and config/world/desks.yaml.
 * Nothing here draws; it emits the same Tiled-shaped JSON the viewer has always read, with the tower's stack of
 * floors collapsed into zones on one plane: every `floor` property is 1, there is no shaft, no portal and no slab.
 *
 * Geography, reading the diamond with the grid origin at the top vertex (x runs to the lower-right on screen, y to
 * the lower-left, so small x and small y are the two back walls):
 *
 *      Board room · CEO's cabin · Meeting room ·············· Operations (the eight C-suite desks)
 *          Pantry ····· Lobby ····· Research ················ Revenue floor
 *      Dev studio · QA lab ····· Lounge
 *
 * Coordinates are cells and may be fractional — a desk pitch is 2.95 cells, not a whole number of them — so object
 * positions are written as `cell * TILE` without rounding and read back the same way. The collision grid is one
 * cell per entry: agents path on it and then ease the last step onto the exact fractional seat.
 */

export const W = 52, H = 36, TILE = 16;
/**
 * Sub-cells to the cell in the collision grid. A desk pitch is 2.95 cells and a corridor between two partitions is
 * a little over one, so one entry per cell cannot tell a wall from the walkway beside it; two can.
 */
export const WALK = 2;
export const GW = W * WALK, GH = H * WALK;
/** The curtain wall's thickness, in cells: the two back walls stand at x = 0..WALL and y = 0..WALL. */
export const WALL = 0.55;

export type AccentName = 'indigo' | 'sage' | 'amber' | 'slate' | 'neutral';
export type Axis = 'x' | 'y';
export interface Rect { x0: number; y0: number; x1: number; y1: number }

/* ---------------------------------------------------------------------------------------------------------- */
/* the zone table                                                                                              */
/* ---------------------------------------------------------------------------------------------------------- */

export interface ZoneSpec {
  id: string; label: string; accent: AccentName; rect: Rect;
  /** where a sprite sent to this zone by name stands: always on a walkway, never inside the furniture */
  stand: { x: number; y: number };
  /** the zone rail, in the spec's order; a zone with no rail entry (the lobby, the lounge) is still a place */
  rail?: { label: string; order: number };
  /** where the zone plate hangs, as a fraction of the rect */
  plate?: { fx: number; fy: number };
}

const PLATE = { fx: 0.3, fy: 1.02 };

export const ZONES: ZoneSpec[] = [
  { id: 'boardroom', label: 'Board room', accent: 'slate', rect: { x0: 2.6, y0: 1.6, x1: 15.2, y1: 11.0 }, stand: { x: 8.9, y: 12.0 }, rail: { label: 'Executive', order: 1 }, plate: PLATE },
  { id: 'ceo_office', label: 'CEO’s cabin', accent: 'slate', rect: { x0: 16.6, y0: 1.6, x1: 24.2, y1: 9.0 }, stand: { x: 20.4, y: 9.8 }, plate: { fx: 0.04, fy: 0.56 } },
  { id: 'meetingroom', label: 'Meeting room', accent: 'slate', rect: { x0: 25.4, y0: 1.6, x1: 32.8, y1: 8.2 }, stand: { x: 29.0, y: 9.8 }, plate: PLATE },
  { id: 'ops', label: 'Operations', accent: 'sage', rect: { x0: 35.4, y0: 1.6, x1: 49.8, y1: 14.2 }, stand: { x: 42.0, y: 15.4 }, rail: { label: 'Ops', order: 7 }, plate: { fx: 0.08, fy: 1.03 } },
  { id: 'lobby', label: 'Lobby', accent: 'neutral', rect: { x0: 16.6, y0: 10.6, x1: 25.4, y1: 19.2 }, stand: { x: 21.2, y: 17.4 }, plate: { fx: 0.06, fy: 0.7 } },
  { id: 'pantry', label: 'Pantry', accent: 'neutral', rect: { x0: 2.6, y0: 13.2, x1: 14.6, y1: 20.4 }, stand: { x: 8.0, y: 21.4 }, rail: { label: 'Pantry', order: 2 }, plate: { fx: 0.06, fy: 0.74 } },
  { id: 'research', label: 'Research', accent: 'indigo', rect: { x0: 26.4, y0: 10.0, x1: 33.6, y1: 20.4 }, stand: { x: 30.0, y: 21.4 }, rail: { label: 'Research', order: 5 }, plate: PLATE },
  { id: 'sales', label: 'Revenue floor', accent: 'amber', rect: { x0: 35.4, y0: 16.6, x1: 49.8, y1: 33.8 }, stand: { x: 43.4, y: 25.2 }, rail: { label: 'Sales', order: 6 }, plate: { fx: 0.26, fy: 1.02 } },
  { id: 'dev', label: 'Dev studio', accent: 'indigo', rect: { x0: 2.6, y0: 22.6, x1: 15.2, y1: 34.0 }, stand: { x: 9.0, y: 21.4 }, rail: { label: 'Dev', order: 3 }, plate: PLATE },
  { id: 'qa', label: 'QA lab', accent: 'indigo', rect: { x0: 16.6, y0: 22.6, x1: 25.4, y1: 34.0 }, stand: { x: 21.0, y: 21.4 }, rail: { label: 'QA', order: 4 }, plate: PLATE },
  { id: 'lounge', label: 'Lounge', accent: 'neutral', rect: { x0: 27.6, y0: 24.6, x1: 33.6, y1: 33.8 }, stand: { x: 30.0, y: 31.4 }, plate: PLATE },
];

/**
 * The rooms the daemon and the owner's vault name.
 *
 * Nine of them are zones in their own right. The eight C-suite offices are not rooms with walls any more — they are
 * desks along the Operations zone's two rows — but their ids still appear in `vault-template/Teams/*.md` (`room:
 * cto_office`) and in anything the owner types, so each keeps a small anchor around its own desk. Losing them would
 * make `focusOn('cfo_office')` a no-op and `freeDesk` blind to the office it is asked about.
 */
export interface RoomSpec { id: string; label: string; zone: string; rect: Rect; accent: AccentName; stand: { x: number; y: number } }

/* ---------------------------------------------------------------------------------------------------------- */
/* desks                                                                                                       */
/* ---------------------------------------------------------------------------------------------------------- */

export const DESK_W = 2.5, DESK_D = 1.3, PITCH = 2.95;

export interface DeskSpec {
  id: string; x: number; y: number; room: string; zone: string; slot: 'fixed' | 'member';
  w?: number; d?: number; accent: AccentName;
  /** which side the occupant sits on: `far` faces the camera, `near` turns their back and shows their screen */
  side: 'far' | 'near';
  lamp?: boolean; papers?: boolean;
}

/** Where the person at a desk sits: in front of it on their own side, on the desk's centre line. */
export function seatOf(d: DeskSpec): { x: number; y: number } {
  const w = d.w ?? DESK_W, dd = d.d ?? DESK_D;
  return { x: round2(d.x + w / 2 - 0.1), y: round2(d.side === 'far' ? d.y - 0.94 : d.y + dd + 0.94) };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** A row of desks: `n` ids from `x` at the standard pitch, all on the same side of the same row. */
function row(o: { ids: string[]; x: number; y: number; room: string; zone: string; accent: AccentName; side?: 'far' | 'near'; slot?: (i: number) => 'fixed' | 'member'; w?: number; lamp?: boolean }): DeskSpec[] {
  return o.ids.map((id, i) => ({
    id, x: round2(o.x + i * PITCH), y: o.y, room: o.room, zone: o.zone, accent: o.accent,
    side: o.side ?? 'far', slot: o.slot ? o.slot(i) : 'member',
    ...(o.w ? { w: o.w } : {}),
    ...(o.lamp === false ? {} : { lamp: i % 2 === 0 }),
  }));
}

const fixedFirst = (i: number): 'fixed' | 'member' => (i === 0 ? 'fixed' : 'member');
const allFixed = (): 'fixed' => 'fixed';

/** The Operations rows: four C-suite desks against the back wall, four more behind the screen band. */
const OPS_X = [36.2, 39.15, 42.1, 45.05];
const OPS_ROW_A = ['cfo', 'ciso', 'cmo', 'cto'];
const OPS_ROW_B = ['coo', 'chro', 'clo', 'cgo'];

export const DESKS: DeskSpec[] = [
  // the cabin
  { id: 'ceo', x: 18.4, y: 4.6, w: 2.8, room: 'ceo_office', zone: 'ceo_office', accent: 'slate', side: 'far', slot: 'fixed', lamp: true, papers: true },
  // the board room: the three advisors sit at their own desks under the table
  ...row({ ids: ['advisor_skeptic', 'advisor_investor', 'advisor_customer'], x: 3.4, y: 8.6, room: 'boardroom', zone: 'boardroom', accent: 'slate', slot: allFixed }),
  // Operations: the C-suite, in two rows
  ...OPS_ROW_A.map((id, i) => ({ id, x: OPS_X[i], y: 3.4, room: `${id}_office`, zone: 'ops', accent: 'sage' as const, side: 'far' as const, slot: 'fixed' as const, lamp: true })),
  ...OPS_ROW_B.map((id, i) => ({ id, x: OPS_X[i], y: 9.8, room: `${id}_office`, zone: 'ops', accent: 'sage' as const, side: 'far' as const, slot: 'fixed' as const, lamp: i % 2 === 0 })),
  // Research: three rows of two
  ...row({ ids: ['research_manager', 'researcher'], x: 27.0, y: 12.0, room: 'research', zone: 'research', accent: 'indigo', slot: fixedFirst }),
  ...row({ ids: ['research_analyst', 'data_scientist'], x: 27.0, y: 15.2, room: 'research', zone: 'research', accent: 'indigo' }),
  ...row({ ids: ['intelligence_analyst', 'research_engineer'], x: 27.0, y: 18.4, room: 'research', zone: 'research', accent: 'indigo' }),
  // the Dev studio: one row facing the camera, one with its back to us so the code on the screens reads
  ...row({ ids: ['dev_manager', 'product_manager', 'product_designer', 'backend_engineer'], x: 3.4, y: 25.0, room: 'dev', zone: 'dev', accent: 'indigo', slot: fixedFirst }),
  ...row({ ids: ['frontend_engineer', 'fullstack_engineer', 'platform_engineer', 'sre'], x: 3.4, y: 30.2, room: 'dev', zone: 'dev', accent: 'indigo', side: 'near' }),
  // the QA lab: three rows of two
  ...row({ ids: ['qa_lead', 'qa_automation'], x: 17.6, y: 24.6, room: 'qa', zone: 'qa', accent: 'indigo', slot: fixedFirst }),
  ...row({ ids: ['qa_exploratory', 'qa_performance'], x: 17.6, y: 28.2, room: 'qa', zone: 'qa', accent: 'indigo' }),
  ...row({ ids: ['qa_security', 'qa_release'], x: 17.6, y: 31.8, room: 'qa', zone: 'qa', accent: 'indigo' }),
  // the Revenue floor
  { id: 'cso', x: 36.4, y: 18.4, w: 2.8, room: 'sales', zone: 'sales', accent: 'amber', side: 'far', slot: 'fixed', lamp: true },
  ...row({ ids: ['sales_1', 'sales_2', 'sales_3'], x: 36.4, y: 22.6, room: 'sales', zone: 'sales', accent: 'amber' }),
  ...row({ ids: ['sales_4', 'sales_5'], x: 36.4, y: 27.0, room: 'sales', zone: 'sales', accent: 'amber', side: 'near' }),
];

export const ROOMS: RoomSpec[] = [
  ...ZONES.map((z) => ({
    id: z.id, label: z.label, zone: z.id, rect: z.rect, accent: z.accent, stand: z.stand,
  })),
  // the eight C-suite offices: an anchor the size of the desk they became
  ...[...OPS_ROW_A, ...OPS_ROW_B].map((id) => {
    const d = DESKS.find((q) => q.id === id)!;
    const w = d.w ?? DESK_W, dd = d.d ?? DESK_D;
    const s = seatOf(d);
    return {
      id: `${id}_office`, label: `${id.toUpperCase()} office`, zone: 'ops', accent: 'sage' as const,
      rect: { x0: round2(d.x - 0.5), y0: round2(d.y - 1.6), x1: round2(d.x + w + 0.5), y1: round2(d.y + dd + 0.5) },
      stand: s,
    };
  }),
];

/* ---------------------------------------------------------------------------------------------------------- */
/* seats: the board table, the meeting table, the pantry                                                       */
/* ---------------------------------------------------------------------------------------------------------- */

export interface SeatSpec { id: string; x: number; y: number; room: string; facing: 'se' | 'sw' | 'ne' | 'nw'; reserved?: string }

export const SEATS: SeatSpec[] = [
  // the board table, {5.8, 3.2} .. {12.2, 5.6}: three along the far edge, three along the near one, one at each end
  { id: 'boardroom_seat_1', x: 6.8, y: 2.4, room: 'boardroom', facing: 'se' },
  { id: 'boardroom_seat_2', x: 9.0, y: 2.4, room: 'boardroom', facing: 'sw' },
  { id: 'boardroom_seat_3', x: 11.2, y: 2.4, room: 'boardroom', facing: 'sw' },
  { id: 'boardroom_seat_4', x: 6.8, y: 6.4, room: 'boardroom', facing: 'nw' },
  { id: 'boardroom_seat_5', x: 11.2, y: 6.4, room: 'boardroom', facing: 'ne' },
  { id: 'boardroom_seat_6', x: 4.9, y: 4.4, room: 'boardroom', facing: 'se' },
  { id: 'boardroom_seat_7', x: 13.1, y: 4.4, room: 'boardroom', facing: 'nw' },
  // the owner's own chair, at the near edge between the two who face them
  { id: 'owner_chair', x: 9.0, y: 6.4, room: 'boardroom', facing: 'nw', reserved: 'owner' },
  // the meeting room, table {26.6, 3.2} .. {31.6, 5.2}
  { id: 'meetingroom_seat_1', x: 27.4, y: 2.4, room: 'meetingroom', facing: 'se' },
  { id: 'meetingroom_seat_2', x: 29.1, y: 2.4, room: 'meetingroom', facing: 'sw' },
  { id: 'meetingroom_seat_3', x: 30.8, y: 2.4, room: 'meetingroom', facing: 'sw' },
  { id: 'meetingroom_seat_4', x: 27.4, y: 6.0, room: 'meetingroom', facing: 'nw' },
  { id: 'meetingroom_seat_5', x: 29.1, y: 6.0, room: 'meetingroom', facing: 'ne' },
  { id: 'meetingroom_seat_6', x: 30.8, y: 6.0, room: 'meetingroom', facing: 'nw' },
  // the pantry's stools, round the three high tables
  { id: 'pantry_seat_1', x: 4.4, y: 17.3, room: 'pantry', facing: 'se' },
  { id: 'pantry_seat_2', x: 6.0, y: 18.0, room: 'pantry', facing: 'nw' },
  { id: 'pantry_seat_3', x: 7.8, y: 17.5, room: 'pantry', facing: 'se' },
  { id: 'pantry_seat_4', x: 9.4, y: 18.3, room: 'pantry', facing: 'nw' },
  { id: 'pantry_seat_5', x: 11.0, y: 16.9, room: 'pantry', facing: 'se' },
  { id: 'pantry_seat_6', x: 12.6, y: 17.7, room: 'pantry', facing: 'nw' },
  { id: 'pantry_seat_7', x: 5.2, y: 19.4, room: 'pantry', facing: 'ne' },
  { id: 'pantry_seat_8', x: 10.2, y: 19.6, room: 'pantry', facing: 'nw' },
];

/* ---------------------------------------------------------------------------------------------------------- */
/* the ten screens                                                                                             */
/* ---------------------------------------------------------------------------------------------------------- */

export interface ScreenSpec {
  kind: string; label: string; line: string;
  x: number; y: number; axis: Axis; len: number; z: number; h: number;
  accent: AccentName; room: string;
  face?: 'screen' | 'board' | 'paper';
  /** a plaster pier behind the panel; off only where it hangs on the curtain wall already */
  pier?: boolean;
  /** where an agent stands to use it: beside the panel, never in front of it */
  stand: { x: number; y: number };
}

export const SCREENS: ScreenSpec[] = [
  { kind: 'whiteboard', label: 'Whiteboard — Plans/plan.md', line: 'Q3 — ship the viewer', x: 2.64, y: 3.2, axis: 'y', len: 5.0, z: 0.66, h: 1.74, accent: 'slate', room: 'boardroom', face: 'board', stand: { x: 4.0, y: 2.6 } },
  { kind: 'cabin', label: 'Cabin — talk to the CEO', line: 'pricing — your call', x: 18.6, y: 1.62, axis: 'x', len: 4.0, z: 0.76, h: 1.56, accent: 'slate', room: 'ceo_office', pier: false, stand: { x: 23.4, y: 6.6 } },
  { kind: 'noticeboard', label: 'Notice board — the queue', line: '6 jobs · 2 blocked', x: 18.0, y: 10.62, axis: 'x', len: 4.4, z: 0.7, h: 1.56, accent: 'neutral', room: 'lobby', face: 'paper', stand: { x: 23.4, y: 11.8 } },
  { kind: 'terminal', label: 'Terminal — shell output', line: '$ pnpm test · 128 ok', x: 4.2, y: 22.62, axis: 'x', len: 4.6, z: 0.82, h: 1.64, accent: 'indigo', room: 'dev', stand: { x: 9.6, y: 23.8 } },
  { kind: 'workshop', label: 'Workshop — site preview & deploys', line: 'build #412 — green', x: 18.0, y: 22.62, axis: 'x', len: 4.2, z: 0.82, h: 1.56, accent: 'indigo', room: 'qa', stand: { x: 23.2, y: 23.8 } },
  { kind: 'bank', label: 'Bank — cash and runway', line: 'balance ₹412,900', x: 36.0, y: 6.8, axis: 'x', len: 2.9, z: 0.76, h: 1.5, accent: 'sage', room: 'cfo_office', stand: { x: 35.9, y: 8.0 } },
  { kind: 'vault', label: 'Vault — open in Obsidian', line: '2 keys · rotated 12d', x: 39.1, y: 6.8, axis: 'x', len: 2.9, z: 0.76, h: 1.5, accent: 'sage', room: 'ciso_office', stand: { x: 38.9, y: 8.0 } },
  { kind: 'billboard', label: 'Billboard — live browser', line: 'campaign: quiet office', x: 42.2, y: 6.8, axis: 'x', len: 3.2, z: 0.9, h: 1.78, accent: 'amber', room: 'cmo_office', stand: { x: 42.0, y: 8.2 } },
  { kind: 'newsstand', label: 'Newsstand — briefs & decisions', line: 'today’s brief is out', x: 45.8, y: 6.8, axis: 'x', len: 2.7, z: 0.7, h: 1.44, accent: 'amber', room: 'cmo_office', face: 'paper', stand: { x: 48.9, y: 8.0 } },
  { kind: 'postoffice', label: 'Post office — mail & approvals', line: '3 proposals waiting', x: 40.6, y: 16.62, axis: 'x', len: 3.6, z: 0.74, h: 1.58, accent: 'amber', room: 'sales', stand: { x: 44.8, y: 17.8 } },
];

/* ---------------------------------------------------------------------------------------------------------- */
/* partitions, walkways and the rest of the furniture                                                          */
/* ---------------------------------------------------------------------------------------------------------- */

export interface PartitionSpec { x: number; y: number; axis: Axis; len: number; h?: number; accent: AccentName }

/** Glass, never solid: every run is partial, so the plan stays open and the eye crosses every boundary. */
export const PARTITIONS: PartitionSpec[] = [
  // the executive suite
  { x: 2.6, y: 11.0, axis: 'x', len: 5.2, accent: 'slate' },
  { x: 7.8, y: 11.0, axis: 'x', len: 4.6, accent: 'slate' },
  { x: 15.2, y: 1.9, axis: 'y', len: 8.4, accent: 'slate' },
  { x: 16.6, y: 9.0, axis: 'x', len: 3.0, accent: 'slate' },
  { x: 21.4, y: 9.0, axis: 'x', len: 2.8, accent: 'slate' },
  { x: 24.2, y: 1.9, axis: 'y', len: 6.4, accent: 'slate' },
  { x: 25.4, y: 8.2, axis: 'x', len: 2.4, accent: 'slate' },
  { x: 30.4, y: 8.2, axis: 'x', len: 2.4, accent: 'slate' },
  { x: 32.8, y: 1.9, axis: 'y', len: 5.8, accent: 'slate' },
  // Operations
  { x: 35.4, y: 2.0, axis: 'y', len: 4.2, accent: 'sage' },
  { x: 35.4, y: 9.4, axis: 'y', len: 4.4, accent: 'sage' },
  { x: 35.4, y: 14.2, axis: 'x', len: 5.6, accent: 'sage' },
  { x: 43.2, y: 14.2, axis: 'x', len: 6.6, accent: 'sage' },
  // Research
  { x: 26.4, y: 10.4, axis: 'y', len: 9.4, accent: 'indigo' },
  { x: 26.4, y: 20.4, axis: 'x', len: 7.2, accent: 'indigo' },
  // the Revenue floor
  { x: 35.4, y: 17.0, axis: 'y', len: 2.2, accent: 'amber' },
  { x: 35.4, y: 24.0, axis: 'y', len: 5.2, accent: 'amber' },
  // the studios
  { x: 2.6, y: 22.6, axis: 'x', len: 1.2, accent: 'indigo' },
  { x: 9.2, y: 22.6, axis: 'x', len: 6.0, accent: 'indigo' },
  { x: 15.2, y: 23.0, axis: 'y', len: 10.6, accent: 'indigo' },
  { x: 16.6, y: 22.6, axis: 'x', len: 1.2, accent: 'indigo' },
  { x: 22.4, y: 22.6, axis: 'x', len: 3.0, accent: 'indigo' },
  { x: 25.4, y: 23.0, axis: 'y', len: 10.6, accent: 'indigo' },
  // the pantry and the lobby
  { x: 2.6, y: 13.2, axis: 'x', len: 1.4, accent: 'neutral' },
  { x: 10.4, y: 13.2, axis: 'x', len: 4.2, accent: 'neutral' },
  { x: 16.6, y: 11.0, axis: 'y', len: 7.8, accent: 'neutral' },
  { x: 25.4, y: 11.0, axis: 'y', len: 7.8, accent: 'neutral' },
  { x: 27.6, y: 24.6, axis: 'x', len: 6.0, accent: 'neutral' },
];

/** The walkways. They run in the gaps the zone table already leaves, so nothing is ever laid over a zone. */
export const PATHS: Rect[] = [
  { x0: 15.3, y0: 1.6, x1: 16.5, y1: 34.6 },      // the spine, back wall to the far edge
  { x0: 33.7, y0: 1.6, x1: 35.3, y1: 34.6 },      // the spine on the revenue side
  { x0: 2.4, y0: 11.2, x1: 15.3, y1: 13.0 },      // the board room to the pantry
  { x0: 16.5, y0: 9.2, x1: 33.7, y1: 10.4 },      // under the executive suite
  { x0: 2.4, y0: 20.6, x1: 33.7, y1: 22.4 },      // the studio cross-walk
  { x0: 35.3, y0: 14.4, x1: 49.9, y1: 16.5 },     // Operations to the Revenue floor
  { x0: 16.5, y0: 19.4, x1: 25.5, y1: 22.4 },     // the lobby's throat
  { x0: 1.2, y0: 1.6, x1: 2.5, y1: 34.6 },        // the rim walk under the western windows
];

export interface PropSpec { kind: string; x: number; y: number; props?: Record<string, string | number> }

export const TABLES: { id: string; kind: 'boardtable' | 'counter'; rect: Rect }[] = [
  { id: 'board_table', kind: 'boardtable', rect: { x0: 5.8, y0: 3.2, x1: 12.2, y1: 5.6 } },
  { id: 'meeting_table', kind: 'boardtable', rect: { x0: 26.6, y0: 3.2, x1: 31.6, y1: 5.2 } },
  { id: 'pantry_counter', kind: 'counter', rect: { x0: 4.2, y0: 14.2, x1: 9.6, y1: 15.4 } },
  { id: 'lounge_bench', kind: 'counter', rect: { x0: 28.6, y0: 27.4, x1: 32.6, y1: 28.5 } },
];

export const HIGH_TABLES: PropSpec[] = [
  { kind: 'hightable', x: 5.2, y: 17.6 }, { kind: 'hightable', x: 8.6, y: 17.9 }, { kind: 'hightable', x: 11.8, y: 17.3 },
  { kind: 'hightable', x: 21.4, y: 14.6 }, { kind: 'hightable', x: 30.4, y: 25.6 },
];

export const STOOLS: PropSpec[] = [
  ...SEATS.filter((s) => s.room === 'pantry').map((s) => ({ kind: 'stool', x: s.x, y: s.y })),
  { kind: 'stool', x: 20.4, y: 15.2 }, { kind: 'stool', x: 22.4, y: 14.4 },
  { kind: 'stool', x: 29.6, y: 26.0 }, { kind: 'stool', x: 31.4, y: 25.2 },
];

export const SHELVES: PropSpec[] = [
  { kind: 'shelf', x: 5.4, y: 6.6, props: { w: 3.4, accent: 'slate' } },
  { kind: 'shelf', x: 21.4, y: 2.4, props: { w: 2.4, accent: 'slate' } },
  { kind: 'shelf', x: 26.0, y: 6.4, props: { w: 2.2, accent: 'slate' } },
  { kind: 'shelf', x: 3.4, y: 18.8, props: { w: 2.6, accent: 'neutral' } },
  { kind: 'shelf', x: 17.6, y: 12.6, props: { w: 3.4, accent: 'neutral' } },
  { kind: 'shelf', x: 27.4, y: 26.4, props: { w: 2.6, accent: 'neutral' } },
  { kind: 'shelf', x: 12.4, y: 27.0, props: { w: 2.2, accent: 'indigo' } },
  { kind: 'shelf', x: 23.2, y: 26.2, props: { w: 1.9, accent: 'indigo' } },
  { kind: 'shelf', x: 31.0, y: 12.4, props: { w: 2.2, accent: 'indigo' } },
  { kind: 'shelf', x: 47.6, y: 11.4, props: { w: 2.0, accent: 'sage' } },
  { kind: 'shelf', x: 46.4, y: 22.6, props: { w: 2.6, accent: 'amber' } },
  { kind: 'shelf', x: 46.4, y: 29.0, props: { w: 2.6, accent: 'amber' } },
];

export const PLANTS: PropSpec[] = [
  { kind: 'plant', x: 1.9, y: 9.4, props: { size: 1.25 } }, { kind: 'plant', x: 15.85, y: 11.4, props: { size: 1.1 } },
  { kind: 'plant', x: 15.85, y: 2.6, props: { size: 0.95 } }, { kind: 'plant', x: 24.8, y: 9.6, props: { size: 1.15 } },
  { kind: 'plant', x: 33.2, y: 9.2, props: { size: 1.0 } }, { kind: 'plant', x: 34.5, y: 13.2, props: { size: 1.2 } },
  { kind: 'plant', x: 25.9, y: 21.4, props: { size: 1.1 } }, { kind: 'plant', x: 15.85, y: 21.4, props: { size: 1.15 } },
  { kind: 'plant', x: 1.9, y: 21.4, props: { size: 1.05 } }, { kind: 'plant', x: 1.9, y: 33.4, props: { size: 1.2 } },
  { kind: 'plant', x: 15.85, y: 33.4, props: { size: 1.0 } }, { kind: 'plant', x: 26.6, y: 33.2, props: { size: 1.1 } },
  { kind: 'plant', x: 49.4, y: 13.0, props: { size: 1.0 } }, { kind: 'plant', x: 49.4, y: 31.6, props: { size: 1.2 } },
  { kind: 'plant', x: 34.5, y: 28.4, props: { size: 0.95 } }, { kind: 'plant', x: 14.3, y: 6.6, props: { size: 0.9 } },
  { kind: 'plant', x: 13.6, y: 2.8, props: { size: 1.3 } }, { kind: 'plant', x: 3.2, y: 13.6, props: { size: 1.15 } },
  { kind: 'plant', x: 19.4, y: 17.6, props: { size: 1.25 } }, { kind: 'plant', x: 24.4, y: 17.8, props: { size: 1.0 } },
  { kind: 'plant', x: 28.9, y: 22.0, props: { size: 1.0 } }, { kind: 'plant', x: 49.4, y: 2.6, props: { size: 1.1 } },
  { kind: 'plant', x: 8.4, y: 33.4, props: { size: 1.15 } }, { kind: 'plant', x: 20.8, y: 33.4, props: { size: 1.05 } },
  { kind: 'plant', x: 31.6, y: 33.2, props: { size: 1.2 } }, { kind: 'plant', x: 39.4, y: 33.2, props: { size: 1.0 } },
  { kind: 'plant', x: 1.9, y: 25.4, props: { size: 1.1 } }, { kind: 'plant', x: 1.9, y: 16.4, props: { size: 0.95 } },
  { kind: 'plant', x: 44.2, y: 13.2, props: { size: 1.05 } }, { kind: 'plant', x: 34.5, y: 20.6, props: { size: 1.0 } },
];

/** Floor lamps: the warm points a campus at dusk needs, in the rooms with no desk lamp of their own. */
export const FLOOR_LAMPS: PropSpec[] = [
  { kind: 'floorlamp', x: 13.6, y: 6.6 }, { kind: 'floorlamp', x: 3.3, y: 15.6 }, { kind: 'floorlamp', x: 23.6, y: 17.4 },
  { kind: 'floorlamp', x: 32.6, y: 31.2 }, { kind: 'floorlamp', x: 48.6, y: 16.8 }, { kind: 'floorlamp', x: 22.4, y: 3.2 },
];

/** Loose chairs: the ones that belong to a table rather than to a desk. */
export const LOOSE_CHAIRS: { x: number; y: number; facing: 'se' | 'sw' | 'ne' | 'nw' }[] =
  SEATS.filter((s) => s.room !== 'pantry').map((s) => ({ x: round2(s.x - 0.36), y: round2(s.y - 0.36), facing: s.facing }));

/* ---------------------------------------------------------------------------------------------------------- */
/* the Tiled document                                                                                          */
/* ---------------------------------------------------------------------------------------------------------- */

export interface TiledProperty { name: string; type: 'int' | 'float' | 'string'; value: string | number }
export interface TiledObject { id: number; name: string; type: string; x: number; y: number; width: number; height: number; properties: TiledProperty[] }
export interface TiledLayer { id: number; name: string; type: 'tilelayer' | 'objectgroup'; visible: boolean; opacity: number; x: number; y: number; width?: number; height?: number; data?: number[]; draworder?: string; objects?: TiledObject[] }
export interface TiledMap { type: 'map'; version: string; tiledversion: string; orientation: string; renderorder: string; width: number; height: number; tilewidth: number; tileheight: number; infinite: boolean; nextlayerid: number; nextobjectid: number; tilesets: never[]; layers: TiledLayer[]; properties: TiledProperty[] }

export interface DeskRow { id: string; x: number; y: number; room: string; floor: number; slot: 'fixed' | 'member' }

type Props = Record<string, string | number | boolean | undefined>;

class Doc {
  objects: TiledObject[] = [];
  decor: TiledObject[] = [];
  signs: TiledObject[] = [];
  /** 0 walkable, 1 blocked, at `WALK` sub-cells to the cell — fine enough for a partition and the corridor beside it */
  blocked: number[] = new Array(GW * GH).fill(0);
  private oid = 1;
  nextId(): number { return this.oid; }

  obj(list: TiledObject[], name: string, type: string, x: number, y: number, w = 1, h = 1, props: Props = {}): void {
    const properties: TiledProperty[] = [];
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined) continue;
      const value = typeof v === 'boolean' ? (v ? 1 : 0) : v;
      properties.push({ name: k, type: typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : 'string', value });
    }
    list.push({ id: this.oid++, name, type, x: x * TILE, y: y * TILE, width: w * TILE, height: h * TILE, properties });
  }

  private paint(r: Rect, v: 0 | 1): void {
    const x0 = Math.max(0, Math.floor(r.x0 * WALK)), x1 = Math.min(GW - 1, Math.floor(r.x1 * WALK - 1e-6));
    const y0 = Math.max(0, Math.floor(r.y0 * WALK)), y1 = Math.min(GH - 1, Math.floor(r.y1 * WALK - 1e-6));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.blocked[y * GW + x] = v;
  }
  /** Mark every sub-cell a rectangle touches as blocked. */
  block(r: Rect): void { this.paint(r, 1); }
  /** Free every sub-cell a rectangle touches: a chair is a thing to sit on, not a wall. */
  clear(r: Rect): void { this.paint(r, 0); }
  /**
   * A partition, as a hairline rather than as its drawn thickness.
   *
   * Glass is 0.3 cells thick on the screen and the corridors either side of it are barely a cell wide, so blocking
   * the drawn footprint closed both of them: the first generated campus had the meeting room, the board room and
   * three desk rows sealed off from the walkways that serve them. The walk grid takes the centre line only.
   */
  wall(x: number, y: number, axis: Axis, len: number): void {
    this.block(axis === 'x'
      ? { x0: x, y0: y - 0.02, x1: x + len, y1: y + 0.02 }
      : { x0: x - 0.02, y0: y, x1: x + 0.02, y1: y + len });
  }
  /** A desk lamp: decor the night pass looks for, on the occupant's own side of the desk. */
  lamp(x: number, y: number, desk: string): void {
    this.obj(this.decor, `decor_lamp_${desk}`, 'decor', x, y, 1, 1, { kind: 'lamp', floor: 1, desk });
  }
}

/**
 * The map, the desk table and nothing else. Every `floor` is 1: the campus is one plane, and the property stays
 * only because the daemon's org notes and the snapshot contract still carry it.
 */
export function buildCampus(): { map: TiledMap; desks: DeskRow[] } {
  const c = new Doc();

  // the curtain wall's own footprint, and a cell of margin round the slab
  c.block({ x0: 0, y0: 0, x1: W, y1: WALL + 0.45 });
  c.block({ x0: 0, y0: 0, x1: WALL + 0.45, y1: H });
  c.block({ x0: 0, y0: H - 0.6, x1: W, y1: H });
  c.block({ x0: W - 0.6, y0: 0, x1: W, y1: H });

  for (const z of ZONES) {
    c.obj(c.objects, z.id, 'zone', z.rect.x0, z.rect.y0, z.rect.x1 - z.rect.x0, z.rect.y1 - z.rect.y0, {
      label: z.label, accent: z.accent, floor: 1,
      plate_fx: z.plate?.fx ?? 0.5, plate_fy: z.plate?.fy ?? 0.5,
      ...(z.rail ? { rail: z.rail.label, rail_order: z.rail.order } : {}),
    });
  }
  for (const r of ROOMS) {
    c.obj(c.objects, r.id, 'room', r.rect.x0, r.rect.y0, r.rect.x1 - r.rect.x0, r.rect.y1 - r.rect.y0, {
      label: r.label, zone: r.zone, accent: r.accent, floor: 1, stand_x: r.stand.x, stand_y: r.stand.y,
    });
    c.obj(c.signs, `sign_${r.id}`, 'sign', r.rect.x0, r.rect.y0, 1, 1, { room: r.id, label: r.label, floor: 1 });
  }
  for (const p of PATHS) c.obj(c.objects, `path_${c.nextId()}`, 'path', p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0, { floor: 1 });

  const desks: DeskRow[] = [];
  for (const d of DESKS) {
    const w = d.w ?? DESK_W, dd = d.d ?? DESK_D;
    const seat = seatOf(d);
    c.obj(c.objects, d.id, 'desk', d.x, d.y, w, dd, {
      room: d.room, zone: d.zone, floor: 1, slot: d.slot, side: d.side, accent: d.accent,
      seat_x: seat.x, seat_y: seat.y, lamp: d.lamp, papers: d.papers,
    });
    desks.push({ id: d.id, x: seat.x, y: seat.y, room: d.room, floor: 1, slot: d.slot });
    c.block({ x0: d.x, y0: d.y, x1: d.x + w, y1: d.y + dd });
    if (d.lamp) c.lamp(seat.x, seat.y, d.id);
  }
  for (const s of SEATS) c.obj(c.objects, s.id, 'seat', s.x, s.y, 1, 1, { room: s.room, floor: 1, facing: s.facing, ...(s.reserved ? { reserved: s.reserved } : {}) });
  for (const s of SCREENS) {
    c.obj(c.objects, s.kind, 'surface', s.x, s.y, s.axis === 'x' ? s.len : 0.3, s.axis === 'y' ? s.len : 0.3, {
      label: s.label, line: s.line, floor: 1, axis: s.axis, len: s.len, z: s.z, h: s.h, accent: s.accent,
      room: s.room, face: s.face ?? 'screen', pier: s.pier === false ? 0 : 1, stand_x: s.stand.x, stand_y: s.stand.y,
    });
    // the panel and the pier behind it, as a hairline: a screen hangs on the line a partition would run along
    c.wall(s.axis === 'x' ? s.x - 0.26 : s.x, s.axis === 'x' ? s.y : s.y - 0.26, s.axis, s.len + 0.52);
  }
  for (const p of PARTITIONS) {
    c.obj(c.objects, `partition_${c.nextId()}`, 'partition', p.x, p.y, p.axis === 'x' ? p.len : 0.2, p.axis === 'y' ? p.len : 0.2, { axis: p.axis, len: p.len, h: p.h ?? 1.38, accent: p.accent, floor: 1 });
    c.wall(p.x, p.y, p.axis, p.len);
  }
  for (const t of TABLES) {
    c.obj(c.objects, t.id, 'prop', t.rect.x0, t.rect.y0, t.rect.x1 - t.rect.x0, t.rect.y1 - t.rect.y0, { kind: t.kind, floor: 1 });
    c.block(t.rect);
  }
  for (const p of [...HIGH_TABLES, ...SHELVES, ...PLANTS, ...FLOOR_LAMPS, ...STOOLS]) {
    c.obj(c.objects, `prop_${c.nextId()}`, 'prop', p.x, p.y, 1, 1, { kind: p.kind, floor: 1, ...(p.props ?? {}) });
    if (p.kind === 'shelf') c.block({ x0: p.x, y0: p.y, x1: p.x + Number(p.props?.w ?? 3), y1: p.y + 0.75 });
    else if (p.kind === 'hightable') c.block({ x0: p.x - 0.5, y0: p.y - 0.5, x1: p.x + 0.5, y1: p.y + 0.5 });
    else if (p.kind === 'plant' || p.kind === 'floorlamp') c.block({ x0: p.x - 0.3, y0: p.y - 0.3, x1: p.x + 0.3, y1: p.y + 0.3 });
  }
  for (const ch of LOOSE_CHAIRS) c.obj(c.objects, `chair_${c.nextId()}`, 'prop', ch.x, ch.y, 0.72, 0.72, { kind: 'chair', facing: ch.facing, floor: 1 });

  // decor the renderer animates: a monitor per desk, the pantry's coffee and cooler
  for (const d of DESKS) c.obj(c.decor, `decor_monitor_${d.id}`, 'decor', d.x, d.y, 1, 1, { kind: 'monitor', floor: 1, desk: d.id });
  c.obj(c.decor, 'decor_coffee', 'decor', 6.4, 14.6, 1, 1, { kind: 'coffee', floor: 1 });
  c.obj(c.decor, 'decor_cooler', 'decor', 13.4, 14.4, 1, 1, { kind: 'cooler', floor: 1 });

  // the entrance: where a sprite arrives from and leaves to, on the spine's far end
  c.obj(c.objects, 'door', 'anchor', 15.4, 34.2, 1.2, 0.8, { label: 'Entrance', floor: 1, stand_x: 15.9, stand_y: 34.2 });

  // Somewhere to stand is not a wall: a chair, a desk's own seat, the spot beside a screen and the zone stands are
  // freed last, whatever the furniture pass laid over them. Walkways are *not* re-cut here — a corridor has to be
  // genuinely clear in the zone table, or it is a corridor that runs through glass.
  const spot = (x: number, y: number): Rect => ({ x0: x - 0.24, y0: y - 0.24, x1: x + 0.24, y1: y + 0.24 });
  for (const s of SEATS) c.clear(spot(s.x, s.y));
  for (const d of DESKS) { const s = seatOf(d); c.clear(spot(s.x, s.y)); }
  for (const s of SCREENS) c.clear(spot(s.stand.x, s.stand.y));
  for (const z of ZONES) c.clear(spot(z.stand.x, z.stand.y));
  c.clear({ x0: 15.4, y0: 33.4, x1: 16.4, y1: 34.8 });

  const layer = (id: number, name: string, data: number[]): TiledLayer => ({ id, name, type: 'tilelayer', width: GW, height: GH, x: 0, y: 0, opacity: 1, visible: true, data });
  const group = (id: number, name: string, objects: TiledObject[]): TiledLayer => ({ id, name, type: 'objectgroup', visible: true, opacity: 1, x: 0, y: 0, draworder: 'topdown', objects });
  const map: TiledMap = {
    type: 'map', version: '1.10', tiledversion: 'cubicle-gen', orientation: 'isometric', renderorder: 'right-down',
    width: W, height: H, tilewidth: TILE, tileheight: TILE / 2, infinite: false, nextlayerid: 5, nextobjectid: c.nextId(),
    tilesets: [],
    layers: [layer(1, 'blocked', c.blocked), group(2, 'objects', c.objects), group(3, 'decor', c.decor), group(4, 'signs', c.signs)],
    properties: [
      { name: 'generated', type: 'string', value: 'scripts/gen-world.ts' },
      { name: 'plan', type: 'string', value: 'campus' },
      { name: 'wall', type: 'float', value: WALL },
      { name: 'walk_scale', type: 'int', value: WALK },
    ],
  };
  return { map, desks };
}

