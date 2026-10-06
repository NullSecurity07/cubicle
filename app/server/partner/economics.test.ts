import { describe, expect, it } from 'vitest';
import { economicsBlock, economicsOf, saysGap, wideGap, workingTools } from './economics.ts';

// The Numbers of journey 13's Company brief, as the founder wrote them.
const HARVEST = `- Offices in pilot: 5
- Paying offices: 3 (since September 2026)
- Price: €240 a month per office (one box a week for about 20 people)
- Produce + delivery cost: €41 per box, about €178 a month per office
- MRR: €720
- Cash: €12,000
- Burn: €2,100 a month (van, founder's costs, packaging)
- Farms signed: 4`;

describe('the brief\'s numbers worked out before a verdict', () => {
  it('works out break-even and runway with calc, reading the monthly figure of a row that gives two', () => {
    const economics = economicsOf(HARVEST)!;
    expect(economics.breakEven).toBe(34);
    expect(economics.current).toBe(3);
    expect(economics.unit).toBe('paying offices');
    expect(economics.working.map((one) => one.line)).toEqual([
      'Break-even: ceil(2100 / (240 - 178)) = 34 paying offices to cover fixed costs; we have 3',
      'Runway: round(12000 / (2100 - 3 * (240 - 178)), 1) = 6.3 months at the net burn',
    ]);
    expect(wideGap(economics)).toBe(true);
    expect(economicsBlock(economics)).toContain('"keep going" is only a call if you say in Why how that gap closes');
    expect(workingTools(economics, (index) => `c${index}`)[0]).toEqual({ id: 'c0', name: 'calc', args: { expression: 'ceil(fixed / (price - cost))', values: 'fixed=2100, price=240, cost=178' }, ok: true, result: 'ceil(2100 / (240 - 178)) = 34' });
  });

  it('takes a net burn when the brief gives one, says when each unit loses money, and works nothing from too little', () => {
    expect(economicsOf('- Cash: $48,000\n- Net burn: $6,000 a month')!.working.map((one) => one.line)).toEqual(['Runway: round(48000 / 6000, 1) = 8 months at the net burn']);
    const losing = economicsOf('- Paying users: 4\n- Price: $10 a month\n- Cost per user: $12 a month\n- Burn: $3,000 a month')!;
    expect(losing.breakEven).toBe(Infinity);
    expect(losing.working[0].line).toContain('each one loses money');
    expect(economicsOf('- Farms signed: 4')).toBeNull();
    expect(wideGap(economicsOf('- Paying users: 30\n- Price: $100 a month\n- Cost per user: $40 a month\n- Burn: $2,000 a month'))).toBe(false);
  });

  it('hears how the gap closes only beside break-even', () => {
    const economics = economicsOf(HARVEST)!;
    expect(saysGap('We reach 34 paying offices by raising the price to €320 and signing two a month.', economics)).toBe(true);
    expect(saysGap('Break-even needs a bigger box at a higher price.', economics)).toBe(true);
    expect(saysGap('We have the cash to validate the pilot target of 10.', economics)).toBe(false);
  });
});
