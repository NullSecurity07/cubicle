/** Feedback that is not a panel: a toast (bottom centre), the screen-reader announcer, the one-time coach mark. */
import type { CubicleEvent } from '../state.js';
import { esc } from './content.js';
import { pixelIcon } from './icons.js';
import { DUR, dur } from '../world/motion.js';

/** What a screen reader hears for an event the owner cares about; null for internal chatter. */
export function announcementFor(e: CubicleEvent): string | null {
  const p = e.payload;
  switch (e.type) {
    case 'proposal.created': return p.kind === 'message' ? null : `Needs you: ${String(p.title ?? p.kind ?? '')}`;
    case 'agent.spoke': return p.to === 'owner' ? `${String(e.agent ?? 'ceo').toUpperCase()}: ${String(p.text ?? '')}` : null;
    case 'heartbeat.completed': return 'Brief written';
    case 'deploy.done': return `Deployed ${String(p.url ?? '')}`;
    case 'guardrail.blocked': return `Blocked: ${String(p.reason ?? '')}`;
    case 'role.hired': return `${String(p.role ?? '')} joined the company`;
    default: return null;
  }
}

let toastTimer = 0;
/** One toast at a time; an optional action button opens something through the panel's `data-open` routing. */
export function toast(text: string, opts: { action?: { label: string; open: string }; ms?: number } = {}): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.innerHTML = `<span>${esc(text)}</span>${opts.action ? `<button class="mini" data-open="${esc(opts.action.open)}">${esc(opts.action.label)}</button>` : ''}<button class="icon" aria-label="Dismiss" data-dismiss>${pixelIcon('close')}</button>`;
  el.hidden = false;
  el.querySelector('[data-dismiss]')!.addEventListener('click', () => { el.hidden = true; });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, opts.ms ?? 5000);
}

/** Polite live region: set the text after a tick so repeated identical messages are still read. */
export function announce(text: string): void {
  const el = document.getElementById('announcer');
  if (!el) return;
  el.textContent = '';
  window.setTimeout(() => { el.textContent = text; }, 30);
}

/** A coach mark that has not been shown yet. `show()` is idempotent: the app calls it from two places, and the
 *  mark is shown once, for its own `ms`, from whichever came first. */
export interface CoachMark { show(): void }

/**
 * The hint line under the bar: fades after `ms` or on the first interaction, then is removed.
 *
 * It is built, not shown: the first-run card is the other first-contact message, and two of them side by side
 * (which `01-first-run.png` showed) is one too many. The app shows this one when it knows the card is not coming,
 * or once the card has gone.
 */
export function coachMark(text: string, ms = 8000): CoachMark {
  const el = document.getElementById('coach');
  let started = false, done = false;
  const end = (): void => { if (done || !started || !el) return; done = true; el.classList.add('fade'); window.setTimeout(() => { el.hidden = true; }, dur(DUR.reader)); window.removeEventListener('pointerdown', end); window.removeEventListener('keydown', end); };
  return {
    show(): void {
      if (started || done || !el) return;
      started = true;
      el.textContent = text;
      el.classList.remove('fade');
      el.hidden = false;
      window.setTimeout(end, ms);
      window.addEventListener('pointerdown', end, { once: true });
      window.addEventListener('keydown', end, { once: true });
    },
  };
}
