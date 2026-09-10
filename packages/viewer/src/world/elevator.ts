/**
 * One elevator car serving four floors, as a pure state machine the scene steps every frame (dt-driven) and the
 * overlay can read. SCAN: keep going while a stop lies ahead, reverse otherwise, idle when there is none.
 * A stop is a rider's destination or a waiter's floor; everyone waiting on a floor boards when the doors open there.
 */
export const FLOOR_MS = 1000;   // travel time for one floor
export const OPEN_MS = 800;     // how long the doors stay open

export interface Rider { id: string; from: number; to: number }
export interface FloorRow { n: number; y0: number }
export interface ElevatorState {
  floor: number;                 // the floor the car is at or last passed
  row: number;                   // the car's top row in tiles, fractional while moving
  dir: -1 | 0 | 1;               // +1 = up (higher floor number, smaller row)
  status: 'idle' | 'moving' | 'open';
  openLeft: number;              // ms until the doors close
  waiting: Rider[];
  riders: Rider[];
}
export type ElevatorEvent =
  | { kind: 'boarded'; id: string }
  | { kind: 'arrived'; id: string; floor: number }
  | { kind: 'doors'; floor: number; open: boolean }
  | { kind: 'moved'; row: number };
/** What a sprite may do to the elevator. */
export interface ElevatorPort { request(rider: Rider): void; cancel(id: string): void }

/** The car's top row when parked at floor n: the corridor's first row (y0 + 10). */
export function carRow(floors: FloorRow[], n: number): number {
  const f = floors.find((x) => x.n === n);
  if (!f) throw new Error(`no floor ${n}`);
  return f.y0 + 10;
}

export function initialElevator(floors: FloorRow[], floor = 1): ElevatorState {
  return { floor, row: carRow(floors, floor), dir: 0, status: 'idle', openLeft: 0, waiting: [], riders: [] };
}

export function request(s: ElevatorState, rider: Rider): ElevatorState {
  if (s.waiting.some((r) => r.id === rider.id) || s.riders.some((r) => r.id === rider.id)) return s;
  return { ...s, waiting: [...s.waiting, rider] };
}

/** A waiter who changed their mind. Someone already aboard rides to their floor; the sprite handles what happens next. */
export function cancel(s: ElevatorState, id: string): ElevatorState {
  return s.waiting.some((r) => r.id === id) ? { ...s, waiting: s.waiting.filter((r) => r.id !== id) } : s;
}

const stops = (s: ElevatorState): number[] => [...new Set([...s.riders.map((r) => r.to), ...s.waiting.map((r) => r.from)])];
const ahead = (s: ElevatorState, dir: 1 | -1): boolean => stops(s).some((f) => (dir > 0 ? f > s.floor : f < s.floor));
function chooseDir(s: ElevatorState): -1 | 0 | 1 {
  const up = ahead(s, 1), down = ahead(s, -1);
  if (s.dir === -1) return down ? -1 : up ? 1 : 0;
  return up ? 1 : down ? -1 : 0;
}
/** Riders bound for this floor get off, everyone waiting here gets on. Mutates nothing; returns the new state. */
function serve(s: ElevatorState, events: ElevatorEvent[]): ElevatorState {
  const off = s.riders.filter((r) => r.to === s.floor), on = s.waiting.filter((r) => r.from === s.floor);
  for (const r of off) events.push({ kind: 'arrived', id: r.id, floor: s.floor });
  for (const r of on) events.push({ kind: 'boarded', id: r.id });
  return { ...s, riders: [...s.riders.filter((r) => r.to !== s.floor), ...on], waiting: s.waiting.filter((r) => r.from !== s.floor) };
}
function open(s: ElevatorState, events: ElevatorEvent[]): ElevatorState {
  events.push({ kind: 'doors', floor: s.floor, open: true });
  return serve({ ...s, status: 'open', openLeft: OPEN_MS }, events);
}

export function step(s0: ElevatorState, dtMs: number, floors: FloorRow[]): { state: ElevatorState; events: ElevatorEvent[] } {
  const events: ElevatorEvent[] = [];
  let s = s0;
  if (s.status === 'open') {
    s = serve(s, events);                                   // a late request at an open door still boards
    const openLeft = s.openLeft - dtMs;
    if (openLeft > 0) return { state: { ...s, openLeft }, events };
    events.push({ kind: 'doors', floor: s.floor, open: false });
    const dir = chooseDir(s);
    return { state: { ...s, openLeft: 0, dir, status: dir === 0 ? 'idle' : 'moving' }, events };
  }
  if (s.status === 'idle') {
    if (stops(s).includes(s.floor)) return { state: open(s, events), events };
    const dir = chooseDir(s);
    if (dir === 0) return { state: s, events };
    s = { ...s, dir, status: 'moving' };
  }
  // moving: advance toward the next floor in `dir`; the leftover of a long dt is dropped (the car pauses a frame at the floor)
  const next = s.floor + s.dir;
  const target = carRow(floors, next);
  const stride = Math.abs(target - carRow(floors, s.floor));
  const remaining = target - s.row;
  const row = s.row + Math.sign(remaining) * Math.min(Math.abs(remaining), (stride / FLOOR_MS) * dtMs);
  events.push({ kind: 'moved', row });
  if (Math.abs(target - row) > 1e-6) return { state: { ...s, row }, events };
  s = { ...s, row: target, floor: next };
  if (stops(s).includes(next) || chooseDir(s) === 0) return { state: open(s, events), events };   // a stop, or nothing left to do (a cancelled call): open here
  return { state: s, events };
}
