import { describe, it, expect, afterEach } from 'vitest';
import { Surface, screenBox, markRows, MARK_ROW_W, MARK_BAR_H } from './surfaces.js';
import { CAPTION_BAND, CAPTION_PLATE_H } from './text.js';
import type { Anchor } from './map.js';
import type { SurfaceDef } from '../ui/surfaces.js';
import { emptyState } from '../state.js';
import { withMotion } from './motion.js';
import { PALETTE } from './palette.js';

/**
 * `world/surfaces.ts` touches Phaser only through types, so a recording stub stands in for the scene here the way
 * `RecordingPx` stands in for a canvas elsewhere: every `add.*` returns a chainable object that remembers what was
 * set on it, and `tweens.add` is counted rather than run. No Phaser is instantiated.
 */
class Obj {
  alpha = 1; visible = true; x = 0; y = 0; width = 40; height = 12; depth = 0;
  style: Record<string, unknown> = {};
  text = '';
  readonly frame = { name: '' };
  constructor(public readonly kind: string, public readonly args: unknown[]) { this.style = (args.find((a) => a && typeof a === 'object' && !Array.isArray(a)) as Record<string, unknown>) ?? {}; }
  setOrigin(): this { return this; }
  setScale(): this { return this; }
  setStrokeStyle(): this { return this; }
  setInteractive(): this { return this; }
  on(): this { return this; }
  setDepth(d: number): this { this.depth = d; return this; }
  setDisplaySize(): this { return this; }
  setPosition(x: number, y: number): this { this.x = x; this.y = y; return this; }
  setX(x: number): this { this.x = x; return this; }
  setAlpha(a: number): this { this.alpha = a; return this; }
  setVisible(v: boolean): this { this.visible = v; return this; }
  setText(t: string): this { this.text = t; return this; }
  setStyle(s: Record<string, unknown>): this { Object.assign(this.style, s); return this; }
  setCrop(): this { return this; }
  setFillStyle(): this { return this; }
  setFrame(): this { return this; }
  clear(): this { return this; }
  fillStyle(): this { return this; }
  fillRect(): this { return this; }
  destroy(): void { /* recorded by the scene's list */ }
  getIndex(): number { return 0; }
  addAt(): this { return this; }
}

class StubScene {
  readonly objects: Obj[] = [];
  readonly tweens_: Record<string, unknown>[] = [];
  readonly removedTextures: string[] = [];
  private textureKeys = new Set<string>();
  private make = (kind: string, args: unknown[]): Obj => { const o = new Obj(kind, args); this.objects.push(o); return o; };
  readonly add = {
    rectangle: (...a: unknown[]) => this.make('rectangle', a),
    text: (...a: unknown[]) => this.make('text', a),
    graphics: (...a: unknown[]) => this.make('graphics', a),
    image: (...a: unknown[]) => this.make('image', a),
    container: (...a: unknown[]) => this.make('container', a),
  };
  readonly tweens = {
    add: (cfg: Record<string, unknown>) => { this.tweens_.push(cfg); return { remove: () => { /* noop */ } }; },
    killTweensOf: () => { /* noop */ },
  };
  readonly textures = {
    exists: (k: string) => this.textureKeys.has(k),
    remove: (k: string) => { this.textureKeys.delete(k); this.removedTextures.push(k); },
    addBase64: (k: string) => { this.textureKeys.add(k); },
    once: () => { /* noop */ },
  };
  readonly game = { loop: { frame: 0 } };
  /** Pretend the two cross-fade frames for `kind` have been rasterised, as they are after a browser frame lands. */
  seedFrames(kind: string): void { this.textureKeys.add(`surface:${kind}:0`); this.textureKeys.add(`surface:${kind}:1`); }
  find(text: string): Obj | undefined { return this.objects.find((o) => o.kind === 'text' && o.args[2] === text); }
}

const def: SurfaceDef = { kind: 'queue', streamKind: 'markdown', streamId: () => 'q', headline: () => ({ head: 'Queue', lines: [] }), view: () => ({ title: 'Queue', html: '', mode: 'doc' as const }) };
const anchor: Anchor = { name: 'queue', type: 'surface', tx: 10, ty: 20, tw: 6, th: 4, props: { label: 'Queue — waiting' } };

const build = (): { scene: StubScene; surface: Surface } => {
  const scene = new StubScene();
  const surface = new Surface(scene as unknown as Phaser.Scene, def, anchor, () => { /* click */ });
  return { scene, surface };
};

afterEach(() => withMotion(1));   // MOTION is process-wide: never leak a scale change into another file

describe('Surface under reduced motion', () => {
  it('adds no tween at all and leaves the LIVE badge at full alpha', () => {
    withMotion(0);
    const { scene } = build();
    expect(scene.tweens_).toEqual([]);
    const live = scene.find('LIVE')!;
    expect(live.alpha).toBe(1);
  });

  it('breathes the LIVE badge from the one duration table when motion is on', () => {
    const { scene } = build();
    const pulse = scene.tweens_.filter((t) => t.repeat === -1);
    expect(pulse).toHaveLength(1);
    expect(pulse[0].duration).toBe(1000);   // DUR.livePulse, not a literal at the call site
    expect(pulse[0].yoyo).toBe(true);
  });
});

describe('Surface teardown', () => {
  it('removes both cross-fade textures so a scene restart cannot accumulate them', () => {
    const { scene, surface } = build();
    scene.seedFrames('queue');
    surface.destroy();
    expect(scene.removedTextures.sort()).toEqual(['surface:queue:0', 'surface:queue:1']);
  });
});

describe('Surface colours', () => {
  it('takes its title ink and its LIVE ink from the palette (no literals at the call site)', () => {
    const { scene } = build();
    expect(scene.find('Queue')!.style.color).toBe(PALETTE.screenText);
    expect(scene.find('LIVE')!.style.backgroundColor).toBe(PALETTE.amber);
  });
  it('renders a headline without a scene', () => {
    const { scene, surface } = build();
    surface.render(emptyState(), {}, 0);
    expect(scene.objects.some((o) => o.kind === 'text' && o.text.length > 0)).toBe(true);
  });
});

/**
 * Visual QA C1: the glass claimed `(th - 1)` tiles of a three-tile anchor, so `maxLines` came out 0 and every
 * sub-line the registry writes — the vault's counts, the terminal's last three lines, the bank's burn and runway —
 * was discarded before it reached the wall. Ten screens across four floors each showed one word on a black slab.
 */
describe('how much a wall screen can say', () => {
  it('gives a three-tile anchor a head and three lines', () => {
    const box = screenBox({ tw: 9, th: 3, type: 'surface' });
    expect(box.h).toBe(48);
    expect(box.maxLines).toBeGreaterThanOrEqual(2);
    expect(box.maxLines).toBe(3);
  });
  it('sizes the character budgets from the width, and never to nothing', () => {
    const wide = screenBox({ tw: 10, th: 3, type: 'surface' }), narrow = screenBox({ tw: 4, th: 3, type: 'surface' });
    expect(wide.lineChars).toBeGreaterThan(wide.headChars);      // the lines are smaller type than the head
    expect(wide.headChars).toBeGreaterThan(narrow.headChars);
    expect(screenBox({ tw: 1, th: 1 }).headChars).toBeGreaterThanOrEqual(1);
  });
  it('never lets the text box grow past the glass', () => {
    for (const tw of [4, 6, 7, 8, 9, 10]) {
      const b = screenBox({ tw, th: 3, type: 'surface' });
      expect(b.innerW, `tw ${tw}`).toBeLessThanOrEqual(b.w - b.inset * 2);
      expect(b.innerH, `tw ${tw}`).toBeLessThanOrEqual(b.h - b.inset);
    }
  });
});

/**
 * Visual QA R-C1: the caption plate hangs above the screen it names, so the focus veil reserves the whole tile
 * row above a screen for it (`CAPTION_BAND`). The plate has to actually fit inside that row, or the veil edge
 * cuts through it.
 */
describe('the caption plate and the row the veil reserves for it', () => {
  it('fits inside one tile row, hanging a pixel clear of the bezel', () => {
    expect(CAPTION_BAND).toBe(16);                       // one tile: every veil edge stays on the grid
    expect(CAPTION_PLATE_H + 1).toBeLessThanOrEqual(CAPTION_BAND);
  });
});

/**
 * Visual QA R2-I2: below `WORLD_TEXT_MIN_ZOOM` the lettering is hidden, which left ten near-black slabs across the
 * whole-building view. Each screen draws the shape of its headline instead.
 */
describe('what a screen shows when its own type is too small to read', () => {
  it('draws one row per line the screen is carrying, and none for a screen with nothing to say', () => {
    expect(markRows(0)).toEqual([]);
    expect(markRows(1)).toHaveLength(1);
    expect(markRows(3)).toHaveLength(3);
  });
  it('never draws more rows than a three-tile screen has room for', () => {
    expect(markRows(9)).toHaveLength(MARK_ROW_W.length);
    expect(MARK_ROW_W.length).toBe(3);
  });
  it('is ragged, like text: every row is shorter than the one above it, and none fills the glass', () => {
    for (let i = 1; i < MARK_ROW_W.length; i++) expect(MARK_ROW_W[i]).toBeLessThan(MARK_ROW_W[i - 1]);
    for (const f of MARK_ROW_W) { expect(f).toBeGreaterThan(0); expect(f).toBeLessThan(1); }
  });
  it('leaves the title bar the tallest mark, so the head still reads as the head', () => {
    expect(MARK_BAR_H).toBeGreaterThanOrEqual(2);
    expect(MARK_BAR_H).toBeLessThanOrEqual(4);
  });
});
