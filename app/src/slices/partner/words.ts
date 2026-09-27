import type { Command } from '../../overlay/commands';
import { overlay } from '../../overlay/store';
import { PARTNER_NAME } from '../../../shared/partner';

// The command bar's words for the partner: add one ("add partner", "add a partner called Sam"), ask for the morning
// note now, and open the bets. What each does is handed in, so the words can be checked without a window.

const ADD = /^(?:add|hire|new)\s+(?:a\s+|an\s+|my\s+|the\s+)?(?:co-?founder|partner)(?:\s+(?:called|named)\s+(.+))?$/;
const MORNING = /^(?:(?:the |my |today'?s )?morning( note)?|note from (?:my )?partner|what matters today)$/;
const BETS = /^(?:(?:my |open |the )?bets?|bet(?:s)? ledger|ledger)$/;
const named = (said: string) => said.trim().split(/\s+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ').slice(0, 40);

export function partnerCommands(act: { add(name: string): void; morning(): void }): Command[] {
  // The name the founder typed, kept from the moment the bar asked whether these words were ours.
  let name = '';
  return [
    {
      section: 'Do', hint: 'One person who holds the whole company and keeps the Company document',
      get label() { return name ? `Add ${name}, your partner` : 'Add your partner'; },
      get action() { const chosen = name || PARTNER_NAME; return { do: 'run' as const, run: () => act.add(chosen) }; },
      when: (typed) => { const found = ADD.exec(typed); if (!found) return false; name = found[1] ? named(found[1]) : ''; return true; },
      say: ['add partner', 'add a partner called …'],
    },
    { section: 'Do', label: 'Morning note', hint: 'Three things, one risk and one question from your partner', action: { do: 'run', run: act.morning }, when: (typed) => MORNING.test(typed), say: ['morning note'] },
    { section: 'Do', label: 'Bets', hint: 'What the company bet on, and how each went', action: { do: 'run', run: () => overlay.open({ kind: 'panel', name: 'bets' }) }, when: (typed) => BETS.test(typed), say: ['bets'] },
  ];
}

// The button on a suggested bet in Needs you. A bet on a number only the Company brief holds says so in its detail
// ("Add a Metrics card from the brief and take the bet: …"), and taking it puts that card down: the button says so too.
export const takeBetLabel = (detail?: string) => (detail && /Add a Metrics card from the brief/.test(detail) ? 'Add a Metrics card and take the bet' : 'Take the bet');
