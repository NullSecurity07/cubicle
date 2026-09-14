/**
 * SP9 concept — the page.
 *
 * Boots the product's own stylesheet and theme, retunes the tokens to the warmer palette the spec asks for, builds
 * the zone rail that replaces the floor rail, and paints one of two cameras onto a device-resolution canvas:
 *
 *   ?scene=campus   the whole open plan at overview zoom, at dusk
 *   ?scene=room     the board room and the pantry at room zoom, at midday
 *
 * `window.__concept.ready` is set when the frame is on the screen, so the shot harness can wait for a fact instead
 * of a timeout.
 */
import '../src/ui/tokens.css';
import '../src/ui/app.css';
import './concept.css';
import { applyTheme } from '../src/ui/tokens.js';
import { TILE_Z, type Camera, centre, view, zoomToFit } from './iso.js';
import { ACCENT, DAY, DUSK, type Light } from './palette.js';
import { render, SLAB } from './scene.js';
import { CAMPUS, RAIL, zoneOf } from './zones.js';

/** The warmer tokens: the overlay follows the campus, not the old steel-grey tower. */
const WARM_TOKENS: Record<string, string> = {
  '--bg': '#12120F',
  '--surface-1': '#1B1A16',
  '--surface-2': '#232118',
  '--surface-3': '#2E2B20',
  '--text': '#F2EEE5',
  '--text-2': '#B4ADA0',
  '--text-3': '#9A9387',
  '--accent': '#D49A4C',
  '--accent-ink': '#241A08',
  '--accent-text': '#E3B369',
  '--ok': '#7FB57C',
  '--hairline': 'rgba(255,248,235,.09)',
  '--hairline-2': 'rgba(255,248,235,.16)',
  '--glass': 'rgba(24,22,18,.72)',
  '--shadow-1': '0 8px 24px rgba(12,8,4,.36)',
};

const SUN = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.1" fill="currentColor"/><g stroke="currentColor" stroke-width="1.35" stroke-linecap="round"><path d="M8 1.5v1.7M8 12.8v1.7M1.5 8h1.7M12.8 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2"/></g></svg>`;
const DUSK_GLYPH = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 10.6a3.6 3.6 0 0 1 7.2 0Z" fill="currentColor"/><g stroke="currentColor" stroke-width="1.35" stroke-linecap="round"><path d="M1.6 10.6h1.4M13 10.6h1.4M2.2 13.2h11.6M8 3.2v1.5M3.9 4.6l1 1M12.1 4.6l-1 1"/></g></svg>`;

interface SceneDef { light: Light; clock: string; glyph: string; rail: string | 'all'; camera(w: number, h: number): Camera; bubbles: boolean; zoneLabels: boolean }

const BAR_H = 52, TIME_H = 64, RAIL_W = 72, PAD = 22;

/** The box the world gets: the viewport minus the chrome. Both cameras are centred in it, not in the window. */
function frame(w: number, h: number): { cx: number; cy: number; availW: number; availH: number } {
  return {
    cx: RAIL_W + (w - RAIL_W) / 2,
    cy: BAR_H + (h - BAR_H - TIME_H) / 2,
    availW: w - RAIL_W - PAD * 2,
    availH: h - BAR_H - TIME_H - PAD * 2,
  };
}

/** Headroom above the floor plate: the curtain wall plus the plate over the tallest screen. */
const HEAD_UNITS = 4.8;

const SCENES: Record<string, SceneDef> = {
  campus: {
    light: DUSK, clock: '19:04', glyph: DUSK_GLYPH, rail: 'all', bubbles: false, zoneLabels: true,
    camera(w, h) {
      const f = frame(w, h);
      const isoW = (SLAB.x1 + SLAB.y1) * 32, isoH = (SLAB.x1 + SLAB.y1) * 16;
      const zoom = Math.min(f.availW / isoW, f.availH / (isoH + HEAD_UNITS * TILE_Z));
      return { at: centre(SLAB), zoom, w, h, pan: { x: f.cx - w / 2, y: f.cy - h / 2 + (HEAD_UNITS * TILE_Z * zoom) / 2 } };
    },
  },
  room: {
    light: DAY, clock: '12:40', glyph: SUN, rail: 'board', bubbles: true, zoneLabels: true,
    camera(w, h) {
      const f = frame(w, h);
      const board = zoneOf('board').rect, pantry = zoneOf('pantry').rect;
      const r = { x0: Math.min(board.x0, pantry.x0), y0: board.y0 - 0.6, x1: Math.max(board.x1, pantry.x1), y1: pantry.y1 + 0.4 };
      const zoom = Math.min(1.12, zoomToFit(r, f.availW, f.availH, 0) * 0.98);
      return { at: centre(r), zoom, w, h, pan: { x: f.cx - w / 2, y: f.cy - h / 2 + (2.6 * TILE_Z * zoom) / 2 } };
    },
  },
};

function buildRail(active: string): void {
  const rail = document.getElementById('rail');
  if (!rail) return;
  const tab = (id: string, label: string, chip: string, cls = ''): string =>
    `<button class="ztab ${cls}" data-zone="${id}" style="--zc:${chip}" aria-current="${active === id}"><span class="bar"></span>${label}</button>`;
  rail.innerHTML = [
    tab('all', 'Campus', '#A79C8C', 'all'),
    ...RAIL.map((r) => tab(r.id, r.label, ACCENT[r.accent].chip)),
  ].join('');
}

function boot(): void {
  applyTheme('dark');
  for (const [k, v] of Object.entries(WARM_TOKENS)) document.documentElement.style.setProperty(k, v);

  const which = new URLSearchParams(location.search).get('scene') ?? 'campus';
  const def = SCENES[which] ?? SCENES.campus;

  buildRail(def.rail);
  const sun = document.getElementById('sunmoon');
  if (sun) sun.innerHTML = def.glyph;
  const clock = document.getElementById('clock');
  if (clock) clock.textContent = def.clock;

  const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
  if (!canvas) return;

  const paint = (): void => {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    render(g, view(def.camera(w, h)), def.light, { bubbles: def.bubbles, zoneLabels: def.zoneLabels });
    (window as unknown as { __concept: { ready: boolean; scene: string; zoom: number } }).__concept =
      { ready: true, scene: which, zoom: def.camera(w, h).zoom };
  };

  paint();
  window.addEventListener('resize', paint);
  // one more frame once webfont metrics and the stylesheet have settled, so the plates measure correctly
  requestAnimationFrame(() => requestAnimationFrame(paint));
  void CAMPUS;
}

boot();
