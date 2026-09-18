/**
 * The people, driven by the reducer state.
 *
 * One body per role. The body owns nothing the state could own: it holds only what a snapshot cannot say — where
 * a person is between two places, which foot is forward, whether they have blinked lately, who they turned to
 * look at, and how long the bubble over their head has left.
 *
 * Walking is eased, not stepped. The router hands back the corners of a route and the body runs a constant-speed
 * arc-length walk along them with a short ease in and out at either end; nothing in here ever snaps to a cell,
 * which is the whole difference between a person crossing an office and a token crossing a board.
 */
import { PERSON_H, type Pt, type View } from './iso.js';
import { ACCENT, type AccentName, type Light, MATERIAL as M, OUTFIT, type OutfitName, TOOL, divisionChip, rgba } from './materials.js';
import { type Person, type Facing, type Pose, drawPerson, personFoot, personFrom } from './characters.js';
import { type G, bubble as drawBubble, plate, roundRect, UI_FONT } from './shapes.js';
import { shadowVec } from './props.js';
import { sweepShadow } from './shapes.js';
import { type CampusMap, type Router, type Seat, standAt } from './campus.js';
import type { AgentView, Bubble } from '../state.js';
import { nameLabelVisible, worldTextVisible } from './camera.js';

/** Cells a second. A cell is 64 screen px wide at zoom 1, so this is an unhurried office walk. */
export const SPEED = 2.4;
/** The pantry: a coffee after a finished job, and now and then after a long quiet spell at the desk. */
export const PANTRY_AFTER_MS = 90_000;
export const PANTRY_ROLL = 0.3;
export const PANTRY_STAY_MS = 6_000;
/** How long a mouth stays open and shut while someone is speaking. */
export const TALK_MS = 150;

export interface BodyDeps {
  map: CampusMap;
  router: Router;
  seatFor(role: string, room: string): Seat | null;
  roll?(): number;
}

export interface BodyContext {
  /** who is speaking in a meeting right now, for the others to turn to */
  speaker: { x: number; y: number; role: string } | null;
  /** the role the panel is focused on: their name plate shows at any zoom */
  selected: string | null;
  hovered: string | null;
}

/** The outfit family a role wears: its own family first, then what its division makes. */
export function outfitFor(v: AgentView): OutfitName {
  if (v.family === 'owner') return 'owner';
  if (v.family === 'chief') return 'chief';
  if (v.family === 'advisor') return 'advisor';
  if (v.family === 'manager') return 'manager';
  if (v.division === 'technology') return 'maker';
  if (v.division === 'revenue') return 'seller';
  return 'member';
}

const dist = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Which way a person faces, given the direction they are moving or looking, in grid units. */
export function facingFor(dx: number, dy: number): Facing {
  // screen-right is +x, screen-left is +y; the camera looks from the +x +y corner
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'se' : 'nw';
  return dy >= 0 ? 'sw' : 'ne';
}

export class Body {
  at: Pt;
  facing: Facing = 'se';
  pose: Pose = 'sit';
  /** 0..1, the walk cycle and the breathing idle */
  phase = Math.random();
  person: Person;
  view: AgentView;
  seat: Seat | null = null;

  private path: Pt[] = [];
  private target: string | null = null;
  private walkingTo: string | null = null;
  private routeSeq = 0;
  private travelled = 0;
  private blinkIn = 1 + Math.random() * 4;
  private blinking = 0;
  private talkSince = 0;
  private detour: 'pantry' | 'sit' | null = null;
  private sitLeft = 0;
  private pantryIdle = 0;
  private pantrySeat: Seat | null = null;
  private gone = false;
  private lookAt: Pt | null = null;
  private lastBubbleText = '';
  private bubbleSince = 0;

  constructor(view: AgentView, private deps: BodyDeps) {
    this.view = view;
    const home = this.homeAt();
    this.at = view.state === 'entering' ? { ...deps.map.door } : { ...home };
    this.person = personFrom(view.role, outfitFor(view), 'sit', 'se', {
      ...(view.family === 'advisor' || view.division === 'operations' ? { glasses: true } : {}),
      ...(view.family === 'chief' || view.family === 'manager' ? { tag: OUTFIT[outfitFor(view)].shirt } : {}),
    });
    this.facing = this.deps.map.desks[view.desk]?.side === 'near' ? 'nw' : 'se';
    if (view.state === 'entering') void this.goTo('home');
  }

  /** The seat at this role's own desk; a role with no desk stands at the entrance. */
  homeAt(): Pt { return this.deps.map.desks[this.view.desk]?.seat ?? this.deps.map.door; }
  /** Which desk-side a seated body takes, for the pose. */
  private deskSide(): 'far' | 'near' { return this.deps.map.desks[this.view.desk]?.side ?? 'far'; }

  /** Where a named place is, for this body: its own room means its own desk. */
  private resolve(name: string): Pt | null {
    if (name === 'home') return this.homeAt();
    if (name === 'seat' && this.seat) return this.seat.at;
    if (name === 'pantry' && this.pantrySeat) return this.pantrySeat.at;
    const desk = this.deps.map.desks[this.view.desk];
    if (desk && (name === desk.room || name === desk.zone)) return desk.seat;
    return standAt(this.deps.map, name);
  }

  /** Walk to a named place. A new target supersedes whatever route was in flight. */
  async goTo(name: string): Promise<void> {
    if (this.walkingTo === name) return;
    this.walkingTo = name;
    const dest = this.resolve(name);
    if (!dest) { this.walkingTo = null; this.path = []; return; }
    const seq = ++this.routeSeq;
    const route = await this.deps.router.find(this.at, dest);
    if (seq !== this.routeSeq) return;            // superseded while the path was computed
    this.path = route ?? [dest];
    this.travelled = 0;
    if (this.path.length && dist(this.path[0], this.at) < 0.2) this.path.shift();
  }

  private arrived(): void {
    this.walkingTo = null;
    if (this.view.state === 'leaving') this.gone = true;
    if (this.detour === 'pantry') { this.detour = 'sit'; this.sitLeft = PANTRY_STAY_MS; }
  }

  private startPantry(): void {
    const seat = this.deps.seatFor(this.view.role, 'pantry');
    if (!seat) return;
    this.pantrySeat = seat; this.detour = 'pantry'; this.target = 'home';
    void this.goTo('pantry');
  }
  private endDetour(): void { this.detour = null; this.sitLeft = 0; this.pantrySeat = null; this.target = null; }

  get moving(): boolean { return this.path.length > 0; }
  get hidden(): boolean { return this.gone || this.view.state === 'offline' ? this.gone : false; }
  /** Painter's depth on the single plane, a hair in front of the furniture the person stands beside. */
  get depth(): number { return this.at.x + this.at.y + 0.05; }

  update(view: AgentView, dt: number, nowMs: number, ctx: BodyContext): void {
    const prev = this.view;
    this.view = view;

    // a finished job earns a coffee; so, sometimes, does a long quiet spell at the desk
    if (prev.job && !view.job && view.state === 'walking' && !view.target && !this.detour) this.startPantry();
    if (this.detour && (view.target || (view.state !== 'walking' && view.state !== 'idle_at_desk'))) this.endDetour();
    if (!this.detour && view.state === 'idle_at_desk' && !view.job && !this.path.length) {
      this.pantryIdle += dt * 1000;
      if (this.pantryIdle >= PANTRY_AFTER_MS) { this.pantryIdle = 0; if ((this.deps.roll ?? Math.random)() < PANTRY_ROLL) this.startPantry(); }
    } else if (view.state !== 'idle_at_desk') this.pantryIdle = 0;

    const want = view.state === 'leaving' ? 'door'
      : view.state === 'entering' ? 'home'
        : view.target ?? (view.state === 'walking' ? 'home' : this.target ?? 'home');
    if (want !== this.target && !this.detour) {
      this.target = want;
      void this.goTo(this.deps.map.seats[want] ? (this.seat ? 'seat' : want) : want);
    }

    this.advance(dt);
    this.life(dt, nowMs, ctx);
  }

  /** Follow the route at a constant speed, easing out of the first corner and into the last. */
  private advance(dt: number): void {
    if (!this.path.length) return;
    let budget = SPEED * dt;
    // ease in over the first half cell and out over the last, so nobody starts or stops on a dime
    const left = this.path.reduce((n, p, i) => n + dist(i === 0 ? this.at : this.path[i - 1], p), 0);
    const ramp = Math.min(1, 0.35 + this.travelled / 0.6) * Math.min(1, 0.3 + left / 0.7);
    budget *= ramp;
    while (budget > 0 && this.path.length) {
      const next = this.path[0];
      const d = dist(this.at, next);
      if (d <= budget) {
        this.at = { ...next };
        budget -= d; this.travelled += d;
        this.path.shift();
        if (!this.path.length) { this.arrived(); break; }
      } else {
        const k = budget / d;
        const dx = next.x - this.at.x, dy = next.y - this.at.y;
        this.at = { x: this.at.x + dx * k, y: this.at.y + dy * k };
        this.facing = facingFor(dx, dy);
        this.travelled += budget;
        budget = 0;
      }
    }
    // the gait: a step per 0.9 cells walked, so a slow walk is a slow walk and not a fast one played back slowly
    this.phase = (this.travelled / 0.9) % 1;
  }

  /** Blinks, the talk cycle, the head turn, the pose. Timers only; nothing here changes state. */
  private life(dt: number, nowMs: number, ctx: BodyContext): void {
    const v = this.view;
    if (v.mood !== 'asleep') {
      if (this.blinking > 0) this.blinking -= dt;
      else { this.blinkIn -= dt; if (this.blinkIn <= 0) { this.blinkIn = 2 + Math.random() * 5; this.blinking = 0.12; } }
    }
    const speaking = v.bubble?.kind === 'speech';
    if (speaking && this.lastBubbleText !== v.bubble!.text) { this.lastBubbleText = v.bubble!.text; this.bubbleSince = nowMs; this.talkSince = nowMs; }
    if (!speaking) this.lastBubbleText = '';

    // Whoever is speaking in a meeting is the one the seated others look at. A head turn, not a shuffle: the body
    // stays where it is and only the facing changes, which is what a person at a table actually does.
    this.lookAt = null;
    if (!this.moving && ctx.speaker && ctx.speaker.role !== v.role && this.seat) this.lookAt = ctx.speaker;

    if (this.moving) this.pose = 'walk';
    else if (this.detour === 'sit') this.pose = 'sit';
    else if (this.seat && (v.target === 'boardroom' || v.target === 'meetingroom' || v.target === 'pantry')) this.pose = 'sit';
    else if (this.atHome()) this.pose = 'sit';
    else this.pose = v.state === 'talking' ? 'lean' : 'stand';

    if (this.detour === 'sit') { this.sitLeft -= dt * 1000; if (this.sitLeft <= 0) this.endDetour(); }

    if (!this.moving) {
      // breathing and typing: the same phase the walk uses, run slowly
      this.phase = (this.phase + dt * (this.pose === 'sit' && v.state === 'working' ? 0.9 : 0.22)) % 1;
      if (this.lookAt) this.facing = facingFor(this.lookAt.x - this.at.x, this.lookAt.y - this.at.y);
      else if (this.pose === 'sit') this.facing = this.seat ? seatFacing(this.seat) : this.deskSide() === 'near' ? 'nw' : 'se';
    }

    const p = this.person;
    p.pose = this.pose;
    p.facing = this.facing;
    p.phase = this.phase;
    p.blink = this.blinking > 0;
    p.mood = v.mood;
    p.talk = speaking && Math.floor((nowMs - this.talkSince) / TALK_MS) % 2 === 0;
  }

  private atHome(): boolean {
    return !this.moving && dist(this.at, this.homeAt()) < 0.6;
  }

  /** The shadow pass: one soft sweep under the feet, like every other object's. */
  shadow(g: G, v: View, light: Light): void {
    if (this.gone || !this.visible()) return;
    const at = v.p(this.at.x, this.at.y, 0);
    const s = shadowVec(v, light, PERSON_H * 0.72);
    sweepShadow(g, personFoot(at, PERSON_H * v.cz), s.dx, s.dy, light.shadowAlpha * 0.95, light.shadowTint);
  }

  visible(): boolean { return !this.gone && this.view.active !== false; }

  draw(g: G, v: View, light: Light): void {
    if (!this.visible()) return;
    const at = v.p(this.at.x, this.at.y, 0);
    const h = PERSON_H * v.cz;
    g.save();
    if (this.view.state === 'offline') g.globalAlpha = 0.4;
    drawPerson(g, at, h, this.person, light);
    g.restore();
  }

  /**
   * The chrome that belongs to a person: the name plate, the tool chip, the badge, and the bubble.
   *
   * Drawn in screen space in its own pass over the whole campus, never in the depth-sorted one — a label is the
   * one thing in the picture that must not be occluded by the desk in front of it.
   */
  drawLabel(g: G, v: View, ctx: BodyContext): void {
    if (!this.visible() || this.view.state === 'offline') return;
    const zoom = v.z;
    const head = v.p(this.at.x, this.at.y, PERSON_H + 0.18);
    const foot = v.p(this.at.x, this.at.y, 0);
    const selected = ctx.selected === this.view.role || ctx.hovered === this.view.role;
    if (nameLabelVisible(zoom) || selected) {
      plate(g, { x: foot.x, y: foot.y + 13 }, this.view.display, { size: 10.5, chip: divisionChip(this.view.division), alpha: selected ? 0.98 : 0.86, lift: selected ? 0 : 3, crowd: selected ? false : undefined });
    }
    if (!worldTextVisible(zoom)) return;
    const chips: { text: string; fill: string; ink: string }[] = [];
    if (this.view.tool) chips.push({ text: TOOL_GLYPH[this.view.tool], fill: TOOL[this.view.tool], ink: M.white });
    if (this.detour === 'sit') chips.push({ text: 'c', fill: M.walnut, ink: M.white });
    else if (this.view.badge) chips.push({ text: this.view.badge === 'error' ? '!' : '?', fill: this.view.badge === 'error' ? M.bad : ACCENT.amber.base, ink: M.white });
    if (chips.length) {
      const s = 13;
      let x = head.x - ((chips.length - 1) * (s + 3)) / 2;
      for (const c of chips) {
        roundRect(g, x - s / 2, head.y - s - 4, s, s, 4);
        g.fillStyle = c.fill; g.fill();
        g.font = `600 ${Math.round(s * 0.62)}px ${UI_FONT}`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = c.ink;
        g.fillText(c.text, x, head.y - s / 2 - 3.5);
        x += s + 3;
      }
    }
    const b = this.view.bubble;
    if (b) this.drawBubbleAt(g, { x: head.x, y: head.y - (chips.length ? 22 : 6) }, b, v);
  }

  private drawBubbleAt(g: G, at: Pt, b: Bubble, v: View): void {
    const text = b.kind === 'thought' && !b.text ? '· · ·' : b.text;
    const lines = wrap(g, text, 13, 230);
    drawBubble(g, at, lines, {
      size: 12.5,
      within: { w: v.cam.w, h: v.cam.h },
      tail: this.facing === 'se' || this.facing === 'ne' ? 'left' : 'right',
      ...(b.kind === 'action' ? { tint: rgba(M.actionFill, 0.92), ink: M.actionInk } : {}),
      ...(b.kind === 'thought' ? { tint: rgba(M.paper, 0.95), ink: M.thoughtInk } : {}),
    });
  }

  debug(): Record<string, unknown> {
    return {
      role: this.view.role, state: this.view.state, mood: this.view.mood, pose: this.pose, facing: this.facing,
      emote: this.view.emote?.kind ?? null, bubble: this.view.bubble?.kind ?? null, target: this.view.target,
      currentTarget: this.target, walkingTo: this.walkingTo, detour: this.detour, pathLen: this.path.length,
      at: { x: Math.round(this.at.x * 100) / 100, y: Math.round(this.at.y * 100) / 100 },
      tile: { tx: Math.round(this.at.x), ty: Math.round(this.at.y) },
      seat: this.seat ? { tx: Math.round(this.seat.at.x), ty: Math.round(this.seat.at.y) } : null,
      desk: this.view.desk, home: this.homeAt(),
    };
  }
}

/** Which way a chair at a table looks. */
function seatFacing(s: Seat): Facing { return s.facing; }

/** Drawn glyphs, never emoji: a headless or minimal system has no emoji font, and the office must still read. */
const TOOL_GLYPH: Record<string, string> = { browser: 'W', terminal: '>', envelope: 'M', doc: 'D', chart: '%', chat: '…' };

/** Break a line to fit `max` screen px, at most three lines, with an ellipsis where it runs out. */
export function wrap(g: G, text: string, size: number, max: number, maxLines = 3): string[] {
  g.save();
  g.font = `500 ${size}px ${UI_FONT}`;
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width <= max || !line) { line = next; continue; }
    out.push(line);
    line = w;
    if (out.length === maxLines) break;
  }
  if (out.length < maxLines && line) out.push(line);
  if (out.length === maxLines) {
    const used = out.join(' ').length;
    if (used < text.length - 1) out[maxLines - 1] = `${out[maxLines - 1].replace(/[.,;:]$/, '')}…`;
  }
  g.restore();
  return out.length ? out : [''];
}
