/**
 * The panel's navigation stack (visual notes §5 "Panel system"): one entry per open thing, the top one visible.
 * Pure so it is unit-tested; `Panel` renders whatever is on top and pops on Escape.
 */
export type Presentation = 'sheet' | 'reader' | 'viewer';
export interface StackEntry { kind: string; title: string; presentation: Presentation }
export interface StackEvent { type: 'push' | 'pop' | 'replace' | 'clear'; entry: StackEntry | null; entries: StackEntry[] }

export class PanelStack {
  private items: StackEntry[] = [];
  private listeners: ((e: StackEvent) => void)[] = [];

  on(fn: (e: StackEvent) => void): () => void { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; }
  private emit(type: StackEvent['type']): void { const ev: StackEvent = { type, entry: this.current(), entries: this.entries() }; for (const l of this.listeners) l(ev); }

  get depth(): number { return this.items.length; }
  current(): StackEntry | null { return this.items[this.items.length - 1] ?? null; }
  entries(): StackEntry[] { return [...this.items]; }
  trail(): string[] { return this.items.map((e) => e.title); }
  has(kind: string): boolean { return this.items.some((e) => e.kind === kind); }

  /** Open something: a re-open of the current kind re-renders it; a kind already below goes back to it. */
  push(entry: StackEntry): void {
    const i = this.items.findIndex((e) => e.kind === entry.kind);
    if (i >= 0) { this.items.length = i; }
    this.items.push({ ...entry });
    this.emit(i >= 0 && i === this.items.length - 1 ? 'replace' : 'push');
  }
  replace(entry: StackEntry): void {
    if (!this.items.length) { this.items.push({ ...entry }); this.emit('push'); return; }
    this.items[this.items.length - 1] = { ...entry };
    this.emit('replace');
  }
  /** Back one level; returns the entry now on top (null when the stack emptied). Nothing happens on an empty stack. */
  pop(): StackEntry | null {
    if (!this.items.length) return null;
    this.items.pop();
    this.emit('pop');
    return this.current();
  }
  clear(): void { if (!this.items.length) return; this.items = []; this.emit('clear'); }
}
