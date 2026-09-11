/**
 * In-place DOM update for live views (visual notes §5): the panel re-renders a view's HTML on every event, and
 * this diff applies only what changed, so a live <img> keeps its texture, a growing terminal keeps its scroll
 * position and nothing flickers. Elements with `data-key` are matched by key; everything else by position.
 * The algorithm is written against `MNode`, the handful of DOM members it needs, so it is unit-tested without a DOM.
 */
export interface MNode {
  nodeType: number; nodeName: string; nodeValue: string | null;
  readonly childNodes: ArrayLike<MNode>;
  getAttributeNames(): string[]; getAttribute(n: string): string | null; setAttribute(n: string, v: string): void; removeAttribute(n: string): void;
  insertBefore(n: MNode, ref: MNode | null): unknown; removeChild(n: MNode): unknown;
}

const ELEMENT = 1, TEXT = 3;
const keyOf = (n: MNode): string | null => (n.nodeType === ELEMENT ? n.getAttribute('data-key') : null);

/** Make `from` look like `to` without replacing it. */
export function morphNode(from: MNode, to: MNode): void {
  if (from.nodeType === TEXT) { if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return; }
  for (const name of to.getAttributeNames()) { const v = to.getAttribute(name) ?? ''; if (from.getAttribute(name) !== v) from.setAttribute(name, v); }
  for (const name of from.getAttributeNames()) if (to.getAttribute(name) === null) from.removeAttribute(name);
  if (from.getAttribute('data-morph') === 'skip') return;
  morphChildren(from, Array.from(to.childNodes as ArrayLike<MNode>));
}

/** Reconcile `parent`'s children with `next` (nodes freshly parsed from the new HTML; they are moved in as needed). */
export function morphChildren(parent: MNode, next: MNode[]): void {
  const byKey = new Map<string, MNode>();
  for (const c of Array.from(parent.childNodes as ArrayLike<MNode>)) { const k = keyOf(c); if (k) byKey.set(k, c); }
  for (let i = 0; i < next.length; i++) {
    const want = next[i];
    const at = parent.childNodes[i] ?? null;
    const k = keyOf(want);
    const keyed = k ? byKey.get(k) : undefined;
    if (keyed) {
      if (at !== keyed) parent.insertBefore(keyed, at);
      morphNode(keyed, want);
      continue;
    }
    // An unkeyed node may adopt the unkeyed node in its slot when the tag agrees; keyed old nodes are never adopted
    // (a stale keyed node drifts to the tail and is removed below).
    const reusable = !!at && !k && !keyOf(at) && at.nodeType === want.nodeType && at.nodeName === want.nodeName;
    if (reusable) { morphNode(at, want); continue; }
    parent.insertBefore(want, at);
  }
  while (parent.childNodes.length > next.length) parent.removeChild(parent.childNodes[parent.childNodes.length - 1]);
}

/** Browser entry point: parse `html` once and morph `container`'s children to it. */
export function morph(container: Element, html: string): void {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  morphChildren(container as unknown as MNode, Array.from(tpl.content.childNodes) as unknown as MNode[]);
}
