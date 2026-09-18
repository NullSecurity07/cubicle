import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PALETTE, ZONE_TINT, divisionTint, zoneTint, familyOf, rolePalette, roleColor, hsl, hexToHsl, shade, hexToInt } from './palette.js';

describe('colour maths', () => {
  it('hsl → hex → hsl round-trips within rounding', () => {
    const hex = hsl(272, 0.22, 0.58);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    const back = hexToHsl(hex);
    expect(Math.abs(back.h - 272)).toBeLessThan(2);
    expect(Math.abs(back.s - 0.22)).toBeLessThan(0.02);
    expect(Math.abs(back.l - 0.58)).toBeLessThan(0.02);
  });
  it('shade moves lightness and clamps at the ends', () => {
    expect(hexToHsl(shade('#808080', 0.1)).l).toBeGreaterThan(hexToHsl('#808080').l);
    expect(shade('#ffffff', 0.5)).toBe('#ffffff');
    expect(shade('#000000', -0.5)).toBe('#000000');
  });
  it('hexToInt parses the accent', () => { expect(hexToInt('#e6a93c')).toBe(0xe6a93c); expect(PALETTE.amber).toBe('#e6a93c'); });
});

describe('zone tints', () => {
  it('every zone carries one of the four campus accents, and the three indigo rooms share one', () => {
    expect(Object.keys(ZONE_TINT).sort()).toEqual([
      'boardroom', 'ceo_office', 'dev', 'lobby', 'lounge', 'meetingroom', 'ops', 'pantry', 'qa', 'research', 'sales',
    ]);
    expect(zoneTint('dev')).toBe(zoneTint('qa'));
    expect(zoneTint('dev')).toBe(zoneTint('research'));
    // Five, not four. SP9 gives the four divisions an accent each and the rooms that belong to nobody — the
    // pantry, the lobby, the lounge — the neutral. Four would mean the pantry wearing a division's colour.
    expect(new Set(Object.values(ZONE_TINT)).size).toBe(5);
  });
  it('the executive suite is one tint across its three rooms, and an unknown zone falls back rather than throwing', () => {
    expect(zoneTint('ceo_office')).toBe(zoneTint('boardroom'));
    expect(zoneTint('meetingroom')).toBe(zoneTint('boardroom'));
    expect(zoneTint('nowhere')).toBe(zoneTint('pantry'));
  });
  it('a division\u2019s tint matches the zone its people sit in', () => {
    expect(divisionTint('technology')).toBe(zoneTint('dev'));
    expect(divisionTint('revenue')).toBe(zoneTint('sales'));
    expect(divisionTint('operations')).toBe(zoneTint('ops'));
    expect(divisionTint('nonesuch')).toBe(divisionTint('other'));
  });
});

describe('families and role palettes', () => {
  it('familyOf follows title, team and leadership', () => {
    expect(familyOf('ceo', {})).toBe('chief');
    expect(familyOf('cfo', { title: 'Chief Financial Officer', team: 'revenue', isLead: true })).toBe('chief');
    expect(familyOf('advisor_investor', { title: 'Investor', team: 'board' })).toBe('advisor');
    expect(familyOf('dev_manager', { title: 'Engineering Manager', team: 'dev', isLead: true })).toBe('manager');
    expect(familyOf('backend_engineer', { title: 'Backend Engineer', team: 'dev' })).toBe('member');
  });
  it('role palettes are deterministic, snapped to a 12-hue wheel, and lighter for members than chiefs', () => {
    const a = rolePalette('backend_engineer', 'member'), b = rolePalette('backend_engineer', 'member');
    expect(a).toEqual(b);
    expect(hexToHsl(a.shirt).h % 30).toBeLessThan(1.5);
    expect(hexToHsl(rolePalette('cto', 'chief').shirt).l).toBeLessThan(hexToHsl(rolePalette('sre', 'member').shirt).l);
    expect(hexToHsl(rolePalette('advisor_skeptic', 'advisor').shirt).s).toBeLessThan(0.4);
    expect(rolePalette('ceo', 'chief').accent).toBe('#c0392b');           // the CEO keeps the red tie
    expect(rolePalette('owner', 'owner').shirt).toBe('#2b2f3a');           // charcoal turtleneck
    for (const k of ['shirt', 'shirtDark', 'accent', 'hair', 'skin', 'trousers', 'ring'] as const) expect(a[k]).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('roleColor keeps the three known overrides and equals the ring', () => {
    expect(roleColor('ceo')).toBe(0x3fb8a6); expect(roleColor('cto')).toBe(0x4e9af2); expect(roleColor('coo')).toBe(0xb98ef2);
    expect(roleColor('qa_lead')).toBe(hexToInt(rolePalette('qa_lead', 'manager').ring));
  });
  /**
   * Visual QA M7 / R-M1: the CEO's ring was `#f2c14e`, which is the amber family the palette reserves for
   * attention, so in `08-board` the CEO alone carried a gold disc among blue and purple ones.
   */
  /**
   * Visual QA R2-M3: floor 4's identity hue was 30 at saturation 0.75, and the accent amber is hue 38 — so the
   * selected F4 rail chip and F4's room signs read as calls to action. The same rule the role rings live under.
   */
  it('gives no zone an identity hue the chrome has already spent', () => {
    // Amber is the action colour and `bad` is the failure colour; a zone wearing either turns its rail chip and
    // its desk chips into status. The Revenue floor's amber is the exception the spec asks for by name, and it is
    // desaturated well below the chrome's own — it is a material, not a call to action.
    for (const [name, spent] of [['accent', PALETTE.amber], ['bad', PALETTE.bad]] as const) {
      const ref = hexToHsl(spent);
      for (const [id, tint] of Object.entries(ZONE_TINT)) {
        if (id === 'sales' && name === 'accent') { expect(hexToHsl(tint).s).toBeLessThan(hexToHsl(PALETTE.amber).s); continue; }
        const c = hexToHsl(tint);
        const dh = Math.abs(((c.h - ref.h + 540) % 360) - 180);
        expect(dh > 25 || c.s < 0.3, `zone ${id} tint ${tint} against ${name}`).toBe(true);
      }
    }
  });
  it('gives no role a ring in the accent hue', () => {
    const amber = hexToHsl(PALETTE.amber);
    for (const role of ['ceo', 'cto', 'coo', 'qa_lead', 'dev_manager', 'advisor_skeptic']) {
      const ring = rolePalette(role, 'member').ring, c = hexToHsl(ring);
      const dh = Math.abs(((c.h - amber.h + 540) % 360) - 180);
      expect(dh > 25 || c.s < 0.25, `${role} ring ${ring}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// One palette drives the world and CSS (the spec's consistency rule). This is the lint that keeps it true: no
// colour literal may appear in `world/` outside the two palette tables themselves.
//
// SP9 moved both ends of this rule. `scenes/` is gone with the Phaser tower, so the walk covers `world/` alone;
// the two pixel drawers it used to excuse are gone with the tileset, and in their place `world/materials.ts`
// holds the campus materials while `world/palette.ts` holds what the chrome reads. Everything else — the vector
// renderers, the minimap, the bodies — derives its colours from those two and names none of its own.
// ---------------------------------------------------------------------------------------------------------------
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['world/palette.ts', 'world/materials.ts']);

function walk(dir: string, rel = ''): string[] {
  return readdirSync(join(SRC, dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return walk(dir, r);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [`${dir}/${r}`] : [];
  });
}

describe('one palette', () => {
  it('has no colour literal outside palette.ts and the two pixel drawers', () => {
    const offenders: string[] = [];
    for (const file of walk('world')) {
      if (ALLOWED.has(file)) continue;
      readFileSync(join(SRC, file), 'utf8').split('\n').forEach((line, i) => {
        if (line.includes('palette-lint: ignore')) return;
        if (/0x[0-9a-fA-F]{6}\b/.test(line) || /#[0-9a-fA-F]{6}\b/.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('carries the tokens the sweep needed, and keeps amber for attention only', () => {
    for (const k of ['screenText', 'screenInk', 'labelInk', 'labelStroke', 'barTrack', 'good', 'warn', 'bad', 'minimapBg', 'leaf', 'leafDark', 'bubbleFill', 'bubbleActionFill'] as const) {
      expect(PALETTE[k], k).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(Object.values(PALETTE.tool)).toHaveLength(6);
    for (const c of Object.values(PALETTE.tool)) expect(c, `tool ${c}`).not.toBe(PALETTE.amber);
    expect(PALETTE.screenText).not.toBe('#ffe9a8');   // the pale amber that was on all eight screen titles
  });

  it("desaturated the street planting into the tower's range", () => {
    // #43a047 was S 0.41 at L 0.46: the most saturated thing in the lower third of every shot, against the rule
    // that the ground stays quiet so sprites and screens dominate.
    expect(hexToHsl(PALETTE.leaf).s).toBeLessThan(0.4);
    expect(hexToHsl(PALETTE.leafDark).l).toBeLessThan(hexToHsl(PALETTE.leaf).l);
    expect(hexToHsl(PALETTE.leafLight).l).toBeGreaterThan(hexToHsl(PALETTE.leaf).l);
  });
});
