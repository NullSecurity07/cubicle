import { describe, it, expect, afterEach } from 'vitest';
import { fuzzyScore, quickItems, rank, QuickOpen } from './quickopen.js';
import { applySnapshot, emptyState, type Snapshot } from '../state.js';

const snap: Snapshot = { op: 'snapshot', at: 'now', roles: [{ role: 'cto', display: 'CTO', sprite: 'cto', desk: 'cto', active: true, title: 'Chief Technology Officer' }, { role: 'backend_engineer', display: 'Backend', sprite: 'x', desk: 'backend_engineer', active: true, title: 'Backend Engineer' }], jobs: [], surfaces: [], quota: [], latestRun: null, plan: '', pendingProposals: 0, teams: [{ id: 'dev', name: 'Dev', lead: 'dev_manager', members: ['backend_engineer'], mission: '', room: 'dev', floor: 2 }] };
const s = applySnapshot(emptyState(), snap);

describe('quick open', () => {
  it('scores subsequences, prefers prefixes and word starts, rejects non-matches', () => {
    expect(fuzzyScore('xyz', 'Backend Engineer')).toBe(0);
    expect(fuzzyScore('bck', 'Backend Engineer')).toBeGreaterThan(0);
    expect(fuzzyScore('back', 'Backend Engineer')).toBeGreaterThan(fuzzyScore('bck', 'Backend Engineer'));
    expect(fuzzyScore('be', 'Backend Engineer')).toBeGreaterThan(fuzzyScore('be', 'Cabinet'));
    expect(fuzzyScore('', 'anything')).toBe(1);
  });
  it('lists screens, people and rooms', () => {
    const items = quickItems(s);
    expect(items.find((i) => i.kind === 'noticeboard')?.label).toBe('Queue');
    expect(items.find((i) => i.kind === 'agent:backend_engineer')).toMatchObject({ group: 'People', label: 'Backend', hint: 'Backend Engineer' });
    expect(items.find((i) => i.kind === 'dev')).toMatchObject({ group: 'Rooms', label: 'Dev' });
    expect(items.find((i) => i.kind === 'pantry')).toMatchObject({ group: 'Rooms', label: 'Pantry' });
    expect(items.find((i) => i.kind === 'cabin')?.label).toBe('Talk to the CEO');
  });
  it('ranks by score and caps the list', () => {
    const r = rank(quickItems(s), 'ba', 3);
    expect(r.length).toBeLessThanOrEqual(3);
    expect(r[0].kind).toMatch(/^(bank|agent:backend_engineer)$/);
    expect(rank(quickItems(s), 'zzzz')).toEqual([]);
    expect(rank(quickItems(s), '', 4).length).toBe(4);
  });
});

/** Just enough of the DOM for the palette: listeners, the two children it looks up, and a body to append to. */
class E {
  hidden = false; id = ''; value = ''; innerHTML = ''; focused = 0;
  readonly attrs: Record<string, string> = {};
  readonly listeners: Record<string, ((ev: unknown) => void)[]> = {};
  readonly kids: E[] = [];
  private found: Record<string, E> = {};
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  addEventListener(t: string, fn: (ev: unknown) => void): void { (this.listeners[t] ??= []).push(fn); }
  appendChild(c: E): E { this.kids.push(c); return c; }
  querySelector(sel: string): E { return (this.found[sel] ??= new E(sel)); }
  contains(): boolean { return true; }
  focus(): void { this.focused++; }
  fire(t: string, ev: unknown): void { for (const fn of this.listeners[t] ?? []) fn(ev); }
}
const key = (k: string): { key: string; stopped: boolean; prevented: boolean; stopPropagation(): void; preventDefault(): void } => ({
  key: k, stopped: false, prevented: false,
  stopPropagation(): void { this.stopped = true; }, preventDefault(): void { this.prevented = true; },
});
const realDoc = (globalThis as { document?: unknown }).document;
afterEach(() => { (globalThis as { document?: unknown }).document = realDoc; });

describe('quick open palette', () => {
  it('Escape closes the palette and never reaches the panel’s window handler', () => {
    const body = new E('body');
    (globalThis as { document?: unknown }).document = { createElement: (t: string) => new E(t), body, addEventListener: () => {}, activeElement: null };
    const picked: string[] = [];
    const q = new QuickOpen({ items: () => quickItems(s), onPick: (kind) => picked.push(kind) });
    const el = body.kids[0];
    const input = el.querySelector('input');
    q.open();
    expect(q.visible).toBe(true);
    expect(input.focused).toBe(1);

    const esc = key('Escape');
    input.fire('keydown', esc);
    expect(q.visible).toBe(false);                 // the palette goes first…
    expect(esc.stopped).toBe(true);                // …and the panel's window listener never sees it, so the sheet stays
    expect(picked).toEqual([]);

    q.open();
    input.value = 'pant';
    input.fire('input', key('a'));
    const enter = key('Enter');
    input.fire('keydown', enter);
    expect(enter.prevented).toBe(true);
    expect(picked).toEqual(['pantry']);
    expect(q.visible).toBe(false);
  });
});
