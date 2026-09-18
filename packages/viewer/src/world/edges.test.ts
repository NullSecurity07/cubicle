import { describe, it, expect } from 'vitest';
import { view, type View } from './iso.js';
import { BOW, END_GAP, PORT_R, PULSE_MS, edgeCurve, edgeHit, edgeLegend, edgesShown, pointOn, portAt, pulseT, segDist, shouldPulse } from './edges.js';
import { edgeId } from './layout.js';

const V: View = view({ at: { x: 10, y: 10 }, zoom: 1, w: 1280, h: 800 });

describe('the curve between two things', () => {
  const a = { x: 4, y: 4 }, b = { x: 14, y: 4 };
  const c = edgeCurve(a, b);

  it('stops short of both ends, so a line never grows out of a desk', () => {
    expect(c.from.x).toBeCloseTo(a.x + END_GAP);
    expect(c.to.x).toBeCloseTo(b.x - END_GAP);
    expect(c.from.y).toBeCloseTo(a.y);
  });

  it('bows off the straight line by a share of its own length', () => {
    const mid = pointOn(c, 0.5);
    const straight = { x: (c.from.x + c.to.x) / 2, y: (c.from.y + c.to.y) / 2 };
    const off = Math.hypot(mid.x - straight.x, mid.y - straight.y);
    const len = Math.hypot(c.to.x - c.from.x, c.to.y - c.from.y);
    expect(off).toBeGreaterThan(0.1);
    expect(off).toBeCloseTo((len * BOW) / 2, 5);   // a quadratic reaches half way to its control point
  });

  it('is the same line drawn from either end, mirrored', () => {
    const back = edgeCurve(b, a);
    expect(back.from.x).toBeCloseTo(c.to.x);
    expect(back.to.x).toBeCloseTo(c.from.x);
    // the bow is on the far side when the line is walked the other way, which is why the renderer sorts the pair
    expect(Math.abs(back.ctrl.y - c.from.y)).toBeCloseTo(Math.abs(c.ctrl.y - c.from.y));
  });

  it('runs from end to end', () => {
    expect(pointOn(c, 0)).toEqual(c.from);
    expect(pointOn(c, 1).x).toBeCloseTo(c.to.x);
  });

  it('never collapses on two things in the same place', () => {
    const d = edgeCurve({ x: 5, y: 5 }, { x: 5, y: 5 });
    expect(Number.isFinite(d.ctrl.x)).toBe(true);
    expect(Number.isFinite(d.ctrl.y)).toBe(true);
  });

  it('shortens its own gap rather than turning a short line inside out', () => {
    const short = edgeCurve({ x: 5, y: 5 }, { x: 5.4, y: 5 });
    expect(short.from.x).toBeLessThan(short.to.x);
  });
});

describe('hitting a line', () => {
  const c = edgeCurve({ x: 4, y: 4 }, { x: 14, y: 4 });
  it('finds the pointer on the curve and not beside it', () => {
    const on = V.p(pointOn(c, 0.5).x, pointOn(c, 0.5).y, 0);
    expect(edgeHit(V, c, on.x, on.y)).toBe(true);
    expect(edgeHit(V, c, on.x, on.y - 60)).toBe(false);
    const quarter = V.p(pointOn(c, 0.25).x, pointOn(c, 0.25).y, 0);
    expect(edgeHit(V, c, quarter.x + 3, quarter.y)).toBe(true);
  });
  it('measures a point against a segment', () => {
    expect(segDist({ x: 0, y: 0 }, { x: 10, y: 0 }, 5, 4)).toBeCloseTo(4);
    expect(segDist({ x: 0, y: 0 }, { x: 10, y: 0 }, -5, 0)).toBeCloseTo(5);
    expect(segDist({ x: 3, y: 3 }, { x: 3, y: 3 }, 3, 7)).toBeCloseTo(4);
  });
});

describe('ports', () => {
  it('sits on the corner nearest the camera', () => {
    expect(portAt({ x0: 2, y0: 3, x1: 5, y1: 4 })).toEqual({ x: 5, y: 4 });
    expect(PORT_R).toBe(10);
  });
});

describe('the pulse', () => {
  it('travels for its own six hundred milliseconds and then is gone', () => {
    const p = { from: 'a', to: 'b', at: 1000 };
    expect(pulseT(p, 1000)).toBe(0);
    expect(pulseT(p, 1000 + PULSE_MS / 2)).toBeCloseTo(0.5);
    expect(pulseT(p, 1000 + PULSE_MS)).toBe(1);
    expect(pulseT(p, 1000 + PULSE_MS + 1)).toBeNull();
    expect(pulseT(p, 999)).toBeNull();
  });
});

describe('when a message travels', () => {
  it('only down a line that exists, and never under reduced motion', () => {
    expect(shouldPulse(true, false)).toBe(true);
    expect(shouldPulse(false, false)).toBe(false);
    expect(shouldPulse(true, true)).toBe(false);
    expect(shouldPulse(false, true)).toBe(false);
  });
});

describe('what a line says it permits', () => {
  it('has one sentence per kind', () => {
    expect(edgeLegend('peer')).toBe('Can message each other');
    expect(edgeLegend('access')).toBe('Can use this');
  });
});

describe('which lines are drawn', () => {
  const CNS = [
    { from: 'cto', to: 'ceo', kind: 'peer' as const },
    { from: 'cto', to: 'backend_engineer', kind: 'peer' as const },
    { from: 'ceo', to: 'cfo', kind: 'peer' as const },
    { from: 'qa_lead', to: 'browser_1', kind: 'access' as const },
  ];

  it('draws nothing at rest: a hundred and fifty lines at once is a net over the office, not wiring under it', () => {
    expect(edgesShown(CNS, {}).size).toBe(0);
  });

  it('answers about the desk the owner is looking at, and only that desk', () => {
    const shown = edgesShown(CNS, { hovered: 'cto' });
    expect([...shown].sort()).toEqual([edgeId('cto', 'backend_engineer'), edgeId('cto', 'ceo')].sort());
    expect(shown.has(edgeId('ceo', 'cfo'))).toBe(false);
  });

  it('takes the selected thing and the hovered one together', () => {
    const shown = edgesShown(CNS, { selected: 'qa_lead', hovered: 'ceo' });
    expect(shown.has(edgeId('qa_lead', 'browser_1'))).toBe(true);
    expect(shown.has(edgeId('ceo', 'cfo'))).toBe(true);
    expect(shown.has(edgeId('cto', 'ceo'))).toBe(true);                    // the CEO's line to the CTO is the CEO's
    expect(shown.has(edgeId('cto', 'backend_engineer'))).toBe(false);      // and the CTO's other lines are not
  });

  it('a selected line is a line, not a node: it does not pull in its ends’ other lines', () => {
    const shown = edgesShown(CNS, { selected: edgeId('ceo', 'cfo') });
    expect([...shown]).toEqual([edgeId('ceo', 'cfo')]);
  });

  it('shows the whole floor while a wire is out of a port, which is when the question is about the whole floor', () => {
    expect(edgesShown(CNS, { wiring: true }).size).toBe(CNS.length);
    expect(edgesShown(CNS, { wiring: true, selected: 'cto' }).size).toBe(CNS.length);
  });

  it('gives a message in flight a line to travel', () => {
    const shown = edgesShown(CNS, { pulses: [{ from: 'ceo', to: 'cfo' }] });
    expect([...shown]).toEqual([edgeId('ceo', 'cfo')]);
  });
});
