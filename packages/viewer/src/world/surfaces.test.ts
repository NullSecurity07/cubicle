import { describe, it, expect, afterEach } from 'vitest';
import { Surface } from './surfaces.js';
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
