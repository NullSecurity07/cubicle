/** The floor rail (visual notes §5): F4..F1 and L, a colour bar per floor, up to three activity dots, keys 1–4 / L. */
import { morph } from './morph.js';
import { esc } from './content.js';
import { floorPalette, shade } from '../world/palette.js';

export interface FloorInfo { floor: number; label: string; color: string; agents: { role: string; color: string; state: string }[]; meetings: number }
export interface RailDeps { summary(): FloorInfo[]; currentFloor(): number; inLobby(): boolean; divisions(): Record<number, string[]>; onFloor(n: number): void; onLobby(): void }

/** F1's corridor starts at row 41 + 10 (spec §A): the camera centre at or below it means "the lobby". */
export const LOBBY_ROW = 51;
const ACTIVE = new Set(['working', 'talking', 'walking']);

/**
 * How far the current tab's fill sits below the floor's own tint. White on the raw tints runs from 5.1:1 (F1 purple)
 * down to 2.6:1 (F4 orange); one lightness step of 0.18 in the floor's own hue puts every floor past 4.5:1 without
 * inventing a colour — the tint on the bar and the fill under it stay the same hue (rail.test.ts asserts all four).
 */
const DEEP = 0.18;
/** The fill behind white text for a floor tint. */
export function deepen(tint: string): string { return shade(tint, -DEEP); }
/** The same, for a floor number, straight from the shared palette. */
export function floorDeep(n: number): string { return deepen(floorPalette(n).tab); }

/**
 * Which floors' current-tab fills have actually moved since the last write. `update()` runs twice a second off the
 * rAF loop and used to set four CSS custom properties every beat for values that change when a floor is repainted,
 * which is never. Cheap either way — but four style writes a beat is noise in a frame budget that also draws a tower.
 */
export function deepChanges(prev: Record<number, string>, summary: { floor: number; color: string }[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const f of summary) { const deep = deepen(f.color); if (prev[f.floor] !== deep) out[f.floor] = deep; }
  return out;
}

export function railHtml(summary: FloorInfo[], current: number, lobby: boolean, divisions: Record<number, string[]>): string {
  const floors = [...summary].sort((a, b) => b.floor - a.floor);
  const tabs = floors.map((f) => {
    const active = f.agents.filter((a) => ACTIVE.has(a.state)).slice(0, 3);
    const divs = divisions[f.floor]?.length ? `: ${divisions[f.floor].join(', ')}` : '';
    const title = `F${f.floor} ${f.label}${divs}`;
    const meetings = f.meetings ? `, ${f.meetings} meeting${f.meetings === 1 ? '' : 's'}` : '';
    const label = `Floor ${f.floor}, ${f.label}, ${active.length} active${meetings}`;
    return `<button class="tab" data-floor="${f.floor}" style="--floor:${esc(f.color)}" aria-current="${current === f.floor && !lobby}" title="${esc(title)}" aria-label="${esc(label)}"><span class="n">F${f.floor}</span><span class="bar"></span><span class="dots">${active.map((a) => `<i style="background:${esc(a.color)}"></i>`).join('')}</span></button>`;
  });
  tabs.push(`<button class="tab lobby" data-floor="0" aria-current="${lobby}" title="Lobby" aria-label="Lobby"><span class="n">L</span><span class="bar"></span></button>`);
  return tabs.join('');
}

export class Rail {
  private el = document.getElementById('rail')!;
  /** The floor fills already written to the element, so a beat that changes nothing writes nothing. */
  private deep: Record<number, string> = {};
  constructor(private deps: RailDeps) {
    this.el.hidden = false;
    this.el.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-floor]');
      if (!tab) return;
      const n = Number(tab.dataset.floor);
      if (n === 0) this.deps.onLobby(); else this.deps.onFloor(n);
    });
  }
  /** Re-render from the scene (cheap: morph). Call on floor change and after every event, for the dots. */
  update(): void {
    let summary: FloorInfo[];
    try { summary = this.deps.summary(); } catch { return; }   // the world is not built yet
    if (!summary.length) return;
    // The fill for the current tab, one per floor, from the colour that floor actually renders with.
    for (const [floor, value] of Object.entries(deepChanges(this.deep, summary))) { this.el.style.setProperty(`--floor-${floor}-deep`, value); this.deep[Number(floor)] = value; }
    morph(this.el, railHtml(summary, this.deps.currentFloor(), this.deps.inLobby(), this.deps.divisions()));
  }
}
