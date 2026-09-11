import { describe, it, expect, afterEach } from 'vitest';
import { FirstRun } from './firstrun.js';

/** Just enough of the DOM for the card: listeners, the children it looks up, and a body to append to. */
class E {
  hidden = false; id = ''; value = ''; innerHTML = ''; focused = 0;
  readonly classes: string[] = [];
  readonly listeners: Record<string, ((ev: unknown) => void)[]> = {};
  readonly kids: E[] = [];
  private found: Record<string, E> = {};
  constructor(readonly tag: string) {}
  readonly classList = { add: (c: string) => this.classes.push(c), remove: (c: string) => { const i = this.classes.indexOf(c); if (i >= 0) this.classes.splice(i, 1); } };
  addEventListener(t: string, fn: (ev: unknown) => void): void { (this.listeners[t] ??= []).push(fn); }
  appendChild(c: E): E { this.kids.push(c); return c; }
  querySelector(sel: string): E { return (this.found[sel] ??= new E(sel)); }
  querySelectorAll(): E[] { return []; }
  focus(): void { this.focused++; }
  fire(t: string, ev: unknown): void { for (const fn of this.listeners[t] ?? []) fn(ev); }
}
const ev = (): { prevented: boolean; preventDefault(): void } => ({ prevented: false, preventDefault(): void { this.prevented = true; } });
const realDoc = (globalThis as { document?: unknown }).document;
afterEach(() => { (globalThis as { document?: unknown }).document = realDoc; });

const mount = (): { card: FirstRun; el: E; started: string[]; surprises: number; dismissed: number } => {
  const body = new E('body');
  (globalThis as { document?: unknown }).document = { createElement: (t: string) => new E(t), body, activeElement: null };
  const started: string[] = [];
  const m = { started, surprises: 0, dismissed: 0, card: null as unknown as FirstRun, el: null as unknown as E };
  m.card = new FirstRun({ onStart: (t) => started.push(t), onSurprise: () => { m.surprises++; }, onDismissed: () => { m.dismissed++; } });
  m.el = body.kids[0];
  return m;
};

describe('first-run card', () => {
  it('sends one idea however many times Start is pressed', () => {
    const m = mount();
    const form = m.el.querySelector('form'), input = m.el.querySelector('#fr-input');
    m.card.show();
    input.value = '  A meal-planning site  ';
    form.fire('submit', ev());
    form.fire('submit', ev());                       // the double-click of an impatient owner
    expect(m.started).toEqual(['A meal-planning site']);
    expect(m.surprises).toBe(0);
  });

  it('ignores Start and Surprise me while it is hidden, and empty input sends nothing', () => {
    const m = mount();
    const form = m.el.querySelector('form'), surprise = m.el.querySelector('[data-fr="surprise"]');
    form.fire('submit', ev());                       // never shown
    surprise.fire('click', ev());
    expect(m.started).toEqual([]); expect(m.surprises).toBe(0);

    m.card.show();
    form.fire('submit', ev());                       // input still empty
    expect(m.started).toEqual([]);
    surprise.fire('click', ev());
    surprise.fire('click', ev());
    expect(m.surprises).toBe(1);                     // one idea per card, here too
  });

  it('show() does not overwrite what it must return focus to, and Escape only hides', () => {
    const m = mount();
    const opener = new E('button');
    (globalThis as { document: { activeElement: unknown } }).document.activeElement = opener;
    m.card.show();
    expect(m.card.visible).toBe(true);
    const input = m.el.querySelector('#fr-input');
    (globalThis as { document: { activeElement: unknown } }).document.activeElement = input;
    m.card.show();                                   // a second snapshot would trap focus on the card's own input
    expect(input.focused).toBe(2);

    const esc = { key: 'Escape', stopped: false, stopPropagation(): void { this.stopped = true; } };
    m.el.fire('keydown', esc);
    expect(m.card.visible).toBe(false);
    expect(esc.stopped).toBe(true);                  // the sheet underneath survives; the cabin keeps asking
    expect(opener.focused).toBe(1);
  });
});

/**
 * C3, second half: the office coach mark and the card are both first-contact messages, and `01-first-run.png` had
 * them up side by side. The app holds the mark back and shows it on this callback instead.
 */
describe('the card hands first contact on when it goes', () => {
  it('reports its dismissal once, whichever way it was dismissed', () => {
    const m = mount();
    m.card.show();
    m.card.hide();
    expect(m.dismissed).toBe(1);
  });
  it('says nothing when it was never up: a returning owner gets the coach mark straight away', () => {
    const m = mount();
    m.card.hide();
    expect(m.dismissed).toBe(0);
  });
  it('does not report twice when hide() is called again', () => {
    const m = mount();
    m.card.show(); m.card.hide(); m.card.hide();
    expect(m.dismissed).toBe(1);
  });
  it('reports it from Escape too, which is the path that leaves the office bare', () => {
    const m = mount();
    m.card.show();
    m.el.fire('keydown', { key: 'Escape', stopPropagation: () => undefined });
    expect(m.card.visible).toBe(false);
    expect(m.dismissed).toBe(1);
  });
});
