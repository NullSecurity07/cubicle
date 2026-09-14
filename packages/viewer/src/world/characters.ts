/**
 * The character painter.
 *
 * One function draws every person in the campus, at any size, from a small record. The figure is a real silhouette
 * rather than a sprite: soft-cornered head, tapered torso, capsule limbs, a hair shape and glasses per person, and
 * a pose — standing, walking, seated, leaning on a counter. It is drawn in screen space at a height in pixels, so
 * the same painter serves the campus overview (about 23 px) and room zoom (56 px) with nothing but a number changed.
 *
 * Level of detail is a function of that number: eyes and mouth appear above 26 px, glasses above 20 px, the lanyard
 * above 34 px. Nothing is ever drawn at a size where it would turn into noise.
 */
import { type Pt } from './iso.js';
import { HAIR, type Light, MATERIAL as M, type OutfitName, OUTFIT, SKIN, dim, lit, mix, rgba, shade, top, warm } from './materials.js';
import { type G, fillPoly, roundRect, twoTone } from './shapes.js';

export type Facing = 'se' | 'sw' | 'ne' | 'nw';
export type Pose = 'stand' | 'walk' | 'sit' | 'lean';
export type HairStyle = 'crop' | 'short' | 'bob' | 'bun' | 'curls' | 'ponytail' | 'long' | 'bald';

export interface Person {
  id: string;
  outfit: OutfitName;
  hair: number;
  style: HairStyle;
  skin: number;
  glasses?: boolean;
  pose: Pose;
  facing: Facing;
  /** 0–1, varies the walk cycle and the idle lean so no two figures are the same frame */
  phase?: number;
  /** a lanyard, tie or scarf: the one saturated note on an otherwise calm figure */
  tag?: string;
  /** eyes shut this frame */
  blink?: boolean;
  /** mouth open: the half of a talk cycle where the speaker is mid-word */
  talk?: boolean;
  /** brows down and mouth flat (worried), up (happy), one brow up (puzzled) — the reducer's mood, drawn */
  mood?: 'neutral' | 'happy' | 'worried' | 'puzzled' | 'asleep' | 'thinking';
}

/** A deterministic person from an id — a role keeps the same face from one run to the next. */
export function personFrom(id: string, outfit: OutfitName, pose: Pose, facing: Facing, over: Partial<Person> = {}): Person {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const styles: HairStyle[] = ['crop', 'short', 'bob', 'bun', 'curls', 'ponytail', 'long', 'bald'];
  return {
    id, outfit, pose, facing,
    // `>>>`, not `>>`: an id whose hash lands above 2^31 gives a signed shift a negative index, and a negative
    // index into the hair table is an undefined colour half the agents of the day would be painted with.
    hair: h % HAIR.length,
    style: styles[(h >>> 3) % styles.length],
    skin: (h >>> 7) % SKIN.length,
    glasses: ((h >>> 11) & 3) === 0,
    phase: ((h >>> 13) & 255) / 255,
    ...over,
  };
}

/** A capsule between two points — every limb in the campus. */
function capsule(g: G, a: Pt, b: Pt, w: number, fill: string | CanvasGradient): void {
  const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * (w / 2), ny = (dx / l) * (w / 2);
  const pts = [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }];
  g.save();
  g.beginPath();
  const r = w / 2;
  g.moveTo(pts[0].x, pts[0].y);
  g.lineTo(pts[1].x, pts[1].y);
  g.arcTo(b.x + (dx / l) * r * 1.3 + nx, b.y + (dy / l) * r * 1.3 + ny, pts[2].x, pts[2].y, r);
  g.lineTo(pts[2].x, pts[2].y);
  g.lineTo(pts[3].x, pts[3].y);
  g.arcTo(a.x - (dx / l) * r * 1.3 - nx, a.y - (dy / l) * r * 1.3 - ny, pts[0].x, pts[0].y, r);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.restore();
}

/** The footprint a person's shadow is swept from — an octagon at the feet, not a hard rectangle. */
export function personFoot(at: Pt, h: number): Pt[] {
  const rx = h * 0.17, ry = h * 0.085;
  const out: Pt[] = [];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + 0.39; out.push({ x: at.x + Math.cos(a) * rx, y: at.y + Math.sin(a) * ry }); }
  return out;
}

/**
 * Draw a person with their feet at `at` and `h` pixels from sole to crown.
 *
 * `sitZ` lifts the hips onto a seat: pass the seat height in pixels for a seated pose. `light` only tints the figure
 * — the dusk wash over the whole campus does the rest, so a person never reads as a different colour to the room.
 */
export function drawPerson(g: G, at: Pt, h: number, p: Person, light: Light): void {
  const o = OUTFIT[p.outfit];
  const skin = SKIN[p.skin % SKIN.length];
  const hairC = HAIR[p.hair % HAIR.length];
  const ph = p.phase ?? 0;
  const away = p.facing === 'ne' || p.facing === 'nw';
  const sx = p.facing === 'se' || p.facing === 'ne' ? 1 : -1;   // which way the figure looks on screen
  const seated = p.pose === 'sit';
  const breathe = Math.sin(ph * Math.PI * 2) * h * 0.006;

  // vertical landmarks, measured up from the feet
  const headH = h * 0.25, headW = h * 0.235;
  const crown = -h + breathe;
  const chin = crown + headH;
  const shoulder = chin + h * 0.035;
  const hip = seated ? -h * 0.30 : -h * 0.44;
  const shoulderY = seated ? shoulder + h * 0.10 : shoulder;
  const X = (dx: number): number => at.x + dx;
  const Y = (dy: number): number => at.y + dy;

  const shirt = o.shirt;
  const trouser = o.trouser;
  const shoe = shade(trouser, -0.09);

  // ---- legs -------------------------------------------------------------------------------------------------
  const legW = h * 0.105;
  if (seated) {
    // thigh forward along the facing, shin down to the floor
    const kneeX = X(sx * h * 0.20), kneeY = Y(hip + h * 0.015);
    capsule(g, { x: X(-sx * h * 0.02), y: Y(hip) }, { x: kneeX, y: kneeY }, legW * 1.15, twoTone(g, { x: X(-h * 0.1), y: kneeY - h * 0.1, w: h * 0.4, h: h * 0.2 }, lit(trouser), dim(trouser)));
    capsule(g, { x: kneeX, y: kneeY }, { x: X(sx * h * 0.215), y: Y(-h * 0.04) }, legW, twoTone(g, { x: kneeX - h * 0.1, y: kneeY, w: h * 0.2, h: h * 0.3 }, lit(trouser), dim(trouser)));
    roundRect(g, X(sx * h * 0.215) - h * 0.075, Y(-h * 0.055), h * 0.15, h * 0.055, h * 0.022);
    g.fillStyle = shoe; g.fill();
  } else if (p.pose === 'walk') {
    const step = Math.sin(ph * Math.PI * 2);
    const front = { x: X(sx * h * 0.115 * (0.5 + step * 0.9)), y: Y(0) };
    const back = { x: X(-sx * h * 0.115 * (0.5 + step * 0.9)), y: Y(-h * 0.03) };
    capsule(g, { x: X(-h * 0.035), y: Y(hip) }, back, legW, dim(trouser));
    roundRect(g, back.x - h * 0.07, back.y - h * 0.03, h * 0.14, h * 0.05, h * 0.02);
    g.fillStyle = shade(shoe, -0.04); g.fill();
    capsule(g, { x: X(h * 0.035), y: Y(hip) }, front, legW, twoTone(g, { x: front.x - h * 0.1, y: Y(hip), w: h * 0.2, h: -hip }, lit(trouser), dim(trouser)));
    roundRect(g, front.x - h * 0.075, front.y - h * 0.05, h * 0.15, h * 0.05, h * 0.02);
    g.fillStyle = shoe; g.fill();
  } else {
    const spread = p.pose === 'lean' ? h * 0.085 : h * 0.055;
    for (const s of [-1, 1]) {
      capsule(g, { x: X(s * h * 0.045), y: Y(hip) }, { x: X(s * spread), y: Y(0) }, legW, s * sx > 0 ? twoTone(g, { x: X(s * spread) - h * 0.1, y: Y(hip), w: h * 0.2, h: -hip }, lit(trouser), dim(trouser)) : dim(trouser));
      roundRect(g, X(s * spread) - h * 0.072, Y(-h * 0.05), h * 0.144, h * 0.05, h * 0.02);
      g.fillStyle = s * sx > 0 ? shoe : shade(shoe, -0.04); g.fill();
    }
  }

  // ---- torso ------------------------------------------------------------------------------------------------
  const shW = h * 0.185, hipW = h * 0.145;
  const lean = p.pose === 'lean' ? sx * h * 0.03 : 0;
  const torso: Pt[] = [
    { x: X(-shW + lean), y: Y(shoulderY) },
    { x: X(shW + lean), y: Y(shoulderY) },
    { x: X(hipW), y: Y(hip + h * 0.02) },
    { x: X(-hipW), y: Y(hip + h * 0.02) },
  ];
  fillPoly(g, torso, h * 0.075, warm(shirt, 0.035, 3), dim(shirt), 0.5);

  // ---- arms -------------------------------------------------------------------------------------------------
  const armW = h * 0.082;
  const sleeve = mix(shirt, M.black, 0.06);
  const handY = seated ? hip - h * 0.03 : hip + h * 0.05;
  if (seated) {
    // reaching to a desk or a table in front: forearm along the facing
    const elbow = { x: X(sx * h * 0.11 + lean), y: Y(shoulderY + h * 0.12) };
    capsule(g, { x: X(sx * shW * 0.85 + lean), y: Y(shoulderY + h * 0.015) }, elbow, armW, twoTone(g, { x: elbow.x - h * 0.1, y: Y(shoulderY), w: h * 0.2, h: h * 0.2 }, lit(sleeve), dim(sleeve)));
    capsule(g, elbow, { x: X(sx * h * 0.26), y: Y(handY) }, armW * 0.92, lit(sleeve));
    roundRect(g, X(sx * h * 0.26) - h * 0.045, Y(handY) - h * 0.04, h * 0.09, h * 0.075, h * 0.035);
    g.fillStyle = skin; g.fill();
  } else if (p.pose === 'lean') {
    const elbow = { x: X(sx * h * 0.17), y: Y(shoulderY + h * 0.13) };
    capsule(g, { x: X(sx * shW * 0.8), y: Y(shoulderY + h * 0.02) }, elbow, armW, lit(sleeve));
    capsule(g, elbow, { x: X(sx * h * 0.30), y: Y(shoulderY + h * 0.05) }, armW * 0.9, lit(sleeve));
    roundRect(g, X(sx * h * 0.30) - h * 0.045, Y(shoulderY + h * 0.03), h * 0.09, h * 0.07, h * 0.032);
    g.fillStyle = skin; g.fill();
    capsule(g, { x: X(-sx * shW * 0.8), y: Y(shoulderY + h * 0.02) }, { x: X(-sx * h * 0.13), y: Y(hip + h * 0.03) }, armW, dim(sleeve));
  } else {
    const swing = p.pose === 'walk' ? Math.sin(ph * Math.PI * 2 + Math.PI) * h * 0.07 : 0;
    capsule(g, { x: X(-sx * shW * 0.82), y: Y(shoulderY + h * 0.02) }, { x: X(-sx * (h * 0.135 + swing * 0.4)), y: Y(hip + h * 0.045 + Math.abs(swing) * 0.2) }, armW, dim(sleeve));
    capsule(g, { x: X(sx * shW * 0.82), y: Y(shoulderY + h * 0.02) }, { x: X(sx * (h * 0.13 - swing * 0.4)), y: Y(hip + h * 0.045) }, armW, twoTone(g, { x: X(0), y: Y(shoulderY), w: h * 0.25, h: h * 0.3 }, lit(sleeve), dim(sleeve)));
    roundRect(g, X(sx * (h * 0.13 - swing * 0.4)) - h * 0.042, Y(hip + h * 0.04), h * 0.085, h * 0.07, h * 0.032);
    g.fillStyle = skin; g.fill();
  }

  // ---- the lanyard, above 34 px ---------------------------------------------------------------------------------
  if (p.tag && h > 34) {
    g.strokeStyle = rgba(p.tag, 0.85);
    g.lineWidth = Math.max(1, h * 0.018);
    g.beginPath();
    g.moveTo(X(-shW * 0.5 + lean), Y(shoulderY + h * 0.02));
    g.lineTo(X(lean * 1.2), Y(shoulderY + h * 0.13));
    g.lineTo(X(shW * 0.5 + lean), Y(shoulderY + h * 0.02));
    g.stroke();
    roundRect(g, X(lean * 1.2) - h * 0.028, Y(shoulderY + h * 0.13), h * 0.056, h * 0.045, h * 0.012);
    g.fillStyle = p.tag; g.fill();
  }

  // ---- neck and head -------------------------------------------------------------------------------------------
  capsule(g, { x: X(lean * 0.6), y: Y(chin - h * 0.005) }, { x: X(lean * 0.8), y: Y(shoulderY + h * 0.012) }, h * 0.07, dim(skin));
  const hx = X(lean * 0.6 + sx * h * 0.012) - headW / 2;
  const hy = Y(crown);
  roundRect(g, hx, hy, headW, headH, headW * 0.4);
  g.fillStyle = twoTone(g, { x: hx, y: hy, w: headW, h: headH }, warm(skin, 0.03, 2), dim(skin), 0.56);
  g.fill();

  // ears
  if (h > 30 && !away) {
    roundRect(g, hx + (sx > 0 ? -headW * 0.06 : headW * 0.98), hy + headH * 0.42, headW * 0.09, headH * 0.18, headW * 0.05);
    g.fillStyle = dim(skin); g.fill();
  }

  // ---- hair ----------------------------------------------------------------------------------------------------
  const hairLit = warm(hairC, 0.05, 4);
  const hairFill = twoTone(g, { x: hx, y: hy, w: headW, h: headH }, hairLit, dim(hairC), 0.52);
  const cap = (frac: number, over = 0.06): void => {
    roundRect(g, hx - headW * over, hy - headH * 0.03, headW * (1 + over * 2), headH * frac, headW * 0.42);
    g.fillStyle = hairFill; g.fill();
  };
  switch (p.style) {
    case 'bald': {
      roundRect(g, hx + headW * 0.1, hy - headH * 0.02, headW * 0.8, headH * 0.2, headW * 0.3);
      g.fillStyle = rgba(dim(skin), 0.5); g.fill();
      break;
    }
    case 'crop': cap(0.42); break;
    case 'short': {
      cap(0.5);
      roundRect(g, hx + (sx > 0 ? headW * 0.5 : -headW * 0.06), hy + headH * 0.02, headW * 0.56, headH * 0.3, headW * 0.2);
      g.fillStyle = hairFill; g.fill();
      break;
    }
    case 'bob': {
      cap(0.5, 0.1);
      for (const s of [-1, 1]) {
        roundRect(g, hx + (s < 0 ? -headW * 0.12 : headW * 0.94), hy + headH * 0.1, headW * 0.2, headH * 0.62, headW * 0.1);
        g.fillStyle = s * sx > 0 ? hairLit : dim(hairC); g.fill();
      }
      break;
    }
    case 'long': {
      cap(0.48, 0.1);
      for (const s of [-1, 1]) {
        roundRect(g, hx + (s < 0 ? -headW * 0.14 : headW * 0.92), hy + headH * 0.08, headW * 0.24, headH * 1.15, headW * 0.12);
        g.fillStyle = s * sx > 0 ? hairLit : dim(hairC); g.fill();
      }
      break;
    }
    case 'bun': {
      g.beginPath();
      g.arc(hx + headW * (sx > 0 ? 0.08 : 0.92), hy + headH * 0.02, headW * 0.22, 0, Math.PI * 2);
      g.fillStyle = dim(hairC); g.fill();
      cap(0.44);
      break;
    }
    case 'curls': {
      for (let i = 0; i < 5; i++) {
        g.beginPath();
        g.arc(hx + headW * (0.08 + i * 0.21), hy + headH * (0.06 + (i % 2) * 0.05), headW * 0.19, 0, Math.PI * 2);
        g.fillStyle = i % 2 ? hairLit : hairC; g.fill();
      }
      cap(0.3);
      break;
    }
    case 'ponytail': {
      cap(0.44);
      capsule(g, { x: hx + headW * (sx > 0 ? 0.08 : 0.92), y: hy + headH * 0.25 }, { x: hx + headW * (sx > 0 ? -0.16 : 1.16), y: hy + headH * 0.95 }, headW * 0.2, dim(hairC));
      break;
    }
  }

  // ---- face, above 26 px ---------------------------------------------------------------------------------------
  if (!away && h > 26) {
    const eyeY = hy + headH * 0.55;
    const ex = hx + headW * (sx > 0 ? 0.34 : 0.24);
    const e = Math.max(1, headW * 0.1);
    const shut = p.blink || p.mood === 'asleep';
    g.fillStyle = rgba(M.eye, 0.82);
    if (shut) {
      // two short strokes, not two dots: a closed eye at this size is a line, and a dot that merely got smaller
      // reads as a smaller open eye rather than as a blink.
      g.strokeStyle = rgba(M.eye, 0.8);
      g.lineWidth = Math.max(1, e * 0.8);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(ex, eyeY + e * 0.6); g.lineTo(ex + e, eyeY + e * 0.6);
      g.moveTo(ex + headW * 0.3, eyeY + e * 0.6); g.lineTo(ex + headW * 0.3 + e, eyeY + e * 0.6);
      g.stroke();
    } else {
      roundRect(g, ex, eyeY, e, e * 1.15, e * 0.4); g.fill();
      roundRect(g, ex + headW * 0.3, eyeY, e, e * 1.15, e * 0.4); g.fill();
    }
    if (h > 40) {
      // the brows carry the mood; the mouth carries whether they are speaking
      const worry = p.mood === 'worried' || p.mood === 'puzzled';
      if (worry || p.mood === 'happy') {
        g.strokeStyle = rgba(M.eye, 0.5);
        g.lineWidth = Math.max(1, headW * 0.05);
        g.lineCap = 'round';
        const by = hy + headH * 0.44;
        g.beginPath();
        g.moveTo(ex - headW * 0.02, by + (worry ? headW * 0.05 : -headW * 0.02));
        g.lineTo(ex + e + headW * 0.02, by + (worry ? -headW * 0.02 : -headW * 0.04));
        g.moveTo(ex + headW * 0.28, by + (p.mood === 'puzzled' ? -headW * 0.06 : worry ? -headW * 0.02 : -headW * 0.04));
        g.lineTo(ex + headW * 0.32 + e, by + (worry ? headW * 0.05 : -headW * 0.02));
        g.stroke();
      }
      g.strokeStyle = rgba(shade(skin, -0.26), 0.85);
      g.lineWidth = Math.max(1, headW * 0.055);
      g.lineCap = 'round';
      if (p.talk) {
        roundRect(g, ex + headW * 0.08, hy + headH * 0.72, headW * 0.22, headH * 0.13, headH * 0.05);
        g.fillStyle = rgba(shade(skin, -0.3), 0.85);
        g.fill();
      } else {
        g.beginPath();
        const my = hy + headH * 0.78;
        g.moveTo(ex + headW * 0.05, my + (p.mood === 'worried' ? headW * 0.03 : 0));
        if (p.mood === 'happy') g.quadraticCurveTo(ex + headW * 0.18, my + headW * 0.07, ex + headW * 0.3, my);
        else g.lineTo(ex + headW * 0.3, my + (p.mood === 'worried' ? headW * 0.03 : 0));
        g.stroke();
      }
    }
  }
  if (p.glasses && !away && h > 20) {
    const gy = hy + headH * 0.46;
    const gw = headW * 0.34, gh = headH * 0.26;
    const gx = hx + headW * (sx > 0 ? 0.26 : 0.1);
    g.strokeStyle = rgba(M.spectacle, 0.78);
    g.lineWidth = Math.max(1, headW * 0.06);
    roundRect(g, gx, gy, gw, gh, gh * 0.35); g.stroke();
    roundRect(g, gx + gw + headW * 0.09, gy, gw, gh, gh * 0.35); g.stroke();
    g.beginPath();
    g.moveTo(gx + gw, gy + gh * 0.45);
    g.lineTo(gx + gw + headW * 0.09, gy + gh * 0.45);
    g.stroke();
    roundRect(g, gx, gy, gw, gh, gh * 0.35);
    g.fillStyle = rgba(M.glassLens, 0.2); g.fill();
    roundRect(g, gx + gw + headW * 0.09, gy, gw, gh, gh * 0.35);
    g.fillStyle = rgba(M.glassLens, 0.2); g.fill();
  }

  // a warm rim on the lit shoulder, only where it will be seen
  if (h > 30) {
    g.strokeStyle = rgba(light.name === 'dusk' ? M.rimDusk : M.white, light.name === 'dusk' ? 0.3 : 0.22);
    g.lineWidth = Math.max(1, h * 0.016);
    g.beginPath();
    g.moveTo(X(-shW + lean), Y(shoulderY + h * 0.05));
    g.lineTo(X(-shW * 0.75 + lean), Y(shoulderY + h * 0.004));
    g.lineTo(X(-shW * 0.1 + lean), Y(shoulderY - h * 0.004));
    g.stroke();
  }
  void top;
}
