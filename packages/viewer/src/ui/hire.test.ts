import { describe, it, expect, afterEach } from 'vitest';
import { HireSheet, type HireRequest, roleIdOf } from './hire.js';

/** Just enough of the DOM for the card: listeners, the children it looks up, and a body to append to. */
class E {
  hidden = false; id = ''; value = ''; innerHTML = ''; textContent = ''; focused = 0;
  readonly listeners: Record<string, ((ev: unknown) => void)[]> = {};
  readonly kids: E[] = [];
  private found: Record<string, E> = {};
  constructor(readonly tag: string) {}
  addEventListener(t: string, fn: (ev: unknown) => void): void { (this.listeners[t] ??= []).push(fn); }
  appendChild(c: E): E { this.kids.push(c); return c; }
  querySelector(sel: string): E { return (this.found[sel] ??= new E(sel)); }
  focus(): void { this.focused++; }
  fire(t: string, ev: unknown): void { for (const fn of this.listeners[t] ?? []) fn(ev); }
}
const ev = (): { prevented: boolean; preventDefault(): void } => ({ prevented: false, preventDefault(): void { this.prevented = true; } });
const realDoc = (globalThis as { document?: unknown }).document;
afterEach(() => { (globalThis as { document?: unknown }).document = realDoc; });

const mount = (): { sheet: HireSheet; el: E; hires: HireRequest[]; cancels: number } => {
  const body = new E('body');
  (globalThis as { document?: unknown }).document = { createElement: (t: string) => new E(t), body, activeElement: null };
  const hires: HireRequest[] = [];
  const m = { hires, cancels: 0, sheet: null as unknown as HireSheet, el: null as unknown as E };
  m.sheet = new HireSheet({
    teams: () => [{ id: 'growth', name: 'Revenue' }, { id: 'dev', name: 'Engineering' }],
    onHire: (r) => hires.push(r),
    onCancel: () => { m.cancels++; },
  });
  m.el = body.kids[0];
  return m;
};
const parts = (el: E): { form: E; name: E; role: E; team: E; where: E } => ({
  form: el.querySelector('form'), name: el.querySelector('#hire-name'), role: el.querySelector('#hire-role'),
  team: el.querySelector('#hire-team'), where: el.querySelector('#hire-where'),
});

describe('roleIdOf', () => {
  it('makes an id the daemon will take out of whatever the owner typed', () => {
    expect(roleIdOf('Head of Support')).toBe('head_of_support');
    expect(roleIdOf('  QA Lead!  ')).toBe('qa_lead');
    expect(roleIdOf('Support')).toBe('support');
  });
  it('never leaves a leading or trailing underscore', () => {
    expect(roleIdOf('— Growth —')).toBe('growth');
    expect(roleIdOf('')).toBe('');
  });
});

describe('the hire sheet', () => {
  it('says which room the desk landed in and offers the rooms the company has', () => {
    const m = mount();
    m.sheet.show({ x: 12, y: 20 }, 'Sales');
    const p = parts(m.el);
    expect(m.el.hidden).toBe(false);
    expect(p.where.textContent).toBe('The desk goes in Sales.');
    expect(p.team.innerHTML).toContain('Revenue');
    expect(p.team.innerHTML).toContain('Engineering');
  });

  it('writes the role id as the name is typed, and stops once the owner writes one themselves', () => {
    const m = mount();
    m.sheet.show({ x: 1, y: 1 }, null);
    const p = parts(m.el);
    p.name.value = 'Head of Support'; p.name.fire('input', {});
    expect(p.role.value).toBe('head_of_support');
    p.role.value = 'support'; p.role.fire('input', {});
    p.name.value = 'Head of Support Ops'; p.name.fire('input', {});
    expect(p.role.value).toBe('support');
  });

  it('sends the three answers and the spot, once, and closes', () => {
    const m = mount();
    m.sheet.show({ x: 12.5, y: 20 }, 'Sales');
    const p = parts(m.el);
    p.name.value = 'Head of Support'; p.name.fire('input', {});
    p.team.value = 'dev';
    p.form.fire('submit', ev());
    expect(m.hires).toEqual([{ role: 'head_of_support', display: 'Head of Support', team: 'dev', at: { x: 12.5, y: 20 } }]);
    expect(m.el.hidden).toBe(true);
    p.form.fire('submit', ev());
    expect(m.hires.length).toBe(1);
  });

  it('refuses to send a hire with no name', () => {
    const m = mount();
    m.sheet.show({ x: 1, y: 1 }, null);
    const p = parts(m.el);
    p.team.value = 'dev';
    p.form.fire('submit', ev());
    expect(m.hires).toEqual([]);
    expect(m.el.hidden).toBe(false);
  });

  it('Escape takes the ghost desk off the floor', () => {
    const m = mount();
    m.sheet.show({ x: 1, y: 1 }, null);
    m.el.fire('keydown', { key: 'Escape', stopPropagation: () => undefined });
    expect(m.cancels).toBe(1);
    expect(m.el.hidden).toBe(true);
  });

  it('forgets what was typed the last time it was opened', () => {
    const m = mount();
    m.sheet.show({ x: 1, y: 1 }, null);
    const p = parts(m.el);
    p.name.value = 'Head of Support'; p.name.fire('input', {});
    p.form.fire('submit', ev());
    m.sheet.show({ x: 4, y: 4 }, 'Dev');
    expect(p.name.value).toBe('');
    expect(p.role.value).toBe('');
  });
});
