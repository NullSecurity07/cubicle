/**
 * The hire sheet: the dock's Agent glyph, dropped on the floor.
 *
 * The owner has already said *where* — that is the drop — so the card asks the three things only they can answer:
 * who this is, what to call the role, and whose room they join. What it sends is `hire.propose`, and what comes
 * back is an ordinary proposal in Decisions, because nobody but the owner adds a person to the company. The desk
 * stands as a ghost marked "Hiring…" until that decision is made.
 *
 * Same card as the first-run one, one level up: centred, `aria-modal`, Escape closes, Tab cycles inside it.
 */
import { trapTab } from './keys.js';

export interface HireRequest { role: string; display: string; team: string; at: { x: number; y: number } }

/** `Head of Support` → `head_of_support`: the id the daemon will accept, offered as the owner types the name. */
export const roleIdOf = (display: string): string =>
  display.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

export class HireSheet {
  private el: HTMLElement;
  private form: HTMLFormElement;
  private nameInput: HTMLInputElement;
  private roleInput: HTMLInputElement;
  private teamSelect: HTMLSelectElement;
  private where: HTMLElement;
  private at: { x: number; y: number } = { x: 0, y: 0 };
  /** The owner typed a role id themselves, so the name must stop writing over it. */
  private roleEdited = false;
  private returnTo: HTMLElement | null = null;
  visible = false;

  constructor(private deps: {
    /** the rooms a new desk may join: `{ id, name }`, in org order */
    teams(): { id: string; name: string }[];
    onHire(req: HireRequest): void;
    /** the card closed without hiring: the ghost desk comes off the floor */
    onCancel?(): void;
  }) {
    this.el = document.createElement('div');
    this.el.id = 'hire'; this.el.hidden = true;
    this.el.innerHTML = `<form class="card" role="dialog" aria-modal="true" aria-labelledby="hire-title">
      <h1 id="hire-title">Who sits here?</h1>
      <label class="field"><span>Name</span><input id="hire-name" type="text" placeholder="Head of Support" autocomplete="off" /></label>
      <label class="field"><span>Role id</span><input id="hire-role" type="text" placeholder="head_of_support" autocomplete="off" spellcheck="false" /></label>
      <label class="field"><span>Room</span><select id="hire-team"></select></label>
      <p class="caption" id="hire-where"></p>
      <div class="row-actions"><button type="button" class="btn" data-hire="cancel">Cancel</button><button type="submit" class="btn primary">Propose hire</button></div>
      <p class="caption">A hire is yours to approve: this goes to Decisions, not straight to a desk.</p>
    </form>`;
    document.body.appendChild(this.el);
    this.form = this.el.querySelector('form')!;
    this.nameInput = this.el.querySelector('#hire-name')!;
    this.roleInput = this.el.querySelector('#hire-role')!;
    this.teamSelect = this.el.querySelector('#hire-team')!;
    this.where = this.el.querySelector('#hire-where')!;

    this.nameInput.addEventListener('input', () => { if (!this.roleEdited) this.roleInput.value = roleIdOf(this.nameInput.value); });
    this.roleInput.addEventListener('input', () => { this.roleEdited = true; });
    this.el.querySelector('[data-hire="cancel"]')!.addEventListener('click', () => this.cancel());
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!this.visible) return;
      const display = this.nameInput.value.trim();
      const role = (this.roleInput.value.trim() || roleIdOf(display));
      const team = this.teamSelect.value;
      if (!display || !role || !team) return;
      this.close();
      this.deps.onHire({ role, display, team, at: this.at });
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.cancel(); return; }
      trapTab(this.el, e, document.activeElement as HTMLElement | null);
    });
  }

  /** Open over a spot on the floor. The spot is the drop, in cells, and the card says it back in plain words. */
  show(at: { x: number; y: number }, zone: string | null): void {
    this.at = at;
    this.roleEdited = false;
    this.nameInput.value = ''; this.roleInput.value = '';
    const teams = this.deps.teams();
    this.teamSelect.innerHTML = teams.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
    this.where.textContent = zone ? `The desk goes in ${zone}.` : 'The desk goes where you dropped it.';
    this.returnTo = document.activeElement as HTMLElement | null;
    this.el.hidden = false; this.visible = true;
    this.nameInput.focus();
  }

  private cancel(): void { this.close(); this.deps.onCancel?.(); }

  close(): void {
    if (!this.visible) return;
    this.el.hidden = true; this.visible = false;
    this.returnTo?.focus?.();
  }
}
