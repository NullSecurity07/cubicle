import { describe, it, expect } from 'vitest';
import { PanelStack, type StackEvent } from './stack.js';

const e = (kind: string, title = kind) => ({ kind, title, presentation: 'sheet' as const });

describe('PanelStack', () => {
  it('pushes, reports the trail, pops back to the previous entry', () => {
    const s = new PanelStack();
    expect(s.current()).toBeNull();
    s.push(e('noticeboard', 'Queue'));
    s.push({ kind: 'job:job_a', title: 'Build site', presentation: 'reader' });
    expect(s.depth).toBe(2);
    expect(s.trail()).toEqual(['Queue', 'Build site']);
    expect(s.current()?.presentation).toBe('reader');
    expect(s.pop()?.kind).toBe('noticeboard');
    expect(s.pop()).toBeNull();
    expect(s.pop()).toBeNull();
    expect(s.depth).toBe(0);
  });
  it('pushing the current kind replaces it in place', () => {
    const s = new PanelStack();
    s.push(e('cabin', 'CEO'));
    s.push(e('cabin', 'CEO · PlateReady'));
    expect(s.depth).toBe(1);
    expect(s.current()?.title).toBe('CEO · PlateReady');
  });
  it('pushing a kind that is already deeper truncates back to it', () => {
    const s = new PanelStack();
    s.push(e('org')); s.push(e('agent:cto')); s.push(e('job:j1'));
    s.push(e('org', 'Org (2 teams)'));
    expect(s.trail()).toEqual(['Org (2 teams)']);
    expect(s.has('agent:cto')).toBe(false);
  });
  it('replace swaps the top entry and pushes when empty', () => {
    const s = new PanelStack();
    s.replace(e('bank'));
    expect(s.depth).toBe(1);
    s.push(e('vault'));
    s.replace(e('terminal'));
    expect(s.trail()).toEqual(['bank', 'terminal']);
  });
  it('emits one event per change with the entries after the change', () => {
    const s = new PanelStack();
    const seen: string[] = [];
    const off = s.on((ev: StackEvent) => seen.push(`${ev.type}:${ev.entry?.kind ?? '-'}:${ev.entries.length}`));
    s.push(e('a')); s.push(e('b')); s.replace(e('c')); s.pop(); s.pop(); s.pop(); s.push(e('d')); s.clear();
    expect(seen).toEqual(['push:a:1', 'push:b:2', 'replace:c:2', 'pop:a:1', 'pop:-:0', 'push:d:1', 'clear:-:0']);
    off();
    s.push(e('z'));
    expect(seen.length).toBe(7);
  });
  it('entries() is a copy', () => {
    const s = new PanelStack();
    s.push(e('a'));
    s.entries().pop();
    expect(s.depth).toBe(1);
  });
});
