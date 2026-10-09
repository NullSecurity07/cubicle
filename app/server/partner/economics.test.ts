import { describe, expect, it } from 'vitest';
import { breakEvenFix, breakEvenLine, derivedRows, economicsBlock, economicsOf, figuresFix, gapFix, gapLine, saysGap, stateOf, wideGap, workingTools } from './economics.ts';
import { inputFixesIn } from './corrections.ts';

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

// Journey 16 rebuilt the partner's numbers as one state: the inputs with their periods, the founder's corrections over
// them, every derived figure worked again on each read. These are the four journeys' briefs with their exact numbers.
describe('one state of the numbers, from journeys 13 to 16', () => {
  it('J13: 10 offices goal, €240 a month against €178 of cost, €2,100 fixed: break-even 34', () => {
    const state = stateOf(HARVEST);
    expect(state.breakEven()).toBe(34);
    expect(state.current()).toBe(3);
    expect(state.side()).toBe('below');
    expect(state.gap()).toBe(31);
    expect(state.runway()).toEqual({ value: 6.3, display: '6.3' });
  });

  it('J14: €49 a month, 2 paying, €4,000 cash, €900 burn: runway at the net burn and break-even 19', () => {
    const state = stateOf(CALLBACK);
    expect(state.runway()).toEqual({ value: 5, display: '5' });
    expect(state.breakEven()).toBe(19);
    expect(state.net()).toBe(802);
    expect(state.cashPositive()).toBe(false);
  });

  it('J15: €12 per print job, 4 jobs, €2,500 cash, €600 burn: counted in jobs, the burn never netted', () => {
    const state = stateOf('- Price: €12 per print job (paid by the maker)\n- Print jobs done: 4\n- Paying hosts: 1\n- Cash: €2,500\n- Burn: €600 a month');
    expect(state.unit).toBe('print jobs a month');
    expect(state.breakEven()).toBe(50);
    expect(state.runway()).toEqual({ value: 4.2, display: '4.2' });
    expect(state.mrr()).toBeUndefined();
    expect(state.side()).toBeUndefined();
  });

  const SHIFTMEALS = '- Price: €59 per week per subscriber\n- Subscribers: 14\n- Paying subscribers: 11\n- Cash: €6,000\n- Burn: €1,900 a month\n- Nurses contacted: 120';
  it('J16: €59 a WEEK, 14 subscribers of whom 11 pay, €6,000 cash, €1,900 burn: MRR €2,812, cash-positive, break-even 8', () => {
    const state = stateOf(SHIFTMEALS);
    expect(state.inputs.price).toMatchObject({ value: 59, period: 'week' });
    expect(state.inputs.paying).toMatchObject({ value: 11, label: 'Paying subscribers' });
    expect(state.inputs.subscribers).toMatchObject({ value: 14 });
    expect(Math.round(state.mrr()!)).toBe(2812);
    expect(state.cashPositive()).toBe(true);
    expect(state.runway()).toEqual({ value: Infinity, display: 'cash-positive', gross: { value: 3.2, display: '3.2' } });
    expect(state.breakEven()).toBe(8);
    expect(state.unit).toBe('paying subscribers');
    expect(state.side()).toBe('above');
    expect(state.explain()).toEqual([
      'MRR: round(11 * 59 * 52 / 12, 2) = 2,812.33 a month from 11 paying subscribers at €59 a week',
      'Break-even: ceil(1900 / (59 * 52 / 12)) = 8 paying subscribers to cover the burn (the brief gives no cost per unit); we have 11',
      'Net burn: round(1900 - 11 * 59 * 52 / 12, 2) = -912.33 a month: more comes in than goes out, so the company is cash-positive',
      'Runway: cash-positive, so the cash does not run down at the net; at the gross burn alone round(6000 / 1900, 1) = 3.2 months',
    ]);
    // The calc tool's own call rides with each line.
    expect(workingTools(state.economics()!, (index) => `c${index}`)[1].args).toEqual({ expression: 'ceil(burn / (price * 52 / 12))', values: 'burn=1900, price=59' });
    // A partner who says the old 5.6 months or 33 is put right in place.
    expect(figuresFix('Your runway is 5.6 months.', state.economics())).toBe('Your runway is 3.2 months at the gross burn (cash-positive at the net).');
    expect(figuresFix('Break-even is 33 paying subscribers.', state.economics())).toBe('Break-even is 8 paying subscribers.');
    // The brief's own rows from the same state.
    expect(derivedRows(`${SHIFTMEALS}\n- Runway: 5.6 months\n- Break-even: 33`).text.split('\n').slice(-2)).toEqual([
      '- Runway: cash-positive, more comes in than goes out; 3.2 months at the gross burn alone (calc: round(6000 / 1900, 1) = 3.2)',
      '- Break-even: 8 paying subscribers (calc: ceil(1900 / (59 * 52 / 12)) = 8)',
    ]);
  });

  it('J16: nothing derived is stored; each read works the inputs again, and a later reading of the paying count stands', () => {
    const state = stateOf(SHIFTMEALS, { readings: [{ label: 'Paying subscribers', value: 9.5, day: '2026-10-07' }] });
    expect(state.current()).toBe(9.5);
    expect(state.inputs.paying!.source).toBe('reading');
    // 9.5 against a break-even of 8 is above it: "further below break-even" is put right from the numbers.
    expect(state.side()).toBe('above');
    expect(breakEvenFix('Risk: Paying subscribers dropped from 11 to 9.5, moving us further below break-even.', state))
      .toBe('Risk: Paying subscribers dropped from 11 to 9.5, moving us above break-even (9.5 paying subscribers against 8).');
    expect(breakEvenFix('We are above break-even.', state)).toBe('We are above break-even.');
    expect(breakEvenLine(state)).toBe('Break-even is 8 paying subscribers; 9.5 is above it, and the company is cash-positive.');
    // A worked row written into the brief is never read back as an input.
    expect(stateOf(`${SHIFTMEALS}\n- Net burn: €-912.33 a month (calc: round(1900 - 11 * 59 * 52 / 12, 2) = -912.33)`).runway()?.display).toBe('cash-positive');
    // The snapshot holds inputs only.
    expect(JSON.stringify(state.snapshot())).not.toMatch(/2812|912|breakEven|runway/);
  });

  it('J16: the founder\'s correction stands over the brief with their words, until the brief itself changes', () => {
    const monthly = '- Price: €59 per subscriber\n- Subscribers: 14\n- Paying subscribers: 14\n- Cash: €6,000\n- Burn: €1,900 a month';
    const fixes = inputFixesIn('No, 14 subscribers is not 14 paying, 11 pay. And €59 is per week, not per month, so your break-even and runway are both wrong.', stateOf(monthly), '2026-10-06');
    expect(fixes.map((one) => [one.field, one.value, one.period])).toEqual([['paying', 11, undefined], ['price', undefined, 'week']]);
    const fixed = stateOf(monthly, { fixes });
    expect([fixed.breakEven(), fixed.current(), fixed.cashPositive()]).toEqual([8, 11, true]);
    expect(fixed.founderLines()).toEqual([
      '- Price: €59 a week (founder, 2026-10-06: "And €59 is per week, not per month, so your break-even and runway are both wrong")',
      '- Paying subscribers: 11 (founder, 2026-10-06: "No, 14 subscribers is not 14 paying, 11 pay")',
    ]);
    // The brief edited since to 12 paying: the brief's new figure stands over the older correction.
    expect(stateOf(monthly.replace('Paying subscribers: 14', 'Paying subscribers: 12'), { fixes }).current()).toBe(12);
    // Not a correction: a goal, a what-if, a question.
    expect(inputFixesIn('Our goal is 30 paying by 2026-10-17. If 20 pay we are fine. Should we stop?', stateOf(monthly), 'd')).toEqual([]);
    expect(inputFixesIn('burn is not €1,900 but €2,100 a month', stateOf(monthly), 'd').map((one) => [one.field, one.value, one.period])).toEqual([['burn', 2100, 'month']]);
  });
});

// Journey 19: 9 paying, 22 trials, break-even 38, and "closing just 16 of them will bridge the gap to break-even".
describe('arithmetic on the gap to break-even, held to the state', () => {
  const QUOTESNAP = '- Price: €29 a month per plumber\n- Trial users: 22\n- Paying plumbers: 9\n- Cash: €3,200\n- Burn: €1,100 a month\n- Plumbers contacted: 80';
  const state = stateOf(QUOTESNAP);
  const line = 'Break-even is 38 paying plumbers; 9 pay now, gap 29; the 22 trials cannot close it alone.';
  it('reads the gap and the trials', () => {
    expect(state.breakEven()).toBe(38);
    expect(state.gap()).toBe(29);
    expect(gapLine(state)).toBe(line);
  });
  it('puts the state\'s line in place of a sentence whose numbers contradict it, once', () => {
    expect(gapFix('My call: keep going. With 22 trial users, closing just 16 of them will bridge the gap to break-even. Runway is 3.8 months.', state))
      .toBe(`My call: keep going. ${line} Runway is 3.8 months.`);
    expect(gapFix('Convert the 16 needed to reach break-even (38 paying plumbers total).', state)).toBe(line);
    expect(gapFix('The 22 trial users provide the pipeline needed to reach 38. Closing 16 of them bridges the gap to break-even.', state)).toBe(line);
    expect(breakEvenFix('Closing just 16 of them will bridge the gap to break-even.', state)).toBe(line);
  });
  it('leaves a sentence that agrees with the state, the working, and a sum on another price', () => {
    for (const ok of [
      'We need 29 more paying plumbers to reach break-even at 38.',
      'Even if all 22 trials convert, we are still short of break-even.',
      'Break-even: ceil(1100 / 29) = 38 paying plumbers (calc).',
      'At €39 a month, break-even would be 29 paying plumbers.',
      'Convert 5 trial users this week.',
      'Sign 3 more plumbers this week as a step toward break-even.',
    ]) expect(gapFix(ok, state)).toBe(ok);
  });
});
