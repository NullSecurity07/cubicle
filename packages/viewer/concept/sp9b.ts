/**
 * SP9b's own art, on a bare floor.
 *
 * Everything the owner can put on the campus and everything the office draws about it — the five things, a line
 * of each kind, a port ring, the landing ghost in both its states and a message travelling — laid out in a row on
 * an empty slab, at the two hours the light is written for.
 *
 * It exists because the alternative was judging a kiosk by finding it behind a partition in a four-minute run of
 * the full shot harness. This imports the product's own `src/world` modules — not a copy of them — so what it
 * shows is what the office draws, and a change that improves the picture here improves it there.
 *
 *   ?hour=12   midday (default)     ?hour=22   after dark
 *
 * `window.__sp9b.ready` is set once the frame is on the screen, so the harness waits on a fact.
 */
import { type Rect, type View, view } from '../src/world/iso.js';
import { type Light, MATERIAL as M, lightAt, mix, rgba, shade, warm } from '../src/world/materials.js';
import { PLATES, fillPoly, plate, roundPoly } from '../src/world/shapes.js';
import { type Drawable, desk as deskProp, chair } from '../src/world/props.js';
import type { Resource } from '../src/world/campus.js';
import { drawGhost, drawLiftShadow, resourceProp } from '../src/world/resources.js';
import { drawCutChip, drawEdge, drawHandle, drawPort, drawPulse, drawRubberBand, drawTargetGlow, edgeCurve, portAt } from '../src/world/edges.js';
import { resourceRect } from '../src/world/layout.js';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const W = 1280, H = 800;
const dpr = Math.min(3, window.devicePixelRatio || 1);
canvas.width = W * dpr; canvas.height = H * dpr;
canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
const g = canvas.getContext('2d')!;
g.setTransform(dpr, 0, 0, dpr, 0, 0);

const hour = Number(new URLSearchParams(location.search).get('hour') ?? 12);
const light = lightAt(hour);
const SLAB: Rect = { x0: 0, y0: 0, x1: 22, y1: 13 };
const v: View = view({ at: { x: 11, y: 6.5 }, zoom: 1.5, w: W, h: H });

/** The five, in a row down the middle of the slab, each with the name it would carry in the office. */
const RESOURCES: Resource[] = ([
  ['browser_1', 'browser', 3.5, 'Browser', {}],
  ['doc_1', 'doc', 7, 'Plan', { path: 'Plans/plan.md' }],
  ['note_1', 'note', 10.5, 'Ask the CFO about runway', {}],
  ['site_1', 'site', 14, 'Site', {}],
  ['station_deploy', 'station', 17.5, 'Deploy', { tool: 'deploy' }],
] as [string, Resource['kind'], number, string, Partial<Resource>][]).map(([id, kind, x, label, extra]) => ({
  id, kind, label, zone: 'dev', accent: 'indigo' as const,
  at: { x, y: 4 }, rect: resourceRect(kind, { x, y: 4 }), ...extra,
}));

/** Two desks, for scale and for the lines to run between. */
const DESKS: { id: string; rect: Rect }[] = [
  { id: 'a', rect: { x0: 3, y0: 9, x1: 5.5, y1: 10.3 } },
  { id: 'b', rect: { x0: 9, y0: 9, x1: 11.5, y1: 10.3 } },
];

function paint(): void {
  g.clearRect(0, 0, W, H);
  // the ground and the slab, the same two passes the campus uses
  const ground = g.createLinearGradient(0, 0, W * 0.6, H);
  ground.addColorStop(0, light.groundFrom);
  ground.addColorStop(1, light.groundTo);
  g.fillStyle = ground;
  g.fillRect(0, 0, W, H);
  fillPoly(g, quad(SLAB), 26 * v.z, warm(M.floor, 0.012, 3), M.floor, 0.46);
  PLATES.clear({ x0: 6, y0: 6, x1: W - 6, y1: H - 6 });

  // the floor markings, under everything that stands
  const A = { x: 4.25, y: 9.65 }, B = { x: 10.25, y: 9.65 };
  drawEdge(g, v, edgeCurve(A, B), { kind: 'peer' });
  drawEdge(g, v, edgeCurve(A, { x: 3.5, y: 4 }), { kind: 'access' });
  drawGhost(g, v, { x0: 13, y0: 8.6, x1: 15.5, y1: 9.9 }, false);
  drawGhost(g, v, { x0: 16.5, y0: 8.6, x1: 19, y1: 9.9 }, true);
  drawTargetGlow(g, v, DESKS[1].rect, { soft: true });
  drawRubberBand(g, v, portAt(DESKS[0].rect), { x: 7, y: 11.6 }, true);

  // everything that stands, back to front
  const items: Drawable[] = [];
  for (const r of RESOURCES) items.push(resourceProp(r));
  for (const d of DESKS) {
    const w = d.rect.x1 - d.rect.x0;
    items.push(chair(d.rect.x0 + w / 2 - 0.46, d.rect.y0 - 1.28, 'se'));
    items.push(deskProp(d.rect.x0, d.rect.y0, w, d.rect.y1 - d.rect.y0, { accent: 'indigo', side: 'far', lamp: true, papers: true }));
  }
  items.sort((a, b) => a.d - b.d);
  for (const it of items) { it.shadow?.(g, v, light); it.draw(g, v, light); }

  // a desk in the air, over its own ghost
  const lifted: Rect = { x0: 13, y0: 8.6, x1: 15.5, y1: 9.9 };
  drawLiftShadow(g, v, lifted, light);
  g.save();
  g.translate(0, -2);
  const air = deskProp(lifted.x0, lifted.y0, 2.5, 1.3, { accent: 'amber', side: 'far', lamp: false, papers: true });
  air.shadow?.(g, v, light);
  air.draw(g, v, light);
  g.restore();

  // the hour, over the room
  g.save();
  const mul = g.createLinearGradient(W * 0.1, 0, W * 0.85, H);
  mul.addColorStop(0, light.mulFrom);
  mul.addColorStop(0.42, mix(light.mulFrom, light.mulTo, 0.3));
  mul.addColorStop(1, light.mulTo);
  g.globalCompositeOperation = 'multiply';
  g.globalAlpha = light.mulAlpha;
  g.fillStyle = mul;
  roundPoly(g, quad(SLAB), 26 * v.z);
  g.clip();
  g.fillRect(0, 0, W, H);
  g.restore();

  // the controls, over the hour: the selected line, its ⓧ, a message on the quiet one, and two port rings
  const sel = edgeCurve(A, { x: 17.5, y: 4 });
  drawEdge(g, v, sel, { kind: 'access', selected: true, light });
  drawCutChip(g, v, sel, light);
  drawPulse(g, v, edgeCurve(A, B), 0.45, light);
  drawPort(g, v, portAt(DESKS[0].rect), '#5A68BC', { light });
  drawPort(g, v, portAt(DESKS[1].rect), '#5A68BC', { active: true, light });
  for (const c of quad({ x0: 1, y0: 1.2, x1: 20.6, y1: 6.4 })) drawHandle(g, c, '#C08834');

  // The names come from the things themselves (`resourceProp` draws each one's plate), so there is nothing to
  // label here — only the caption saying which hour this is.
  plate(g, v.p(11, 12.4, 0), `SP9b \u2014 ${hour}:00`, { size: 12, chip: '#C08834', alpha: 0.95, crowd: false });
  void shade; void rgba;
}

const quad = (r: Rect, z = 0): { x: number; y: number }[] => [v.p(r.x0, r.y0, z), v.p(r.x1, r.y0, z), v.p(r.x1, r.y1, z), v.p(r.x0, r.y1, z)];

paint();
requestAnimationFrame(() => requestAnimationFrame(() => { (window as unknown as { __sp9b: { ready: boolean } }).__sp9b = { ready: true }; }));
void (light as Light);
