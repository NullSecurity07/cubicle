import type { CubicleEvent } from '../state.js';
import { PALETTE, hexToInt, mixHex } from '../world/palette.js';
import { pixelIcon } from './icons.js';

/** How dark the night overlay gets at its deepest. */
export const NIGHT_ALPHA = 0.55;

/**
 * Day/night overlay alpha for an hour of the day (0–24): dark until 6, fading out until 8, clear through the
 * working day, fading back in from 18 and full dark from 21.
 *
 * The evening ramp is not linear. Straight-lined over the three hours, 19:00 — the hour the sky is at its
 * warmest of the whole day — sat at a third, and the building measured 87 % of noon while the sky was a sunset:
 * two halves of one frame disagreeing about the time (visual QA R2-I4). Light goes fast once the sun is on the
 * horizon, so the first hour takes half the ramp and the last two share the rest.
 */
export const DUSK_STEPS: readonly [number, number][] = [[18, 0], [19, 0.55], [20, 0.82], [21, 1]];
export function tintFor(hour: number): number {
  if (hour < 6) return NIGHT_ALPHA;
  if (hour < 8) return NIGHT_ALPHA * (8 - hour) / 2;
  if (hour < 18) return 0;
  if (hour >= 21) return NIGHT_ALPHA;
  for (let i = 1; i < DUSK_STEPS.length; i++) {
    const [h0, a0] = DUSK_STEPS[i - 1], [h1, a1] = DUSK_STEPS[i];
    if (hour < h1) return NIGHT_ALPHA * (a0 + (a1 - a0) * (hour - h0) / (h1 - h0));
  }
  return NIGHT_ALPHA;
}

export type HourBucket = 'day' | 'dusk' | 'night';
/** Night before 6 and from 21; dusk on the two ramps (6–8, 18–21); day between. Drives window tiles and the sky. */
export function hourBucket(hour: number): HourBucket { if (hour < 6 || hour >= 21) return 'night'; if (hour < 8 || hour >= 18) return 'dusk'; return 'day'; }

/**
 * Sky gradient stops (zenith, horizon) for the hour: four stop pairs, blended an hour at a time.
 *
 * Dawn and dusk run through the same four stops in opposite order — night, evening, dusk, day — so the two ends
 * of the day are the same sky seen twice, and neither passes anywhere near red (visual QA C2).
 */
export function skyFor(hour: number): [string, string] {
  const S = PALETTE.sky;
  const blend = (from: readonly [string, string], to: readonly [string, string], t: number): [string, string] => [mixHex(from[0], to[0], t), mixHex(from[1], to[1], t)];
  if (hour < 5) return [S.night[0], S.night[1]];
  if (hour < 6) return blend(S.night, S.evening, hour - 5);
  if (hour < 7) return blend(S.evening, S.dusk, hour - 6);
  if (hour < 8) return blend(S.dusk, S.day, hour - 7);
  if (hour < 18) return [S.day[0], S.day[1]];
  if (hour < 19) return blend(S.day, S.dusk, hour - 18);
  if (hour < 20) return blend(S.dusk, S.evening, hour - 19);
  if (hour < 21) return blend(S.evening, S.night, hour - 20);
  return [S.night[0], S.night[1]];
}

/** Where the evening tint stops being warm and starts being violet, and where it has finished arriving. */
export const DUSK_WARM_UNTIL = 19.5, DUSK_VIOLET_BY = 20.5;
/**
 * Colour of the day/night overlay: warm on the early ramps, dusk violet later, deep blue at full night.
 *
 * It used to be `PALETTE.dusk` — a desaturated violet — across the whole ramp, which is what made a sunset fall
 * on a building as a slightly cooler noon (visual QA R2-I4). Dawn gets the same warmth for the same reason.
 */
export function nightColourFor(hour: number): number {
  if (hourBucket(hour) === 'night') return hexToInt(PALETTE.night);
  const t = Math.max(0, Math.min(1, (hour - DUSK_WARM_UNTIL) / (DUSK_VIOLET_BY - DUSK_WARM_UNTIL)));
  return hexToInt(mixHex(PALETTE.duskWarm, PALETTE.dusk, t));
}

/** Lamp glow alpha: 0 by day, following the tint ramp, 1 at full night. */
export function lampAlphaFor(hour: number): number { return tintFor(hour) / NIGHT_ALPHA; }

/** Sun from 6:00 until 18:00, moon otherwise (matches the window tiles' day bucket). */
export const sunOrMoon = (hour: number): 'sun' | 'moon' => (hour >= 6 && hour < 18 ? 'sun' : 'moon');

/**
 * What the bar's clock reads in live mode.
 *
 * `__cubicle.setHour` moves the office's own hour — the shot harness pins one per scene, so the daylight palette
 * is proved on the pixels rather than on whatever the wall clock happened to say (visual QA R-I4). The clock has
 * to move with it: fifteen scenes of an office in midday sun, each stamped 22:52, contradict themselves, and the
 * gallery is the first thing the owner opens. A pinned hour reads `HH:MM` — it is an hour, not a moment, and it
 * has no seconds to tick.
 */
export function clockText(now: Date, hourOverride: number | null = null): string {
  if (hourOverride === null) return now.toLocaleTimeString();
  const total = Math.round(((hourOverride % 24) + 24) % 24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export interface TimeHandlers { onLive(): void; onReplayRequest(date: string): void; onScrub(index: number): void; }

/** How much faster than real time a replay can run. The middle value is the one a fresh session opens on. */
export const SPEEDS = [1, 5, 10, 25, 50] as const;
export const DEFAULT_SPEED = 25;

/** `?replay=YYYY-MM-DD` loads that day once the socket is up; the daemon needs a moment before it can answer. */
export const REPLAY_AUTOLOAD_MS = 500;

/**
 * What the clock reads once a day is loaded. The "(Space pauses, arrows step)" that used to be crammed in here is a
 * keyboard hint, not a clock: it lives beside the transport (`#replay-hint`), and the label says what it is.
 */
export function replayLabel(events: { ts: string }[]): string {
  if (!events.length) return 'no events that day';
  return `${events.length} events · ${events[0].ts.slice(11, 19)}–${events[events.length - 1].ts.slice(11, 19)}`;
}

/** Live/replay controls: date picker loads a day's events; the slider scrubs through them at 1×–50×. */
export class TimeControls {
  private live = document.getElementById('live') as HTMLButtonElement;
  private date = document.getElementById('replay-date') as HTMLInputElement;
  private load = document.getElementById('replay-load') as HTMLButtonElement;
  private scrub = document.getElementById('scrub') as HTMLInputElement;
  private speedEl = document.getElementById('speed')!;
  private dateText = document.getElementById('replay-date-text')!;
  private clock = document.getElementById('clock')!;
  private sunmoon = document.getElementById('sunmoon')!;
  private bar = document.getElementById('time')!;
  private playBtn = document.getElementById('playpause') as HTMLButtonElement;
  private lastIcon = '';
  events: CubicleEvent[] = [];
  index = 0;
  playing = false;
  mode: 'live' | 'replay' = 'live';
  speed: number = DEFAULT_SPEED;
  private acc = 0;

  constructor(private h: TimeHandlers) {
    this.date.value = new Date().toISOString().slice(0, 10);
    // The native date input still holds and validates the value; the face beside it is ours, because the platform's
    // calendar glyph was the last browser-drawn widget on a bar of custom ones (visual QA R-M4).
    document.getElementById('replay-date-icon')!.innerHTML = pixelIcon('calendar');
    this.drawDate();
    this.date.addEventListener('input', () => this.drawDate());
    this.date.addEventListener('change', () => this.drawDate());
    const q = new URLSearchParams(location.search);
    if (q.get('replay')) { this.date.value = q.get('replay')!; this.drawDate(); setTimeout(() => this.load.click(), REPLAY_AUTOLOAD_MS); }
    this.live.addEventListener('click', () => { this.stopPlaying(); this.scrub.disabled = true; this.setMode('live'); h.onLive(); });
    // Pressing Replay is what reveals the transport, so the mode flips here rather than when the day's events land.
    this.load.addEventListener('click', () => { this.setMode('replay'); if (this.date.value) h.onReplayRequest(this.date.value); });
    this.scrub.addEventListener('input', () => { this.stopPlaying(); this.seek(Math.round((Number(this.scrub.value) / 1000) * this.events.length)); });
    // Play/pause is a button on the bar. It used to be a double-click on the range input: undiscoverable, and the
    // only other way in was a Space the clock's own label had to explain.
    this.playBtn.addEventListener('click', () => { this.togglePlay(); });
    this.drawSpeeds();
    this.speedEl.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-speed]');
      if (!b) return;
      this.speed = Number(b.dataset.speed);
      this.drawSpeeds();
    });
    this.setMode('live');
    this.drawPlay();
  }

  /**
   * The replay speed, as a segmented control in the bar's own vocabulary. It was a native `<select>`: the one
   * widget on the screen the browser drew itself, arrow and all, among otherwise custom controls (visual QA M3).
   */
  private drawSpeeds(): void {
    this.speedEl.innerHTML = SPEEDS.map((v) => `<button class="seg" role="tab" data-speed="${v}" aria-selected="${v === this.speed}">${v}×</button>`).join('');
  }

  /** Live and Replay are one segmented control: the selected segment is the only amber thing on the time bar. */
  private setMode(mode: 'live' | 'replay'): void {
    this.mode = mode;
    this.live.setAttribute('aria-selected', String(mode === 'live'));
    this.load.setAttribute('aria-selected', String(mode === 'replay'));
    this.bar.dataset.mode = mode;   // the stylesheet hides the replay transport in live mode
  }
  /** The date, as the bar's own type. Empty reads as an em dash rather than as a blank control. */
  private drawDate(): void { this.dateText.textContent = this.date.value || '\u2014'; }

  /** The transport's own face: the icon and the label say which way the button goes. */
  private drawPlay(): void {
    const next = this.playing ? 'pause' : 'play';
    this.playBtn.innerHTML = pixelIcon(next);
    this.playBtn.setAttribute('aria-label', `${this.playing ? 'Pause' : 'Play'} the replay (Space)`);
    this.playBtn.disabled = !this.events.length;
  }
  togglePlay(): void { if (this.mode === 'replay' && this.events.length) { this.playing = !this.playing; this.drawPlay(); } }
  /** Move the replay by `n` events (negative = back). */
  step(n: number): void { if (this.mode === 'replay' && this.events.length) { this.playing = false; this.drawPlay(); this.seek(this.index + n); } }

  setReplay(events: CubicleEvent[]): void {
    this.events = events; this.index = 0; this.playing = events.length > 0;
    this.setMode('replay');
    this.scrub.disabled = events.length === 0; this.scrub.value = '0';
    this.drawPlay();
    this.clock.textContent = replayLabel(events);
  }

  /** No day loaded yet (the request is still in flight): a stray scrub must not rebuild the office from nothing. */
  private seek(i: number): void { if (!this.events.length) return; this.index = Math.max(0, Math.min(this.events.length, i)); this.h.onScrub(this.index); this.scrub.value = String(Math.round((this.index / Math.max(1, this.events.length)) * 1000)); }

  /** A scrub stops the playback; the button has to say so. */
  private stopPlaying(): void { if (this.playing) { this.playing = false; this.drawPlay(); } }

  /**
   * Advance replay: events are spaced by their real timestamps divided by the speed factor. `hourOverride` is
   * `__cubicle.setHour`, so the sun/moon reads exactly the hour the office is tinted by — replay clock included.
   */
  tick(dtMs: number, nowLive: Date, hourOverride: number | null = null): void {
    const icon = sunOrMoon(hourOverride ?? this.hour(nowLive));
    if (icon !== this.lastIcon) { this.lastIcon = icon; this.sunmoon.innerHTML = pixelIcon(icon, { label: icon === 'sun' ? 'Daytime' : 'Night' }); }
    if (this.mode === 'live') { this.clock.textContent = clockText(nowLive, hourOverride); return; }
    if (this.index >= this.events.length) { this.stopPlaying(); return; }   // the day ran out: the button goes back to Play
    if (!this.playing) return;
    this.acc += dtMs * this.speed;
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
