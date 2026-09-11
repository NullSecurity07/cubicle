import { describe, it, expect } from 'vitest';
import { morphChildren, morphNode, type MNode } from './morph.js';

/** Just enough of the DOM for the algorithm: elements (nodeType 1) with attributes and children, text (nodeType 3). */
class N implements MNode {
  nodeType: number; nodeName: string; nodeValue: string | null; attrs = new Map<string, string>(); childNodes: N[] = []; parent: N | null = null;
  sets = 0;   // how many times setAttribute ran (the test asserts nothing is set needlessly)
  constructor(name: string, text?: string) { this.nodeType = text !== undefined ? 3 : 1; this.nodeName = text !== undefined ? '#text' : name.toUpperCase(); this.nodeValue = text ?? null; }
  getAttributeNames(): string[] { return [...this.attrs.keys()]; }
  getAttribute(n: string): string | null { return this.attrs.get(n) ?? null; }
  setAttribute(n: string, v: string): void { this.sets++; this.attrs.set(n, v); }
  removeAttribute(n: string): void { this.attrs.delete(n); }
  insertBefore(n: N, ref: N | null): N { if (n.parent) n.parent.removeChild(n); const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length; this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n); n.parent = this; return n; }
  removeChild(n: N): N { this.childNodes = this.childNodes.filter((c) => c !== n); n.parent = null; return n; }
  html(): string { return this.nodeType === 3 ? this.nodeValue! : `<${this.nodeName.toLowerCase()}${[...this.attrs].map(([k, v]) => ` ${k}="${v}"`).join('')}>${this.childNodes.map((c) => c.html()).join('')}</${this.nodeName.toLowerCase()}>`; }
}
const el = (name: string, attrs: Record<string, string> = {}, kids: N[] = []): N => { const n = new N(name); for (const [k, v] of Object.entries(attrs)) n.attrs.set(k, v); for (const k of kids) n.insertBefore(k, null); return n; };
const tx = (s: string): N => new N('#text', s);

describe('morphChildren', () => {
  it('keeps a keyed image node and only touches the attribute that changed', () => {
    const img = el('img', { 'data-key': 'frame', src: 'a.jpg', alt: 'browser' });
    const box = el('div', {}, [el('p', {}, [tx('seq 1')]), img]);
    morphChildren(box, [el('p', {}, [tx('seq 2')]), el('img', { 'data-key': 'frame', src: 'b.jpg', alt: 'browser' })]);
    expect(box.childNodes[1]).toBe(img);           // same node: an <img> that is replaced would flash
    expect(img.getAttribute('src')).toBe('b.jpg');
    expect(img.sets).toBe(1);                       // alt was equal and was not re-set
    expect(box.html()).toBe('<div><p>seq 2</p><img data-key="frame" src="b.jpg" alt="browser"></img></div>');
  });
  it('moves a keyed node to its new position instead of recreating it', () => {
    const a = el('li', { 'data-key': 'a' }, [tx('a')]), b = el('li', { 'data-key': 'b' }, [tx('b')]);
    const list = el('ul', {}, [a, b]);
    morphChildren(list, [el('li', { 'data-key': 'b' }, [tx('b')]), el('li', { 'data-key': 'a' }, [tx('a!')])]);
    expect(list.childNodes[0]).toBe(b); expect(list.childNodes[1]).toBe(a);
    expect(list.html()).toBe('<ul><li data-key="b">b</li><li data-key="a">a!</li></ul>');
  });
  it('appends new children, removes surplus ones, and replaces a node whose tag changed', () => {
    const box = el('div', {}, [el('p', {}, [tx('one')]), el('p', {}, [tx('two')]), el('p', {}, [tx('three')])]);
    morphChildren(box, [el('h2', {}, [tx('one')]), el('p', {}, [tx('two')])]);
    expect(box.html()).toBe('<div><h2>one</h2><p>two</p></div>');
    morphChildren(box, [el('h2', {}, [tx('one')]), el('p', {}, [tx('two')]), el('p', {}, [tx('four')])]);
    expect(box.html()).toBe('<div><h2>one</h2><p>two</p><p>four</p></div>');
  });
  it('drops attributes that disappeared and updates text in place', () => {
    const t = tx('old');
    const p = el('p', { class: 'x', hidden: '' }, [t]);
    morphNode(p, el('p', { class: 'y' }, [tx('new')]));
    expect(p.getAttribute('hidden')).toBeNull();
    expect(p.getAttribute('class')).toBe('y');
    expect(p.childNodes[0]).toBe(t);
    expect(t.nodeValue).toBe('new');
  });
  it('leaves the children of a data-morph="skip" element alone', () => {
    const pre = el('pre', { 'data-morph': 'skip' }, [tx('user is reading this')]);
    const box = el('div', {}, [pre]);
    morphChildren(box, [el('pre', { 'data-morph': 'skip', class: 'term' }, [tx('replaced')])]);
    expect(box.childNodes[0]).toBe(pre);
    expect(pre.getAttribute('class')).toBe('term');
    expect(pre.childNodes[0].nodeValue).toBe('user is reading this');
  });
  it('a keyed node never adopts an unkeyed one of the same tag', () => {
    const box = el('div', {}, [el('div', {}, [tx('plain')])]);
    morphChildren(box, [el('div', { 'data-key': 'k' }, [tx('keyed')])]);
    expect(box.html()).toBe('<div><div data-key="k">keyed</div></div>');
    const keyed = box.childNodes[0];
    morphChildren(box, [el('div', {}, [tx('plain again')])]);
    expect(box.childNodes[0]).not.toBe(keyed);
    expect(box.html()).toBe('<div><div>plain again</div></div>');
  });
});
