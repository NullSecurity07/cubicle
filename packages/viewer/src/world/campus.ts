/**
 * The campus, read off the map the generator writes — and routed over.
 *
 * The parser itself now lives in `@cubicle/core/campus` (`parseCampusMap`): the daemon validates the owner's
 * layout (`Office/campus.md`) against desks, zones and blocked cells, and two parsers would be two answers to
 * "is that spot free". That module is dependency-free and bundles for the browser; nothing else of core does,
 * and nothing else of core is imported here.
 *
 * What stays is what only the office needs: the A* router over the walk grid. Every type and every geometry
 * helper the viewer used to get from this file is re-exported below, so imports elsewhere are unchanged.
 */
import EasyStar from 'easystarjs';
import { parseCampusMap, nearestWalkable, fromWalk, type CampusMap, type Pt } from '@cubicle/core/campus';

export {
  parseCampusMap, inRect, zoneAt, railZoneAt, walkable, toWalk, fromWalk, nearestWalkable, standAt, rectOf,
} from '@cubicle/core/campus';
export type {
  Rect, Pt, AccentName, Axis, Zone, Room, Desk, Seat, Screen, Partition, PropItem, DecorItem, Sign, TiledMap, CampusMap,
} from '@cubicle/core/campus';

/** Map JSON → campus geometry. The office's own name for `parseCampusMap`; the one parser, shared with the daemon. */
export const parseCampus = parseCampusMap;

/* -------------------------------------------------------------------------------------------------------- */
/* routing                                                                                                   */
/* -------------------------------------------------------------------------------------------------------- */

export interface Router { find(from: Pt, to: Pt): Promise<Pt[] | null> }

/**
 * A* over the walk grid, with the corners smoothed off.
 *
 * The grid is a means, not a look: a person who walks it cell by cell reads as a token on a board, which is the
 * single thing the tower's motion was criticised for. The path is simplified to its turning points before it
 * leaves here, so what the body follows is a short list of corners it can ease between.
 */
export function makeRouter(m: CampusMap): Router {
  const finder = new EasyStar.js();
  finder.setGrid(m.grid);
  finder.setAcceptableTiles([0]);
  finder.enableDiagonals();
  finder.disableCornerCutting();
  return {
    find(from, to) {
      return new Promise((resolve) => {
        const a = nearestWalkable(m, from, 10), b = nearestWalkable(m, to, 10);
        if (!a || !b) return resolve(null);
        if (a.gx === b.gx && a.gy === b.gy) return resolve([to]);
        finder.findPath(a.gx, a.gy, b.gx, b.gy, (path) => {
          if (!path) return resolve(null);
          const pts = path.map((n) => fromWalk(m, n.x, n.y));
          resolve([...simplify(pts), to]);
        });
        finder.calculate();
      });
    },
  };
}

/** Drop every point that continues the previous heading: what is left is the corners. */
export function simplify(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts.slice();
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
