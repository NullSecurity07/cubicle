import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCampus, type CampusMap } from './campus.js';
import { applyLayout, emptyLayout, type CampusLayout } from './layout.js';
import {
  Edits, NUDGE, SPOT_TAKEN, UNDO_MAX, addResource, addedLine, connect, disconnect, moveThing, moveZone, removeThing,
  resizeZone,
} from './editing.js';

const BASE: CampusMap = parseCampus(JSON.parse(readFileSync(fileURLToPath(new URL('../../../../config/world/office.json', import.meta.url)), 'utf8')));
const NAMES: Record<string, string> = { cto: 'CTO', backend_engineer: 'Backend engineer', ceo: 'CEO' };
const nameOf = (id: string): string => NAMES[id] ?? id;
/** A free patch of floor in the lobby walkway, well away from every desk. */
const FREE = { x: 24, y: 21 };

describe('moving something', () => {
  it('writes the desk\'s new corner and says whose desk it was', () => {
    const d = BASE.desks.cto;
    const step = moveThing(BASE, emptyLayout(), 'cto', { x: FREE.x, y: FREE.y }, nameOf)!;
    expect(step.said).toBe("Moved CTO's desk.");
    expect(step.layout.nodes.cto).toEqual({ x: FREE.x, y: FREE.y });
    expect(applyLayout(BASE, step.layout).desks.cto.rect.x0).toBe(FREE.x);
    expect(d.rect.x0).not.toBe(FREE.x);
  });

  it('refuses a spot another desk is already in', () => {
    const other = BASE.desks.ceo;
    expect(moveThing(BASE, emptyLayout(), 'cto', { x: other.rect.x0, y: other.rect.y0 }, nameOf)).toBeNull();
  });

  it('snaps to half a cell', () => {
    const step = moveThing(BASE, emptyLayout(), 'cto', { x: FREE.x + 0.3, y: FREE.y + 0.1 }, nameOf)!;
    expect(step.layout.nodes.cto).toEqual({ x: FREE.x + 0.5, y: FREE.y });
  });

  it('moves a resource about its own middle and names it in the sentence', () => {
    const m = applyLayout(BASE, { ...emptyLayout(), nodes: { note_1: { kind: 'note', x: 20, y: 20, label: 'Runway' } } });
    const step = moveThing(m, { ...emptyLayout(), nodes: { note_1: { kind: 'note', x: 20, y: 20, label: 'Runway' } } }, 'note_1', FREE, nameOf)!;
    expect(step.said).toBe('Moved the runway.');
    expect(step.layout.nodes.note_1).toMatchObject({ kind: 'note', x: FREE.x, y: FREE.y });
  });

  it('will not move a zone through the thing-drag path', () => {
    expect(moveThing(BASE, emptyLayout(), 'sales', FREE, nameOf)).toBeNull();
  });
});

describe('moving a zone', () => {
  it('takes every desk in it along, each with its own line in the note', () => {
    const z = BASE.zoneById.sales;
    const inZone = Object.values(BASE.desks).filter((d) => d.zone === 'sales' || d.room === 'sales');
    expect(inZone.length).toBeGreaterThan(1);
    const step = moveZone(BASE, emptyLayout(), 'sales', { x: z.rect.x0 - 1, y: z.rect.y0 })!;
    expect(step.said).toBe(`Moved ${z.label}.`);
    expect(step.layout.nodes.sales).toEqual({ x: z.rect.x0 - 1, y: z.rect.y0 });
    for (const d of inZone) expect(step.layout.nodes[d.id]).toEqual({ x: d.rect.x0 - 1, y: d.rect.y0 });
    expect(step.layout.nodes.sales).toEqual({ x: z.rect.x0 - 1, y: z.rect.y0 });
    const m = applyLayout(BASE, step.layout);
    for (const d of inZone) expect(m.desks[d.id].rect.x0).toBeCloseTo(d.rect.x0 - 1);
  });

  it('is nothing at all when the zone did not actually move', () => {
    const z = BASE.zoneById.sales;
    expect(moveZone(BASE, emptyLayout(), 'sales', { x: z.rect.x0, y: z.rect.y0 })).toBeNull();
    expect(moveZone(BASE, emptyLayout(), 'sales', { x: z.rect.x0 + 0.2, y: z.rect.y0 })).toBeNull();
  });

  it('keeps a room its own sub-cell offset rather than re-aligning a whole floor of desks', () => {
    const z = BASE.zoneById.sales;
    expect(z.rect.x0 % 0.5).not.toBe(0);                             // the template does not sit on the half grid
    const step = moveZone(BASE, emptyLayout(), 'sales', { x: z.rect.x0 + 1.4, y: z.rect.y0 })!;
    expect(step.layout.nodes.sales).toEqual({ x: z.rect.x0 + 1.5, y: z.rect.y0 });
  });

  it('resizes from a handle and leaves the desks where they were', () => {
    const step = resizeZone(BASE, emptyLayout(), 'sales', { x0: 36, y0: 20, x1: 50, y1: 30 })!;
    expect(step.layout.nodes.sales).toEqual({ x: 36, y: 20, w: 14, d: 10 });
    expect(Object.keys(step.layout.nodes)).toEqual(['sales']);
  });

  it('normalises a handle dragged past the opposite corner', () => {
    const step = resizeZone(BASE, emptyLayout(), 'sales', { x0: 50, y0: 30, x1: 36, y1: 20 })!;
    expect(step.layout.nodes.sales).toEqual({ x: 36, y: 20, w: 14, d: 10 });
  });
});

describe('adding something', () => {
  it('puts it down with the next free id and says what it is', () => {
    const step = addResource(BASE, emptyLayout(), 'note', { x: FREE.x + 0.2, y: FREE.y }, { body: 'Ask about runway' })!;
    expect(step.id).toBe('note_1');
    expect(step.said).toBe('Sticky note added.');
    expect(step.layout.nodes.note_1).toEqual({ kind: 'note', x: FREE.x, y: FREE.y, body: 'Ask about runway' });
    expect(applyLayout(BASE, step.layout).resources.note_1.label).toBe('Ask about runway');
  });

  it('refuses a spot that is taken', () => {
    const d = BASE.desks.cto;
    expect(addResource(BASE, emptyLayout(), 'browser', { x: (d.rect.x0 + d.rect.x1) / 2, y: (d.rect.y0 + d.rect.y1) / 2 })).toBeNull();
  });

  it('has a sentence for each kind', () => {
    expect(addedLine('browser')).toBe('Browser added.');
    expect(addedLine('doc')).toBe('Document added.');
    expect(addedLine('site')).toBe('Site added.');
    expect(addedLine('note')).toBe('Sticky note added.');
    expect(addedLine('station', 'deploy')).toBe('Deploy station added.');
  });
});

describe('taking something away', () => {
  const l: CampusLayout = { ...emptyLayout(), nodes: { browser_1: { kind: 'browser', x: FREE.x, y: FREE.y } }, connections: [{ from: 'cto', to: 'browser_1', kind: 'access' }, { from: 'cto', to: 'ceo', kind: 'peer' }] };
  const m = applyLayout(BASE, l);

  it('takes a resource at once, and its lines with it', () => {
    const step = removeThing(m, l, 'browser_1', nameOf)!;
    expect(step.said).toBe('Removed the browser.');
    expect(step.layout.nodes.browser_1).toBeUndefined();
    expect(step.layout.connections).toEqual([{ from: 'cto', to: 'ceo', kind: 'peer' }]);
    expect(step.pending).toBeUndefined();
  });

  it('turns a desk into a fire proposal and leaves the desk standing', () => {
    const step = removeThing(m, l, 'cto', nameOf)!;
    expect(step.said).toBe('Fire proposed — approve it in Decisions.');
    expect(step.layout).toBe(l);                                   // nothing is drawn away
    expect(step.pending).toEqual({ cto: { removed: true } });       // but the daemon is told
    expect(applyLayout(BASE, step.layout).desks.cto).toBeTruthy();
  });

  it('will not take a zone away at all', () => {
    expect(removeThing(m, l, 'sales', nameOf)).toBeNull();
  });
});

describe('wiring', () => {
  const l: CampusLayout = { ...emptyLayout(), nodes: { browser_1: { kind: 'browser', x: FREE.x, y: FREE.y } } };
  const m = applyLayout(BASE, l);

  it('says what a new peer line means', () => {
    const step = connect(m, l, 'cto', 'backend_engineer', nameOf)!;
    expect(step.said).toBe('Connected CTO and Backend engineer — they can message each other now.');
  });

  it('says what a new access line means, from the desk\'s side whichever end it was drawn from', () => {
    expect(connect(m, l, 'cto', 'browser_1', nameOf)!.said).toBe('CTO can use the browser now.');
    expect(connect(m, l, 'browser_1', 'cto', nameOf)!.said).toBe('CTO can use the browser now.');
  });

  it('is nothing when the line already exists or could never exist', () => {
    const once = connect(m, l, 'cto', 'backend_engineer', nameOf)!;
    expect(connect(m, once.layout, 'backend_engineer', 'cto', nameOf)).toBeNull();
    expect(connect(m, l, 'sales', 'cto', nameOf)).toBeNull();
  });

  it('cuts a line with one sentence, and says nothing about a line that was not there', () => {
    const once = connect(m, l, 'cto', 'backend_engineer', nameOf)!;
    expect(disconnect(once.layout, 'backend_engineer', 'cto')!.said).toBe('Removed the connection.');
    expect(disconnect(l, 'cto', 'ceo')).toBeNull();
  });
});

describe('the arrow keys', () => {
  it('nudge half a cell along the two isometric axes', () => {
    expect(NUDGE.ArrowUp).toEqual({ x: -0.5, y: -0.5 });
    expect(NUDGE.ArrowRight).toEqual({ x: 0.5, y: -0.5 });
    // up-then-down and left-then-right both come back to where they started
    for (const [a, b] of [['ArrowUp', 'ArrowDown'], ['ArrowLeft', 'ArrowRight']]) {
      expect(NUDGE[a].x + NUDGE[b].x).toBe(0);
      expect(NUDGE[a].y + NUDGE[b].y).toBe(0);
    }
  });
});

describe('the undo stack', () => {
  const step = (n: number): { layout: CampusLayout; said: string } => ({ layout: { ...emptyLayout(), nodes: { cto: { x: n } } }, said: 'x' });

  it('goes back one step at a time and then stops', () => {
    const e = new Edits();
    expect(e.canUndo).toBe(false);
    e.apply(step(1));
    e.apply(step(2));
    expect(e.layout.nodes.cto).toEqual({ x: 2 });
    e.undo();
    expect(e.layout.nodes.cto).toEqual({ x: 1 });
    e.undo();
    expect(e.layout.nodes.cto).toBeUndefined();
    expect(e.undo()).toBeNull();
  });

  it('remembers twenty steps and no more', () => {
    const e = new Edits();
    for (let i = 1; i <= UNDO_MAX + 5; i++) e.apply(step(i));
    for (let i = 0; i < UNDO_MAX; i++) expect(e.undo()).not.toBeNull();
    expect(e.undo()).toBeNull();
    expect(e.layout.nodes.cto).toEqual({ x: 5 });   // the five oldest steps fell off the bottom
  });

  it('sends what is pending without drawing it, and stops once the daemon has spoken', () => {
    const e = new Edits();
    const sent = e.apply({ layout: emptyLayout(), said: 'x', pending: { cto: { removed: true } } });
    expect(sent.nodes.cto).toEqual({ removed: true });
    expect(e.layout.nodes.cto).toBeUndefined();
    e.accept({ ...emptyLayout(), nodes: { cto: { removed: true } } });
    expect(e.pending).toEqual({});
    expect(e.toSend().nodes.cto).toEqual({ removed: true });
  });

  it('never lets the daemon\'s own word be undone', () => {
    const e = new Edits();
    e.accept({ ...emptyLayout(), nodes: { cto: { x: 9 } } });
    expect(e.canUndo).toBe(false);
  });

  it('has the one sentence for a spot that is taken', () => { expect(SPOT_TAKEN).toBe('That spot is taken.'); });
});
