/**
 * A one-slot "has this changed since last frame?" gate, for calls that are cheap to decide and expensive to make.
 *
 * Phaser's `setText` and `setFrame` guard themselves; `setStyle` and `setDepth` do not. `setStyle` re-rasterises
 * a Text object's canvas and re-uploads its texture — with forty sprites showing a tool and a badge that is up to
 * eighty canvas re-renders and GPU uploads per frame, against a ≤ 4 ms scripting budget. `setDepth` marks the
 * whole display list dirty even when the value is identical.
 *
 * Pure and generic so the rule is a unit test rather than a frame-rate measurement.
 */
export class Latch<T = string> {
  private last: T | undefined;
  private primed = false;
  /** True the first time, and thereafter only when `v` differs from the value that last returned true. */
  changed(v: T): boolean {
    if (this.primed && Object.is(v, this.last)) return false;
    this.primed = true;
    this.last = v;
    return true;
  }
  /** Forget the remembered value: the next `changed` is a first time again. */
  reset(): void { this.primed = false; this.last = undefined; }
}
