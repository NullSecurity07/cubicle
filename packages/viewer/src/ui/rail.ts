/**
 * The zone rail: Campus, then the seven zones of the campus in the spec's order, a colour bar per zone and up to
 * three activity dots. It replaces the floor rail — there are no floors to stack any more — and it answers the
 * same question the tower's rail did: where in the company am I, and where is anything happening.
 *
 * Keys 1–7 pick a zone and 0 frames the whole campus, which is the same shape the floor keys had.
 */
import { morph } from './morph.js';
import { esc } from './content.js';
import { shade } from '../world/palette.js';

export interface ZoneInfo {
  id: string; label: string; accent: string; color: string;
  agents: { role: string; color: string; state: string }[];
  meetings: number;
}
export interface RailDeps {
  summary(): ZoneInfo[];
  currentZone(): string;
  /** the divisions that sit in a zone, for the tab's tooltip */
  divisions(): Record<string, string[]>;
  onZone(id: string): void;
}

const ACTIVE = new Set(['working', 'talking', 'walking']);
/** How far a tab's fill sits below the zone's own tint, so white type on it clears 4.5:1. */
const DEEP = 0.2;
export function deepen(tint: string): string { return shade(tint, -DEEP); }

/** Which zone fills have actually moved since the last write: a beat that changes nothing writes nothing. */
export function deepChanges(prev: Record<string, string>, summary: { id: string; color: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const z of summary) { const deep = deepen(z.color); if (prev[z.id] !== deep) out[z.id] = deep; }
  return out;
}

/** The rail's own markup. The campus tab comes first: it is the zoom-out, and the one that is always available. */
export function railHtml(summary: ZoneInfo[], current: string, divisions: Record<string, string[]>): string {
  const tabs = [
    `<button class="tab campus" data-zone="campus" aria-current="${current === 'campus'}" title="The whole campus (0)" aria-label="The whole campus"><span class="n">Campus</span><span class="bar"></span></button>`,
  ];
  summary.forEach((z, i) => {
    const active = z.agents.filter((a) => ACTIVE.has(a.state)).slice(0, 3);
    const divs = divisions[z.id]?.length ? `: ${divisions[z.id].join(', ')}` : '';
    const meetings = z.meetings ? `, ${z.meetings} meeting${z.meetings === 1 ? '' : 's'}` : '';
    tabs.push(
      `<button class="tab" data-zone="${esc(z.id)}" style="--zone:${esc(z.color)}" aria-current="${current === z.id}"`
      + ` title="${esc(`${z.label}${divs}`)} (${i + 1})" aria-label="${esc(`${z.label}, ${active.length} active${meetings}`)}">`
      + `<span class="n">${esc(z.label)}</span><span class="bar"></span>`
      + `<span class="dots">${active.map((a) => `<i style="background:${esc(a.color)}"></i>`).join('')}</span></button>`,
    );
  });
  return tabs.join('');
}

export class Rail {
  private el = document.getElementById('rail')!;
  private deep: Record<string, string> = {};
  constructor(private deps: RailDeps) {
    this.el.hidden = false;
    this.el.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-zone]');
      if (tab?.dataset.zone) this.deps.onZone(tab.dataset.zone);
    });
  }
  /** The zone ids in rail order, so the number keys and the rail agree without a second table. */
  order(): string[] { try { return this.deps.summary().map((z) => z.id); } catch { return []; } }
  update(): void {
    let summary: ZoneInfo[];
    try { summary = this.deps.summary(); } catch { return; }   // the map is not loaded yet
    if (!summary.length) return;
    for (const [id, value] of Object.entries(deepChanges(this.deep, summary))) { this.el.style.setProperty(`--zone-${id}-deep`, value); this.deep[id] = value; }
    morph(this.el, railHtml(summary, this.deps.currentZone(), this.deps.divisions()));
  }
}
