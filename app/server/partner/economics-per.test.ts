import { describe, expect, it } from 'vitest';
import { briefMoves } from './morning.ts';
import { changedLine, changedSince, stateOf } from './economics.ts';

// Journey 20: the brief said "Price: €4 per booking"; after the rise to €4.60 the refresh and the morning note both
// said "price €4 a month → €4.6 a month".
const FIXSLOT = (price: string) => `- Price: ${price}\n- Bookings last month: 280\n- Paying cafés: 6 at €39 a month\n- Cash: €5,400\n- Burn: €1,300 a month`;

describe('a price change said with the brief\'s own period', () => {
  it('says "per booking" when the brief prices per booking, and a month only when the brief says so', () => {
    const then = stateOf(FIXSLOT('€4 per booking')).snapshot();
    const now = stateOf(FIXSLOT('€4.60 per booking (raised 15% on 2026-10-11)'));
    const price = changedSince(then, now).find((one) => one.field === 'price')!;
    expect(changedLine(price, '€')).toBe('price €4 per booking → €4.6 per booking');
    expect(briefMoves(then, now)).toContain('In the brief: price €4 per booking → €4.6 per booking.');
    const monthly = stateOf('- Price: €39 a month\n- Paying cafés: 6\n- Cash: €5,400\n- Burn: €1,300 a month');
    const raised = stateOf('- Price: €45 a month\n- Paying cafés: 6\n- Cash: €5,400\n- Burn: €1,300 a month');
    expect(changedLine(changedSince(monthly.snapshot(), raised).find((one) => one.field === 'price')!, '€')).toBe('price €39 a month → €45 a month');
  });
});
