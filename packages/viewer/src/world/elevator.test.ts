import { describe, it, expect } from 'vitest';
import { initialElevator, request, cancel, step, carRow, FLOOR_MS, OPEN_MS, type ElevatorState, type ElevatorEvent } from './elevator.js';

const FLOORS = [{ n: 1, y0: 41 }, { n: 2, y0: 28 }, { n: 3, y0: 15 }, { n: 4, y0: 2 }];
const run = (s: ElevatorState, dts: number[]): { state: ElevatorState; events: ElevatorEvent[] } => dts.reduce((acc, dt) => { const r = step(acc.state, dt, FLOORS); return { state: r.state, events: [...acc.events, ...r.events] }; }, { state: s, events: [] as ElevatorEvent[] });
const kinds = (evs: ElevatorEvent[]) => evs.filter((e) => e.kind !== 'moved').map((e) => e.kind === 'doors' ? `doors:${e.floor}:${e.open ? 'open' : 'closed'}` : e.kind === 'arrived' ? `arrived:${e.id}:${e.floor}` : `boarded:${e.id}`);

describe('elevator (one car, SCAN)', () => {
  it('starts parked on F1 with its doors closed', () => {
    const s = initialElevator(FLOORS);
    expect(s).toMatchObject({ floor: 1, row: carRow(FLOORS, 1), dir: 0, status: 'idle', waiting: [], riders: [] });
    expect(carRow(FLOORS, 1)).toBe(51); expect(carRow(FLOORS, 4)).toBe(12);
    expect(step(s, 16, FLOORS).events).toEqual([]);
  });
  it('a rider on the car\'s floor boards at once, rides, and arrives one FLOOR_MS per floor', () => {
    let s = request(initialElevator(FLOORS), { id: 'coo', from: 1, to: 3 });
    let r = step(s, 16, FLOORS);
    expect(kinds(r.events)).toEqual(['doors:1:open', 'boarded:coo']);
    expect(r.state.status).toBe('open'); expect(r.state.riders).toHaveLength(1); expect(r.state.waiting).toHaveLength(0);
    r = step(r.state, OPEN_MS, FLOORS);
    expect(kinds(r.events)).toEqual(['doors:1:closed']); expect(r.state.status).toBe('moving'); expect(r.state.dir).toBe(1);
    r = step(r.state, FLOOR_MS / 2, FLOORS);
    expect(r.state.row).toBeCloseTo(51 - 6.5); expect(r.events.some((e) => e.kind === 'moved')).toBe(true);
    r = step(r.state, FLOOR_MS / 2, FLOORS);
    expect(r.state.floor).toBe(2); expect(r.state.status).toBe('moving');    // F2 is not a stop
    r = step(r.state, FLOOR_MS, FLOORS);
    expect(r.state.floor).toBe(3); expect(kinds(r.events)).toEqual(['doors:3:open', 'arrived:coo:3']);
    expect(r.state.riders).toHaveLength(0);
    r = step(r.state, OPEN_MS, FLOORS);
    expect(r.state.status).toBe('idle'); expect(r.state.dir).toBe(0);
  });
  it('picks up a waiter on the way, keeps direction while stops lie ahead, then reverses', () => {
    let s = initialElevator(FLOORS, 1);
    s = request(s, { id: 'a', from: 1, to: 4 });
    s = request(s, { id: 'b', from: 2, to: 1 });
    const r = run(s, [16, OPEN_MS, FLOOR_MS, OPEN_MS, FLOOR_MS, FLOOR_MS, OPEN_MS, FLOOR_MS, FLOOR_MS, FLOOR_MS, OPEN_MS]);
    expect(kinds(r.events)).toEqual([
      'doors:1:open', 'boarded:a', 'doors:1:closed',
      'doors:2:open', 'boarded:b', 'doors:2:closed',        // b boards on the way up and rides along
      'doors:4:open', 'arrived:a:4', 'doors:4:closed',      // a gets off at the top; b's stop is behind → reverse
      'doors:1:open', 'arrived:b:1', 'doors:1:closed',
    ]);
    expect(r.state.status).toBe('idle');
  });
  it('cancel removes a waiter but never a rider; a duplicate request is ignored', () => {
    let s = request(initialElevator(FLOORS), { id: 'x', from: 3, to: 1 });
    s = request(s, { id: 'x', from: 3, to: 1 });
    expect(s.waiting).toHaveLength(1);
    expect(cancel(s, 'x').waiting).toHaveLength(0);
    expect(step(cancel(s, 'x'), 16, FLOORS).state.status).toBe('idle');
    let r = run(request(initialElevator(FLOORS), { id: 'y', from: 1, to: 2 }), [16, OPEN_MS]);
    r = { state: cancel(r.state, 'y'), events: [] };
    expect(r.state.riders.map((x) => x.id)).toEqual(['y']);
    expect(kinds(run(r.state, [FLOOR_MS]).events)).toEqual(['doors:2:open', 'arrived:y:2']);
  });
  it('everyone waiting at a floor boards when the doors open there', () => {
    let s = initialElevator(FLOORS, 2);
    s = request(s, { id: 'p', from: 2, to: 4 }); s = request(s, { id: 'q', from: 2, to: 3 });
    const r = step(s, 16, FLOORS);
    expect(kinds(r.events)).toEqual(['doors:2:open', 'boarded:p', 'boarded:q']);
    expect(r.state.riders.map((x) => x.id).sort()).toEqual(['p', 'q']);
  });
});
