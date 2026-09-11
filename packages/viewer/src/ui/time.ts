import type { CubicleEvent } from '../state.js';
import { PALETTE, hexToInt, hexToHsl, hsl } from '../world/palette.js';

/** How dark the night overlay gets at its deepest. */
export const NIGHT_ALPHA = 0.55;

/**
 * Day/night overlay alpha for an hour of the day (0–24): dark until 6, fading out until 8, clear through the
 * working day, fading back in from 18 and full dark from 21.
 */
export function tintFor(hour: number): number {
  if (hour < 6) return NIGHT_ALPHA;
  if (hour < 8) return NIGHT_ALPHA * (8 - hour) / 2;
  if (hour < 18) return 0;
  if (hour < 21) return NIGHT_ALPHA * (hour - 18) / 3;
  return NIGHT_ALPHA;
}

export type HourBucket = 'day' | 'dusk' | 'night';
/** Night before 6 and from 21; dusk on the two ramps (6–8, 18–21); day between. Drives window tiles and the sky. */
export function hourBucket(hour: number): HourBucket { if (hour < 6 || hour >= 21) return 'night'; if (hour < 8 || hour >= 18) return 'dusk'; return 'day'; }

const mix = (a: string, b: string, t: number): string => { const x = hexToHsl(a), y = hexToHsl(b); const dh = ((y.h - x.h + 540) % 360) - 180; return hsl(x.h + dh * t, x.s + (y.s - x.s) * t, x.l + (y.l - x.l) * t); };

/** Sky gradient stops (top, bottom) for the hour: day, dusk and night stops, blended across the ramps. */
export function skyFor(hour: number): [string, string] {
  const S = PALETTE.sky;
  const blend = (from: readonly [string, string], to: readonly [string, string], t: number): [string, string] => [mix(from[0], to[0], t), mix(from[1], to[1], t)];
  if (hour < 5) return [S.night[0], S.night[1]];
  if (hour < 6.5) return blend(S.night, S.dusk, (hour - 5) / 1.5);
  if (hour < 8) return blend(S.dusk, S.day, (hour - 6.5) / 1.5);
  if (hour < 18) return [S.day[0], S.day[1]];
  if (hour < 19.5) return blend(S.day, S.dusk, (hour - 18) / 1.5);
  if (hour < 21) return blend(S.dusk, S.night, (hour - 19.5) / 1.5);
  return [S.night[0], S.night[1]];
}

/** Colour of the night overlay: dusk purple on the ramps, deep blue at full night. */
export function nightColourFor(hour: number): number { return hourBucket(hour) === 'night' ? hexToInt(PALETTE.night) : hexToInt(PALETTE.dusk); }

/** Lamp glow alpha: 0 by day, following the tint ramp, 1 at full night. */
export function lampAlphaFor(hour: number): number { return tintFor(hour) / NIGHT_ALPHA; }

export interface TimeHandlers { onLive(): void; onReplayRequest(date: string): void; onScrub(index: number): void; }

/** Live/replay controls: date picker loads a day's events; the slider scrubs through them at 1×–50×. */
export class TimeControls {
  private live = document.getElementById('live') as HTMLButtonElement;
  private date = document.getElementById('replay-date') as HTMLInputElement;
  private load = document.getElementById('replay-load') as HTMLButtonElement;
  private scrub = document.getElementById('scrub') as HTMLInputElement;
  private speed = document.getElementById('speed') as HTMLSelectElement;
  private clock = document.getElementById('clock')!;
  events: CubicleEvent[] = [];
  index = 0;
  playing = false;
  mode: 'live' | 'replay' = 'live';
  private acc = 0;

  constructor(private h: TimeHandlers) {
    this.date.value = new Date().toISOString().slice(0, 10);
    const q = new URLSearchParams(location.search);
    if (q.get('replay')) { this.date.value = q.get('replay')!; setTimeout(() => this.load.click(), 500); }
    this.live.addEventListener('click', () => { this.mode = 'live'; this.playing = false; this.scrub.disabled = true; this.live.textContent = '● live'; h.onLive(); });
    this.load.addEventListener('click', () => { if (this.date.value) h.onReplayRequest(this.date.value); });
    this.scrub.addEventListener('input', () => { this.playing = false; this.seek(Math.round((Number(this.scrub.value) / 1000) * this.events.length)); });
    this.scrub.addEventListener('dblclick', () => { this.playing = !this.playing; });
  }

  setReplay(events: CubicleEvent[]): void {
    this.events = events; this.index = 0; this.mode = 'replay'; this.playing = events.length > 0;
    this.scrub.disabled = events.length === 0; this.scrub.value = '0'; this.live.textContent = '○ live';
    this.clock.textContent = events.length ? `${events.length} events · ${events[0].ts.slice(11, 19)}–${events[events.length - 1].ts.slice(11, 19)} (dbl-click slider to pause/play)` : 'no events that day';
  }

  private seek(i: number): void { this.index = Math.max(0, Math.min(this.events.length, i)); this.h.onScrub(this.index); this.scrub.value = String(Math.round((this.index / Math.max(1, this.events.length)) * 1000)); }

  /** Advance replay: events are spaced by their real timestamps divided by the speed factor. */
  tick(dtMs: number, nowLive: Date): void {
    if (this.mode === 'live') { this.clock.textContent = nowLive.toLocaleTimeString(); return; }
    if (!this.playing || this.index >= this.events.length) return;
    this.acc += dtMs * Number(this.speed.value);
    let advanced = false;
    while (this.index < this.events.length) {
      const cur = this.events[this.index];
      const prev = this.index > 0 ? this.events[this.index - 1] : cur;
      const gap = Math.min(Date.parse(cur.ts) - Date.parse(prev.ts), 60_000);
      if (this.acc < gap) break;
      this.acc -= gap; this.index++; advanced = true;
    }
    if (advanced) { this.h.onScrub(this.index); this.scrub.value = String(Math.round((this.index / this.events.length) * 1000)); }
    const at = this.events[Math.max(0, this.index - 1)];
    this.clock.textContent = `replay ${at.ts.slice(0, 19).replace('T', ' ')} · ${this.index}/${this.events.length}`;
  }

  /** Simulated hour (0–23) for the day/night tint: real local time live, event timestamp in replay. */
  hour(nowLive: Date): number {
    if (this.mode === 'live' || !this.events.length) return nowLive.getHours() + nowLive.getMinutes() / 60;
    const d = new Date(this.events[Math.max(0, this.index - 1)].ts);
    return d.getHours() + d.getMinutes() / 60;
  }
}
