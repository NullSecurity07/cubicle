/**
 * The first-run card (visual notes §5): centred, level 2, one question. Start sends the text through the same chat
 * path as the composer (so the daemon's "surprise me" regex and message note both work), then the card collapses
 * towards the cabin sheet, which opens with the message shown as sent. Escape just hides it: the cabin asks the
 * same question until the company has a name.
 */
import { pixelIcon } from './icons.js';

export class FirstRun {
  private el: HTMLElement;
  private input: HTMLInputElement;
  private returnTo: HTMLElement | null = null;
  visible = false;
  constructor(private deps: { onStart(text: string): void; onSurprise(): void }) {
    this.el = document.createElement('div');
    this.el.id = 'firstrun'; this.el.hidden = true;
    this.el.innerHTML = `<form class="card" role="dialog" aria-modal="true" aria-labelledby="fr-title"><h1 id="fr-title">What company will you start?</h1><input id="fr-input" type="text" placeholder="A meal-planning site for busy parents" aria-label="Your company idea" autocomplete="off" /><div class="row-actions"><button type="button" class="btn" data-fr="surprise">Surprise me</button><button type="submit" class="btn primary">Start ${pixelIcon('play')}</button></div><p class="caption">Everything stays in your Obsidian vault.</p></form>`;
    document.body.appendChild(this.el);
    this.input = this.el.querySelector('#fr-input')!;
    this.el.querySelector('form')!.addEventListener('submit', (e) => { e.preventDefault(); const t = this.input.value.trim(); if (t) this.deps.onStart(t); });
    this.el.querySelector('[data-fr="surprise"]')!.addEventListener('click', () => this.deps.onSurprise());
    // The card owns Escape while it is up: stopping it here keeps the panel's window handler from popping the sheet under it.
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.hide(); } });
  }
  show(): void { this.returnTo = document.activeElement as HTMLElement | null; this.el.hidden = false; this.visible = true; this.el.classList.remove('collapse'); this.input.focus(); }
  hide(): void { this.el.hidden = true; this.visible = false; this.returnTo?.focus?.(); }
  /** Play the collapse towards the sheet, then hide. Resolves when the sheet may open. */
  collapse(): Promise<void> {
    return new Promise((resolve) => {
      const card = this.el.querySelector<HTMLElement>('.card')!;
      this.el.classList.add('collapse');
      let settled = false;
      const done = (): void => { if (settled) return; settled = true; card.removeEventListener('animationend', done); this.hide(); resolve(); };
      card.addEventListener('animationend', done);
      window.setTimeout(done, 500);   // reduced motion (1 ms) or a missed event
    });
  }
}
