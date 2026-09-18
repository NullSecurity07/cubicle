/**
 * The office, as a list.
 *
 * The campus is a canvas, and a canvas has no accessibility tree: a screen reader on this page found
 * `generic [ref=e3] [cursor=pointer]` and nothing else, with fifty jobs, every board and every agent behind it.
 * Nobody who cannot use a pointer could reach any of it.
 *
 * So the office publishes an outline of itself beside the canvas: the people, the screens, the things the owner
 * has put on the floor, and what is waiting on them — each one a button that opens exactly what clicking it in
 * the room would open (`data-open` is routed by `Panel`, so a person is focused and a board is opened, the same
 * calls the pointer makes). It is `.sr-only`, so it costs the picture nothing and is the first thing Tab reaches.
 *
 * Pure: `officeOutline` is State → groups, so what the office says about itself is unit-tested without a DOM.
 */
import type { State } from '../state.js';
import { esc, humanTitle, who } from './content.js';
import { SURFACES } from './surfaces.js';

export interface OutlineItem { open: string; label: string; detail?: string }
export interface OutlineGroup { title: string; items: OutlineItem[] }

/** How many of a long list the outline names before it stops. A list nobody can get to the end of is a wall too. */
export const OUTLINE_MAX = 40;

const stateWord = (s: string): string => s.replace(/_/g, ' ');

/** What each wall screen is called, said the way the owner would say it rather than by its anchor's name. */
const SCREEN_LABEL: Record<string, string> = {
  billboard: 'Billboard', terminal: 'Shell', whiteboard: 'Plan', noticeboard: 'Queue', newsstand: 'Brief',
  postoffice: 'Decisions', vault: 'Vault', workshop: 'Site', bank: 'Bank',
};

/** The office as a list of places, people and things, in the order somebody would want to hear them. */
export function officeOutline(s: State): OutlineGroup[] {
  const groups: OutlineGroup[] = [];

  const needs = s.inbox.slice(0, OUTLINE_MAX).map((n) => ({
    open: `decision:${n.id}`,
    label: humanTitle(n.title),
    detail: n.board_pending ? 'the board is still arguing it' : n.pending ? 'decided, being applied' : 'needs you',
  }));
  if (needs.length) groups.push({ title: 'Needs you', items: needs });

  const people = Object.values(s.agents)
    .filter((a) => a.active)
    .sort((a, b) => a.display.localeCompare(b.display))
    .slice(0, OUTLINE_MAX)
    .map((a) => ({
      open: `agent:${a.role}`,
      label: a.display,
      detail: [a.title || '', stateWord(a.state), a.job ? `on ${humanTitle(s.jobs[a.job]?.title ?? a.job)}` : ''].filter(Boolean).join(', '),
    }));
  if (people.length) groups.push({ title: 'People', items: people });

  // The screens on the walls, each with the line it is showing: a board nobody can see is a board nobody can read.
  const screens = Object.values(SURFACES).filter((su) => !!su.headline).slice(0, OUTLINE_MAX).map((su) => {
    const h = su.headline(s);
    return { open: su.kind, label: SCREEN_LABEL[su.kind] ?? humanTitle(su.kind), detail: [h.head, ...h.lines].filter(Boolean).join(' · ') };
  });
  if (screens.length) groups.push({ title: 'Screens', items: screens });

  const things = Object.entries(s.layout?.nodes ?? {})
    .filter(([, n]) => !!n.kind && !n.removed)
    .slice(0, OUTLINE_MAX)
    .map(([id, n]) => ({ open: `thing:${id}`, label: n.label || id, detail: `${n.kind}${n.tool ? ` · ${n.tool}` : ''}` }));
  if (things.length) groups.push({ title: 'On the floor', items: things });

  const lines = s.layout?.connections ?? [];
  if (lines.length) {
    groups.push({
      title: 'Connections',
      items: lines.slice(0, OUTLINE_MAX).map((c) => ({
        open: 'org',
        label: `${who(s, c.from)} and ${who(s, c.to)}`,
        detail: c.kind === 'peer' ? 'can message each other' : 'can use it',
      })),
    });
  }
  return groups;
}

/** The outline as HTML. One `<h2>` per group, one button per item; the button is what the pointer would click. */
export function outlineHtml(groups: OutlineGroup[]): string {
  return groups.map((g) => `<h2>${esc(g.title)}</h2><ul>${g.items.map((i) =>
    `<li><button data-open="${esc(i.open)}">${esc(i.label)}${i.detail ? ` — ${esc(i.detail)}` : ''}</button></li>`).join('')}</ul>`).join('');
}

/** Keeps the outline beside the canvas in step with the state, and rebuilds only when it would read differently. */
export class OfficeOutline {
  private el = document.getElementById('office-a11y');
  private was = '';
  update(s: State): void {
    if (!this.el) return;
    const html = outlineHtml(officeOutline(s));
    if (html === this.was) return;
    this.was = html;
    this.el.innerHTML = html;
  }
}
