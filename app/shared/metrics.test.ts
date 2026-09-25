import { describe, expect, it } from 'vitest';
import { alerts, delta, formatChange, formatValue, guessBetter, mergeRows, metricsBlock, pace, parseDay, parseImport, parseNumber, periodOf, series, splitCsv, trend, type Metric } from './metrics.ts';

const weekly = (values: number[], start = '2026-08-03', from = 'founder'): Metric['points'] =>
  values.map((value, index) => ({ at: new Date(Date.parse(`${start}T00:00:00Z`) + index * 7 * 86_400_000).toISOString().slice(0, 10), value, from }));
const metric = (values: number[], extra: Partial<Metric> = {}): Metric => ({ key: 'teams', label: 'Weekly active teams', better: 'up', points: weekly(values), ...extra });

describe('periods', () => {
  it('names a week by its Monday and a month by its first day', () => {
    expect(periodOf('2026-09-24', 'week')).toBe('2026-09-21');
    expect(periodOf('2026-09-21', 'week')).toBe('2026-09-21');
    expect(periodOf('2026-09-27', 'week')).toBe('2026-09-21');
    expect(periodOf('2026-09-24', 'month')).toBe('2026-09-01');
  });
  it('keeps the last reading of each period', () => {
    const points = [{ at: '2026-09-22', value: 1, from: 'a' }, { at: '2026-09-24', value: 2, from: 'b' }, { at: '2026-09-29', value: 3, from: 'c' }];
    expect(series({ points }, 'week').map((point) => point.value)).toEqual([2, 3]);
    expect(series({ points }, 'month').map((point) => point.value)).toEqual([3]);
  });
});

describe('delta, trend and pace', () => {
  it('says how far the newest period moved', () => {
    expect(delta(metric([30, 34, 42]), 'week')).toEqual({ now: 42, before: 34, abs: 8, pct: 24 });
    expect(delta(metric([42]), 'week')).toEqual({ now: 42 });
    expect(delta(metric([0, 5]), 'week')!.pct).toBeNull();
    expect(delta({ points: [] }, 'week')).toBeNull();
  });
  it('counts the periods in a row it went the same way', () => {
    expect(trend(metric([10, 20, 30, 40, 50]), 'week')).toEqual({ dir: 'up', n: 4 });
    expect(trend(metric([50, 20, 30, 29, 28]), 'week')).toEqual({ dir: 'down', n: 2 });
    expect(trend(metric([5, 5]), 'week')).toEqual({ dir: 'flat', n: 0 });
  });
  it('draws a straight line to the target and says how far behind it is', () => {
    // 10 on 2026-08-03, target 110 on 2026-12-31 (150 days); 60 days in, the line is at 50.
    const behind = { ...metric([]), points: [{ at: '2026-08-03', value: 10, from: 'f' }, { at: '2026-10-02', value: 41, from: 'f' }], target: { value: 110, by: '2026-12-31' } };
    expect(pace(behind, '2026-10-02')).toEqual({ state: 'behind', gap: 18 });
    expect(pace({ ...behind, points: [...behind.points.slice(0, 1), { at: '2026-10-02', value: 60, from: 'f' }] }, '2026-10-02')).toEqual({ state: 'on' });
    expect(pace({ ...behind, points: [{ at: '2026-10-02', value: 120, from: 'f' }] }, '2026-10-02')).toEqual({ state: 'met' });
    expect(pace(behind, '2027-01-02')).toEqual({ state: 'missed' });
    expect(pace(metric([1]), '2026-10-02')).toEqual({ state: 'none' });
  });
  it('reads a falling target the other way round', () => {
    const churn = { key: 'churn', label: 'Churn', better: 'down' as const, points: [{ at: '2026-08-03', value: 10, from: 'f' }, { at: '2026-10-02', value: 9, from: 'f' }], target: { value: 5, by: '2026-12-31' } };
    expect(pace(churn, '2026-10-02').state).toBe('behind');
    expect(pace({ ...churn, points: [...churn.points, { at: '2026-10-09', value: 4, from: 'f' }] }, '2026-10-09').state).toBe('met');
  });
});

describe('alerts', () => {
  it('raises a reached target, three worse periods, and two quiet ones, each named by its moment', () => {
    const found = alerts('m1', [
      { ...metric([10, 50], { target: { value: 40, by: '2026-12-31' } }), points: weekly([10, 50], '2026-08-24') },
      { ...metric([9, 8, 7, 6]), key: 'mrr', label: 'MRR', unit: '$' },
      { ...metric([1]), key: 'signups', label: 'Signups' },
    ], 'week', '2026-09-01');
    expect(found.map((one) => one.id)).toEqual([
      'metric-alert:m1:teams:target:40@2026-12-31',
      'metric-alert:m1:mrr:falling:2026-08-24',
      'metric-alert:m1:signups:quiet:2026-08-03',
    ]);
    expect(found[1].title).toBe('MRR got worse 3 weeks in a row');
    expect(found[1].detail).toContain('From $9 to $6');
    expect(found[2].title).toBe('No entry for Signups in 29 days');
  });
  it('says nothing about a steady card', () => {
    expect(alerts('m1', [metric([10, 11, 10, 12])], 'week', '2026-08-26')).toEqual([]);
  });
});

describe('words', () => {
  it('writes values and changes the way the founder reads them', () => {
    expect(formatValue(3120, '$')).toBe('$3,120');
    expect(formatValue(-40.5, '€')).toBe('−€40.5');
    expect(formatValue(12, '%')).toBe('12%');
    expect(formatChange(240, '$')).toBe('+$240');
    expect(formatChange(-2)).toBe('−2');
    expect(formatChange(2, '%')).toBe('+2 pts');
  });
  it('fits the block a wired person reads in the compact shape, dated', () => {
    const star = { ...metric([10, 20, 26, 34, 42]), northStar: true as const, target: { value: 100, by: '2026-12-31' } };
    const mrr = { key: 'mrr', label: 'MRR', better: 'up' as const, unit: '$' as const, points: weekly([2880, 3120], '2026-08-24') };
    const churn = { key: 'churned', label: 'Churned customers', better: 'down' as const, points: weekly([3, 1], '2026-08-24') };
    const text = metricsBlock('Traction', [star, mrr, churn], 'week', '2026-09-01');
    expect(text).toBe([
      '- A Metrics card, "Traction". Read more with read_metrics.',
      '  North star: Weekly active teams 42 (+8, +24% vs last week; 4 weeks up; target 100 by 2026-12-31, on pace).',
      '  MRR $3,120 (+$240). Churned customers 1 (−2). Last entry 2026-08-31.',
    ].join('\n'));
    const six = Array.from({ length: 6 }, (_, index) => ({ ...mrr, key: `m${index}`, label: `Metric number ${index}` }));
    expect(metricsBlock('Traction', [star, ...six], 'week', '2026-09-01').length).toBeLessThan(600);
    expect(metricsBlock(undefined, [], 'week', '2026-09-01')).toBe('- A Metrics card. Read more with read_metrics.\n  No numbers yet; the founder pastes or types them on the card. Today is 2026-09-01.');
  });
  it('guesses which way is better from the name', () => {
    expect(guessBetter('Monthly churn')).toBe('down');
    expect(guessBetter('Burn rate')).toBe('down');
    expect(guessBetter('Signups')).toBe('up');
  });
});

describe('reading a file', () => {
  it('splits CSV with quotes and picks the delimiter from the first line', () => {
    expect(splitCsv('a,b\n"x, y","he said ""hi"""\r\n1,2')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['1', '2']]);
    expect(splitCsv('date;mrr\n2026-09-01;3120')).toEqual([['date', 'mrr'], ['2026-09-01', '3120']]);
  });
  it('reads days and numbers the way spreadsheets write them', () => {
    expect(parseDay('2026-09-24')).toBe('2026-09-24');
    expect(parseDay('2026/9/4')).toBe('2026-09-04');
    expect(parseDay('2026-09-24T10:00:00Z')).toBe('2026-09-24');
    expect(parseDay('2026-09')).toBe('2026-09-01');
    expect(parseDay('03/04/2026')).toBe('2026-04-03');
    expect(parseDay('03/04/2026', false)).toBe('2026-03-04');
    expect(parseDay('24 Sep 2026')).toBe('2026-09-24');
    expect(parseDay('Sep 24, 2026')).toBe('2026-09-24');
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('soon')).toBeNull();
    expect(parseNumber('$3,120')).toEqual({ value: 3120, unit: '$' });
    expect(parseNumber('12%')).toEqual({ value: 12, unit: '%' });
    expect(parseNumber('(40)')).toEqual({ value: -40, unit: '' });
    expect(parseNumber('1 200')).toEqual({ value: 1200, unit: '' });
    expect(parseNumber('n/a')).toBeNull();
  });
  it('reads the wide shape, one column a metric, and names each row it skipped', () => {
    const parsed = parseImport('date,Signups,MRR\n2026-09-14,50,"$2,880"\nlast week,57,$3120\n2026-09-21,57,soon\n2026-09-22,,$3120', 'sales.csv');
    expect(parsed.shape).toBe('wide');
    expect(parsed.rows).toEqual([
      { key: 'signups', label: 'Signups', at: '2026-09-14', value: 50, from: 'sales.csv, row 2' },
      { key: 'mrr', label: 'MRR', at: '2026-09-14', value: 2880, from: 'sales.csv, row 2', unit: '$' },
      { key: 'signups', label: 'Signups', at: '2026-09-21', value: 57, from: 'sales.csv, row 4' },
      { key: 'mrr', label: 'MRR', at: '2026-09-22', value: 3120, from: 'sales.csv, row 5', unit: '$' },
    ]);
    expect(parsed.skipped).toEqual(['row 3: "last week" is not a date', 'row 4, MRR: "soon" is not a number']);
  });
  it('reads the long shape, one row a reading, and decides day-first once for the file', () => {
    const parsed = parseImport('Date,Metric,Value\n09/13/2026,Signups,50\n09/14/2026,Signups,51\n,Signups,3\n09/15/2026,,4', 'pasted');
    expect(parsed.shape).toBe('long');
    expect(parsed.rows.map((row) => row.at)).toEqual(['2026-09-13', '2026-09-14']);
    expect(parsed.skipped).toEqual(['row 4: no date', 'row 5: no metric name']);
  });
  it('reads JSON rows and a card sent back', () => {
    expect(parseImport('[{"date":"2026-09-01","signups":4},{"date":"2026-09-02","signups":6}]', 'a.json').rows.map((row) => row.value)).toEqual([4, 6]);
    const back = parseImport(JSON.stringify({ metrics: [metric([1, 2])], updatedAt: 1 }), 'b.json');
    expect(back.rows).toHaveLength(2);
    expect(back.rows[0]).toMatchObject({ key: 'weekly-active-teams', from: 'b.json' });
    expect(parseImport('{"no":1}', 'c.json').skipped).toEqual(['the JSON is not a list of rows']);
  });
});

describe('merging', () => {
  it('replaces a day already there, adds new metrics until the card is full, and makes the first the north star', () => {
    const rows = parseImport('date,a,b,c\n2026-09-01,1,2,3\n2026-09-02,4,5,6', 'x.csv').rows;
    const first = mergeRows([], rows, 2);
    expect(first.metrics.map((one) => one.label)).toEqual(['a', 'b']);
    expect(first.full).toEqual(['c']);
    expect(first.added).toBe(4);
    expect(first.metrics[0].northStar).toBe(true);
    const again = mergeRows(first.metrics, [{ key: 'a', label: 'A', at: '2026-09-02', value: 9, from: 'founder' }]);
    expect(again.replaced).toBe(1);
    expect(again.metrics[0].points.at(-1)).toEqual({ at: '2026-09-02', value: 9, from: 'founder' });
    // The metric it was merged from is left as it was.
    expect(first.metrics[0].points.at(-1)!.value).toBe(4);
  });
});
