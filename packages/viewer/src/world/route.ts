import { floorAt, portalFor, type MapData, type Tile } from './map.js';

/** One stretch of a journey: walk to a tile on the current floor, or ride the elevator between floors. */
export type Leg = { kind: 'walk'; to: Tile } | { kind: 'ride'; from: number; to: number };

/** Floors are disconnected regions of one grid, so a cross-floor trip is walk → elevator door, ride, walk → target. */
export function planRoute(m: Pick<MapData, 'floors' | 'portals'>, from: Tile, to: Tile): Leg[] {
  const a = floorAt(m, from.ty), b = floorAt(m, to.ty);
  if (a === b) return [{ kind: 'walk', to }];
  return [{ kind: 'walk', to: portalFor(m, a) }, { kind: 'ride', from: a, to: b }, { kind: 'walk', to }];
}
