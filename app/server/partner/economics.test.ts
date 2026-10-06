import { describe, expect, it } from 'vitest';
import { derivedRows, economicsBlock, economicsOf, figuresFix, saysGap, wideGap, workingTools } from './economics.ts';

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

// Journey 14's Company brief: a price and the whole month's burn, no cost per practice. Otto worked runway out net of
// the €98 coming in (4.99); the partner said 4.4 (cash over the gross burn) and overruled him.
const CALLBACK = '- Price: €49 per practice per month\n- Practices contacted: 40\n- Pilots running: 3\n- Paying practices: 2\n- Cash in the bank: €4,000\n- Monthly burn: €900';
describe('runway and break-even only from calc', () => {
  it('works a brief with no cost per unit: break-even on the burn, runway net of what comes in', () => {
    const economics = economicsOf(CALLBACK)!;
    expect(economics.working.map((one) => one.line)).toEqual([
      'Break-even: ceil(900 / 49) = 19 paying practices to cover the burn (the brief gives no cost per unit); we have 2',
      'Runway: round(4000 / (900 - 2 * 49), 1) = 5 months at the net burn',
    ]);
    expect(economics.runway).toEqual({ value: 5, display: '5' });
  });

  it('puts the partner\'s own runway and break-even right in place, and leaves a colleague\'s right figure, the working and a what-if', () => {
    const economics = economicsOf(CALLBACK);
    expect(figuresFix('With €4,000 in the bank and a €900 monthly burn, your runway is **4.4 months** (not 5). Push the pilots.', economics))
      .toBe('With €4,000 in the bank and a €900 monthly burn, your runway is **5 months**. Push the pilots.');
    expect(figuresFix('Otto says runway is 4.99 months.', economics)).toBe('Otto says runway is 4.99 months.');
    expect(figuresFix('Break-even is 21 paying practices.', economics)).toBe('Break-even is 19 paying practices.');
    expect(figuresFix('- Runway: round(4000 / (900 - 2 * 49), 1) = 5 months at the net burn', economics)).toBe('- Runway: round(4000 / (900 - 2 * 49), 1) = 5 months at the net burn');
    expect(figuresFix('At €69 a practice, runway would be 6.2 months.', economics)).toBe('At €69 a practice, runway would be 6.2 months.');
    expect(figuresFix('A round takes 3 to 4 months, so plan for runway.', economics)).toBe('A round takes 3 to 4 months, so plan for runway.');
  });

  it('sets the brief\'s Runway and Break-even rows from calc, whatever the writer put', () => {
    const numbers = `${CALLBACK}\n- Runway: 4.4 (unsourced) months (4,000 / 900, calc)\n- Break-even: 19 paying practices (900 / 49, calc)`;
    const out = derivedRows(numbers);
    expect(out.text.split('\n').slice(-2)).toEqual(['- Runway: 5 months (calc: round(4000 / (900 - 2 * 49), 1) = 5)', '- Break-even: 19 paying practices (calc: ceil(900 / 49) = 19)']);
    expect(out.set).toHaveLength(2);
    expect(derivedRows(out.text).set).toEqual([]);
    // As the live check wrote them: "=" for ":", and a net burn worked in the head with a mark on its step.
    const live = `${CALLBACK}\n- Net burn = 900 − 98 (unsourced) = 802 (calc)\n- Runway = 4,000 / (900 − 98 (unsourced)) = 5.0 months (calc)\n- Break-even = ceil(900 / 49) = 19 paying practices (calc)`;
    expect(derivedRows(live).text.split('\n').slice(-3)).toEqual(['- Net burn: €802 a month (calc: 900 - 2 * 49 = 802)', '- Runway: 5 months (calc: round(4000 / (900 - 2 * 49), 1) = 5)', '- Break-even: 19 paying practices (calc: ceil(900 / 49) = 19)']);
    // A net burn the founder gave stays as given.
    expect(derivedRows('- Cash: $48,000\n- Net burn: $6,000 a month').text).toBe('- Cash: $48,000\n- Net burn: $6,000 a month');
  });

  // Journey 15: price €12 per print job, 1 paying host. Break-even came out as "50 paying hosts" and the runway netted
  // 1 × €12 off the burn as if a host paid €12 a month.
  it('counts break-even in what the price is paid for, and never nets a count of jobs done off the burn', () => {
    const numbers = '- Price: €12 per print job (paid by the maker)\n- Printers listed: 9\n- Print jobs done: 4\n- Paying hosts: 1\n- Cash: €2,500\n- Burn: €600 a month\n- Makers contacted: 60';
    const economics = economicsOf(numbers)!;
    expect(economics.unit).toBe('print jobs a month');
    expect(economics.working.map((one) => one.line)).toEqual([
      'Break-even: ceil(600 / 12) = 50 print jobs a month to cover the burn (the brief gives no cost per unit); the brief has 4 (print jobs done)',
      'Runway: round(2500 / 600, 1) = 4.2 months at the burn (the brief gives no print jobs a month to net it)',
    ]);
    expect(JSON.stringify(economics)).not.toContain('paying hosts');
    expect(derivedRows(`${numbers}\n- Break-even: 50 paying hosts`).text).toContain('- Break-even: 50 print jobs a month (calc: ceil(600 / 12) = 50)');
    // A price a month per paying office, and one per the very thing the paying row counts, stay the paying unit.
    expect(economicsOf('- Price: €240 per office a month\n- Paying offices: 5\n- Burn: €2,100 a month')!.unit).toBe('paying offices');
    expect(economicsOf('- Price: €40 per office\n- Paying offices: 5\n- Burn: €2,100 a month\n- Cash: €9,000')!.working[1].expression).toBe('round(cash / (burn - paying * price), 1)');
  });
});
