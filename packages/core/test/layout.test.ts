/**
 * `Office/campus.md`: the schema, the rules, the migration and the round trip.
 *
 * Everything here runs against the real campus (`config/world/office.json`), not a fixture: the rules the daemon
 * enforces are about *this* office's desks, zones and blocked cells, and a hand-made map would let a rule pass
 * that the shipped one refuses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadCampusMap, validateLayout, applyLayout, readLayout, writeLayout, impliedConnections, migrationLayout,
  connected, stationFor, stationId, deskOf, roleAtDesk, layoutBody, OfficeLayout, OFFICE_LAYOUT_PATH,
  type CampusLayout,
} from '../src/index.js';
import { scaffoldVault, loadOrg, stringifyNote, type Org, type Vault } from '../src/index.js';

const map = loadCampusMap();
let dir: string, vault: Vault, org: Org;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-layout-'));
  vault = (await scaffoldVault(dir)).vault;
  org = loadOrg(vault);
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const ok = (input: unknown): CampusLayout => validateLayout(map, org, input).layout;

describe('the campus map', () => {
  it('parses the shipped office', () => {
    expect(map.desks.cto).toBeTruthy();
    expect(map.zoneById.sales).toBeTruthy();
    expect(map.screens.workshop).toBeTruthy();
    expect(map.props.every((p) => !!p.id)).toBe(true);
    expect(map.resources).toEqual({});
  });

  it('a desk id is a role id for every charter the template ships', () => {
    for (const r of Object.values(org.roles)) expect(map.desks[r.desk], r.role).toBeTruthy();
    for (const r of Object.values(org.roles)) expect(deskOf(org, r.role)).toBe(r.desk);
    expect(roleAtDesk(org, 'cto')).toBe('cto');
  });
});

describe('validateLayout', () => {
  it('drops the bad line and keeps the rest', () => {
    const { layout, dropped } = validateLayout(map, org, {
      version: 1,
      nodes: {
        cto: { x: 9, y: 6 },
        nobody_at_all: { x: 3, y: 3 },
        cfo: { x: 'over there' },
      },
      connections: [{ from: 'cto', to: 'cfo', kind: 'peer' }],
    });
    expect(Object.keys(layout.nodes)).toEqual(['cto']);
    expect(layout.connections).toHaveLength(1);
    expect(dropped.map((d) => d.line).sort()).toEqual(['nodes.cfo', 'nodes.nobody_at_all']);
    expect(dropped.find((d) => d.line === 'nodes.nobody_at_all')!.reason).toContain('no desk, zone or prop');
  });

  it('refuses a spot off the campus and a spot on a wall', () => {
    const off = validateLayout(map, org, { nodes: { cto: { x: 200, y: 4 } } });
    expect(off.layout.nodes).toEqual({});
    expect(off.dropped[0].reason).toBe('that spot is off the campus');
    const wall = validateLayout(map, org, { nodes: { cto: { x: 0, y: 0 } } });
    expect(wall.dropped[0].reason).toBe('that spot is taken');
  });

  it('refuses two desks dropped on the same cells, and allows two that swap places', () => {
    const cto = map.desks.cto, cfo = map.desks.cfo;
    const clash = validateLayout(map, org, { nodes: { cto: { x: 9, y: 6 }, cfo: { x: 9.5, y: 6 } } });
    expect(Object.keys(clash.layout.nodes)).toEqual(['cto']);
    expect(clash.dropped[0].reason).toBe('that spot is taken');
    const swap = validateLayout(map, org, {
      nodes: { cto: { x: cfo.rect.x0, y: cfo.rect.y0 }, cfo: { x: cto.rect.x0, y: cto.rect.y0 } },
    });
    expect(swap.dropped).toEqual([]);
    expect(Object.keys(swap.layout.nodes).sort()).toEqual(['cfo', 'cto']);
  });

  it('judges what stands on the floor against the floor this write leaves, not the one it found', () => {
    // The owner drags the CTO's desk away and drops a note where it stood, in one gesture and one payload. The
    // office drew that as free, so the daemon refusing it would spring the note back for no reason the owner
    // could see. Their old cells are the ones the note is measured against.
    const cto = map.desks.cto;
    const middle = { x: (cto.rect.x0 + cto.rect.x1) / 2, y: (cto.rect.y0 + cto.rect.y1) / 2 };
    const onTop = validateLayout(map, org, { nodes: { note_1: { kind: 'note', x: middle.x, y: middle.y } } });
    expect(onTop.dropped[0].reason).toBe('that spot is taken');
    const after = validateLayout(map, org, {
      nodes: { cto: { x: 20, y: 20 }, note_1: { kind: 'note', x: middle.x, y: middle.y } },
    });
    expect(after.dropped).toEqual([]);
    expect(Object.keys(after.layout.nodes).sort()).toEqual(['cto', 'note_1']);
  });

  it('refuses two things dropped on one spot, the second one', () => {
    const two = validateLayout(map, org, {
      nodes: { note_1: { kind: 'note', x: 21, y: 20 }, note_2: { kind: 'note', x: 21.2, y: 20 } },
    });
    expect(Object.keys(two.layout.nodes)).toEqual(['note_1']);
    expect(two.dropped[0].reason).toBe('that spot is taken');
  });

  it('a desk keeps the size the campus gave it', () => {
    const { layout, dropped } = validateLayout(map, org, { nodes: { cto: { x: 9, y: 6, w: 40, d: 40 } } });
    expect(layout.nodes.cto).toEqual({ x: 9, y: 6 });
    expect(dropped[0].reason).toContain('keeps the size');
  });

  it('a zone may be moved and resized', () => {
    const l = ok({ nodes: { sales: { x: 36, y: 20, w: 12, d: 9 } } });
    expect(l.nodes.sales).toEqual({ x: 36, y: 20, w: 12, d: 9 });
    expect(validateLayout(map, org, { nodes: { sales: { w: 0, d: 4 } } }).dropped[0].reason).toContain('at least 3 cells');
  });

  it('names a resource kind_n and a station by its family', () => {
    // Two spots, not two names on one spot: each is measured by the floor its kind takes, and a kiosk at 21
    // and a station at 21.5 stand inside each other.
    const l = ok({ nodes: { browser_1: { kind: 'browser', x: 21, y: 20 }, station_email: { kind: 'station', x: 21.5, y: 17 } } });
    expect(l.nodes.browser_1.kind).toBe('browser');
    expect(l.nodes.station_email.tool).toBe('email');
    expect(validateLayout(map, org, { nodes: { browser_x: { kind: 'browser', x: 21, y: 20 } } }).dropped[0].reason).toContain('browser_1');
    expect(validateLayout(map, org, { nodes: { station_email: { kind: 'station', tool: 'deploy', x: 21, y: 20 } } }).dropped[0].reason).toContain('email station');
  });

  it('a connection has two different ends that exist, peer between desks and access to a resource', () => {
    const base = { nodes: { browser_1: { kind: 'browser', x: 21, y: 20 } } };
    const { layout, dropped } = validateLayout(map, org, {
      ...base,
      connections: [
        { from: 'cto', to: 'cto', kind: 'peer' },
        { from: 'cto', to: 'browser_1', kind: 'peer' },
        { from: 'cto', to: 'station_email', kind: 'access' },
        { from: 'browser_1', to: 'cto', kind: 'access' },
        { from: 'cto', to: 'browser_1', kind: 'access' },
      ],
    });
    // the reversed access is turned round and kept; the same pair a second time is a duplicate
    expect(layout.connections).toEqual([{ from: 'cto', to: 'browser_1', kind: 'access' }]);
    expect(dropped.map((d) => d.reason)).toEqual([
      'a connection needs two different ends',
      'a peer connection runs between two desks',
      'nothing called station_email on the campus',
      'those two are connected already',
    ]);
  });

  it('reads a role id as the desk it sits at', () => {
    const l = ok({ connections: [{ from: 'ceo', to: 'cto', kind: 'peer' }] });
    expect(l.connections[0]).toEqual({ from: deskOf(org, 'ceo'), to: deskOf(org, 'cto'), kind: 'peer' });
  });

  it('survives rubbish', () => {
    expect(ok(null)).toEqual({ version: 1, nodes: {}, connections: [] });
    expect(ok({ nodes: [], connections: 'lots' })).toEqual({ version: 1, nodes: {}, connections: [] });
  });
});

/**
 * Ruling W6-2. Hand-editing `cto:` to a coordinate inside a wall deleted the desk outright — out of `nodes:`,
 * out of the body's "Moved" list, with no error anywhere — so the note's own instructions ("edit a line here and
 * the office moves") destroyed the drag the owner had just made. A refusal may cost an explanation, never work.
 */
describe('a line the daemon will not take never costs the owner what they had (W6-2)', () => {
  const good = (): CampusLayout => {
    const l = validateLayout(map, org, { nodes: { cto: { x: 44, y: 8 } } });
    expect(l.dropped).toEqual([]);      // the fixture itself has to be a legal office, or the test proves nothing
    return l.layout;
  };

  it('keeps the last good position for a coordinate inside a wall, and says so in one sentence', () => {
    const before = good();
    const { layout, dropped } = validateLayout(map, org, { nodes: { cto: { x: 0, y: 0 } } }, before);
    expect(layout.nodes.cto).toEqual({ x: 44, y: 8 });          // the owner's drag survives their own typo
    expect(dropped).toHaveLength(1);
    expect(dropped[0].kept).toBe('44, 8');
    expect(dropped[0].sentence).toBe('cto: 0, 0 is inside a wall — kept at 44, 8');
  });

  it('keeps it for a coordinate off the campus too, and leaves every other line alone', () => {
    const before = good();
    const { layout, dropped } = validateLayout(map, org, { nodes: { cto: { x: 900, y: 900 }, cfo: { x: 9, y: 6 } } }, before);
    expect(layout.nodes.cto).toEqual({ x: 44, y: 8 });
    expect(layout.nodes.cfo).toEqual({ x: 9, y: 6 });
    expect(dropped[0].sentence).toBe('cto: 900, 900 is off the campus — kept at 44, 8');
  });

  it('says what it could not do even when there is nothing to keep', () => {
    const { layout, dropped } = validateLayout(map, org, { nodes: { who_even: { x: 4, y: 4 } } });
    expect(layout.nodes.who_even).toBeUndefined();
    expect(dropped[0].sentence).toBe('who_even: 4, 4 is not a desk, a zone or a prop on this campus');
    expect(dropped[0].kept).toBeUndefined();
  });

  it('does not put a kept desk back on cells this write has given to someone else', () => {
    const before = good();
    // the CFO takes the cells the CTO was on, and the CTO's own line is refused: two desks may not be kept
    // inside each other just because both were legal at different moments
    const { layout, dropped } = validateLayout(map, org, { nodes: { cfo: { x: 44, y: 8 }, cto: { x: 0, y: 0 } } }, before);
    expect(layout.nodes.cfo).toEqual({ x: 44, y: 8 });
    expect(layout.nodes.cto).toBeUndefined();
    expect(dropped[0].kept).toBeUndefined();
    expect(dropped[0].sentence).toBe('cto: 0, 0 is inside a wall');
  });

  it('keeps a line that was already drawn when the owner mistypes it', () => {
    const before = validateLayout(map, org, { connections: [{ from: 'ceo', to: 'cto', kind: 'peer' }] });
    expect(before.dropped).toEqual([]);
    const { layout, dropped } = validateLayout(map, org, { connections: [{ from: 'ceo', to: 'cto', kind: 'access' }] }, before.layout);
    expect(layout.connections).toEqual([{ from: 'ceo', to: 'cto', kind: 'peer' }]);
    expect(dropped[0].kept).toBe('as it was');
    expect(dropped[0].sentence).toContain('ceo → cto');
    expect(dropped[0].sentence).toContain('kept as it was');
  });

  it('writes the refusal into the note, and takes it out again on the next good save', () => {
    const before = good();
    const { layout, dropped } = validateLayout(map, org, { nodes: { cto: { x: 0, y: 0 } } }, before);
    writeLayout(vault, layout, 'daemon', org, dropped);
    const note = vault.readText(OFFICE_LAYOUT_PATH);
    expect(note).toContain("## Couldn't apply");
    expect(note).toContain('cto: 0, 0 is inside a wall — kept at 44, 8');
    expect(note).toContain('- CTO is at 44, 8.');                 // and the Moved list still has the desk
    writeLayout(vault, layout, 'daemon', org);
    expect(vault.readText(OFFICE_LAYOUT_PATH)).not.toContain("Couldn't apply");
  });

  it('reads the note against the last good layout, so a save in Obsidian cannot delete a desk', () => {
    const before = good();
    writeLayout(vault, before, 'owner', org);
    vault.writeText(OFFICE_LAYOUT_PATH, stringifyNote({ version: 1, nodes: { cto: { x: 30, y: 20 } }, connections: [] }, '# The office\n'), 'owner');
    const blind = readLayout(vault, map, org)!;
    expect(blind.layout.nodes.cto).toBeUndefined();               // what the daemon used to do: the desk is gone
    const kept = readLayout(vault, map, org, before)!;
    expect(kept.layout.nodes.cto).toEqual({ x: 44, y: 8 });
    expect(kept.dropped[0].sentence).toContain('kept at 44, 8');
  });
});

describe('applyLayout', () => {
  it('leaves the campus alone when there is nothing to apply', () => {
    expect(applyLayout(map, { version: 1, nodes: {}, connections: [] })).toBe(map);
  });

  it('moves a desk, its seat and its footprint', () => {
    const was = map.desks.cto;
    const dx = 2, dy = 1.5;
    const m = applyLayout(map, ok({ nodes: { cto: { x: was.rect.x0 + dx, y: was.rect.y0 + dy } } }));
    expect(m.desks.cto.rect.x0).toBeCloseTo(was.rect.x0 + dx);
    expect(m.desks.cto.seat.x).toBeCloseTo(was.seat.x + dx);
    expect(m.desks.cto.seat.y).toBeCloseTo(was.seat.y + dy);
    expect(m.desks.cto.rect.x1 - m.desks.cto.rect.x0).toBeCloseTo(was.rect.x1 - was.rect.x0);
    expect(map.desks.cto).toEqual(was);            // pure: the template map is untouched
    expect(m.grid).not.toBe(map.grid);
  });

  it('a zone that moves takes its desks with it, and a desk with its own line stays where the owner put it', () => {
    const zone = map.zoneById.qa;
    const inZone = Object.values(map.desks).filter((d) => d.zone === 'qa').map((d) => d.id);
    expect(inZone.length).toBeGreaterThan(1);
    const m = applyLayout(map, ok({
      nodes: { qa: { x: zone.rect.x0 + 1, y: zone.rect.y0 }, qa_lead: { x: 9, y: 6 } },
    }));
    expect(m.desks[inZone.find((id) => id !== 'qa_lead')!].rect.x0).toBeCloseTo(map.desks[inZone.find((id) => id !== 'qa_lead')!].rect.x0 + 1);
    expect(m.desks.qa_lead.rect.x0).toBe(9);
  });

  it('takes out what the owner removed and puts down what they added', () => {
    const prop = map.props[0];
    const m = applyLayout(map, ok({
      nodes: {
        [prop.id]: { removed: true },
        note_1: { kind: 'note', x: 21, y: 20, label: 'Ask the CFO about runway' },
      },
    }));
    expect(m.props.find((p) => p.id === prop.id)).toBeUndefined();
    expect(m.resources.note_1).toMatchObject({ kind: 'note', at: { x: 21, y: 20 }, label: 'Ask the CFO about runway' });
    expect(map.props).toHaveLength(map.props.length);
  });
});

describe('connections', () => {
  it('connected reads either way round', () => {
    const l = ok({ connections: [{ from: 'cto', to: 'ceo', kind: 'peer' }] });
    expect(connected(l, 'cto', 'ceo')).toBe(true);
    expect(connected(l, 'ceo', 'cto')).toBe(true);
    expect(connected(l, 'ceo', 'cfo')).toBe(false);
    expect(connected(null, 'ceo', 'cto')).toBe(false);
  });

  it('stationFor names the family a tool belongs to', () => {
    expect(stationFor('browser.goto')).toBe('browser');
    expect(stationFor('browser.*')).toBe('browser');
    expect(stationFor('email.send')).toBe('email');
    expect(stationFor('deploy.site')).toBe('deploy');
    expect(stationFor('site.publish')).toBe('deploy');
    expect(stationFor('analytics.pull')).toBe('analytics');
    expect(stationFor('skills.save')).toBe('memory');
    expect(stationFor('vault.read')).toBeNull();
    expect(stationId('email')).toBe('station_email');
  });
});

describe('the migration', () => {
  it('moves nothing and wires what the org already implies', () => {
    const l = migrationLayout(map, org);
    const overrides = Object.entries(l.nodes).filter(([, n]) => !n.kind);
    expect(overrides).toEqual([]);                          // day one looks exactly as it did
    expect(applyLayout(map, l).desks).toEqual(map.desks);
    expect(l.connections.some((c) => c.from === 'ceo' && c.kind === 'peer')).toBe(true);
  });

  it('connects every reporting line, so nobody is cut off from their lead', () => {
    const l = migrationLayout(map, org);
    for (const t of Object.values(org.teams)) {
      for (const m of t.members) {
        if (!org.roles[m] || !org.roles[t.lead]) continue;
        expect(connected(l, deskOf(org, t.lead), deskOf(org, m)), `${t.lead}↔${m}`).toBe(true);
      }
    }
    expect(connected(l, 'cto', 'dev_manager')).toBe(true);  // a room's lead answers to the division's
  });

  it('leaves every tool a charter lists usable: one station per family, and the desk wired to it', () => {
    const l = migrationLayout(map, org);
    for (const r of Object.values(org.roles)) {
      for (const tool of r.tools) {
        const family = stationFor(tool);
        if (!family) continue;
        expect(l.nodes[stationId(family)], `${family} station`).toBeTruthy();
        expect(connected(l, deskOf(org, r.role), stationId(family)), `${r.role} → ${family}`).toBe(true);
      }
    }
  });

  it('stands each station on a free cell beside its own screen', () => {
    const l = migrationLayout(map, org);
    const near = { browser: 'workshop', email: 'postoffice', deploy: 'terminal', analytics: 'newsstand', memory: 'vault' } as const;
    for (const [family, screen] of Object.entries(near)) {
      const n = l.nodes[stationId(family as keyof typeof near)];
      if (!n) continue;
      const stand = map.screens[screen].stand;
      expect(Math.hypot(n.x! - stand.x, n.y! - stand.y), family).toBeLessThan(4.5);
    }
    // and every one of them survives its own validation, on a free cell inside the campus
    expect(validateLayout(map, org, l).dropped).toEqual([]);
  });

  it('wires nothing the org does not already imply', () => {
    const implied = impliedConnections(org);
    const l = migrationLayout(map, org);
    for (const c of l.connections) expect(implied, `${c.from} ${c.to}`).toContainEqual(c);
    // the only ones it leaves out are stations nobody could use
    expect(implied.filter((c) => c.kind === 'peer')).toEqual(l.connections.filter((c) => c.kind === 'peer'));
  });

  it('is idempotent: validating what it produced changes nothing', () => {
    const l = migrationLayout(map, org);
    expect(validateLayout(map, org, l).layout).toEqual(l);
  });
});

describe('the note', () => {
  it('round-trips through markdown', () => {
    const l = ok({
      nodes: { cto: { x: 9, y: 6 }, note_1: { kind: 'note', x: 21, y: 20, label: 'Ask about runway' } },
      connections: [{ from: 'cto', to: 'ceo', kind: 'peer' }, { from: 'cto', to: 'note_1', kind: 'access' }],
    });
    writeLayout(vault, l, 'daemon', org);
    const back = readLayout(vault, map, org)!;
    expect(back.dropped).toEqual([]);
    expect(back.layout).toEqual(l);
  });

  it('a new vault is scaffolded with the office it shipped with', () => {
    expect(vault.exists(OFFICE_LAYOUT_PATH)).toBe(true);
    const read = readLayout(vault, map, org)!;
    expect(read.dropped).toEqual([]);
    expect(read.layout).toEqual(migrationLayout(map, org));
  });

  it('writes a body the owner can read', () => {
    const l = ok({
      // one cell south of the post office: a station is measured by the floor its kind takes (`resourceRect`),
      // and at y: 17 that footprint is under the post office screen itself.
      nodes: { station_email: { kind: 'station', x: 44, y: 18 } },
      connections: [{ from: 'ceo', to: 'cto', kind: 'peer' }, { from: 'ceo', to: 'station_email', kind: 'access' }],
    });
    const body = layoutBody(l, org);
    expect(body).toContain(`${org.roles.ceo.display} and ${org.roles.cto.display} can message each other.`);
    expect(body).toContain(`${org.roles.ceo.display} can send email.`);
  });

  it('the schema parses what the note holds', () => {
    const parsed = OfficeLayout.parse({ nodes: { cto: { x: 1, y: 2 } }, connections: [{ from: 'a', to: 'b', kind: 'peer' }] });
    expect(parsed.version).toBe(1);
    expect(OfficeLayout.safeParse({ connections: [{ from: 'a', to: 'b', kind: 'friend' }] }).success).toBe(false);
  });
});
