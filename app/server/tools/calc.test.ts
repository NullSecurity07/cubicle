import { describe, expect, it } from 'vitest';
import { calcTools, calculate } from './calc.ts';
import type { ToolContext } from './registry.ts';
import { runTool } from './registry.ts';

const value = (expression: string, values?: unknown) => calculate(expression, values).value;
const refused = (expression: string, values?: unknown) => () => calculate(expression, values);

describe('calc', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 - 4 - 3', 3],
    ['100 / 10 / 5', 2],
    ['2 ^ 3 ^ 2', 512],
    ['-2 ^ 2', -4],
    ['(-2) ^ 2', 4],
    ['2 ^ -1', 0.5],
    ['--3', 3],
    ['-3 * -2', 6],
    ['10 % 3', 1],
    ['15%', 0.15],
    ['200 * 15%', 30],
    ['(15% + 5%) * 100', 20],
    ['10 % 3 + 50%', 1.5],
    ['15% - 5%', 0.1],
    ['10 % (3)', 1],
    ['1,234,567 + 1', 1234568],
    ['1_000 * 3', 3000],
    ['1.5e3 + .5', 1500.5],
    ['max(1,234)', 234],
    ['sum(1, 2, 3) + avg(2, 4)', 9],
    ['min(4, 2, 8) * max(1, 3)', 6],
    ['round(2.345, 2)', 2.35],
    ['round(1234, -2)', 1200],
    ['round(2.5)', 3],
    ['floor(-1.5) + ceil(1.2) + abs(-3) + sqrt(16)', 7],
  ])('%s = %s', (expression, expected) => {
    expect(value(expression)).toBeCloseTo(expected, 12);
  });

  it('works on named figures and shows the working with the figures in place', () => {
    expect(calculate('(cash - 2000) / burn', 'cash=48,000, burn=6500')).toMatchObject({ worked: '(48000 - 2000) / 6500' });
    expect(value('price * users', { price: 9, users: 120 })).toBe(1080);
    expect(calculate('x ^ 2', 'x=-8')).toMatchObject({ value: 64, worked: '(-8) ^ 2' });
    expect(calculate('2 * (3 + 4) - 5 % 2').worked).toBe('2 * (3 + 4) - 5 % 2');
    expect(calculate('10 - (4 - 3)').worked).toBe('10 - (4 - 3)');
    expect(calculate('(2 ^ 3) ^ 2').worked).toBe('(2 ^ 3) ^ 2');
  });

  it('reads 0.1 + 0.2 as 0.3 and keeps the exact value beside it', async () => {
    expect(calculate('0.1 + 0.2')).toMatchObject({ display: '0.3', value: 0.1 + 0.2 });
    const [tool] = calcTools();
    const result = await runTool([tool], 'calc', JSON.stringify({ expression: '0.1 + 0.2' }), {} as ToolContext);
    expect(result).toMatchObject({ ok: true, text: '0.1 + 0.2 = 0.3 (exact: 0.30000000000000004)' });
    expect((await runTool([tool], 'calc', JSON.stringify({ expression: 'price * users * 1.1', values: 'price=9, users=120' }), {} as ToolContext)).text)
      .toBe('9 * 120 * 1.1 = 1,188');
    expect((await runTool([tool], 'calc', JSON.stringify({ expression: '48000 / 6500' }), {} as ToolContext)).text).toBe('48000 / 6500 = 7.384615385 (exact: 7.384615384615385)');
    expect(calculate('2 - 2').display).toBe('0');
    expect(calculate('-0 * 1').value).toBe(0);
    expect(calculate('10 ^ 20').display).toBe('1e+20');
  });

  it('needs no approval and is capped per turn', () => {
    const [tool] = calcTools();
    expect(tool.approval).toBeUndefined();
    expect(tool.perTurn).toBeGreaterThan(0);
    expect(JSON.stringify({ description: tool.description, parameters: tool.parameters }).length).toBeLessThan(700);
  });

  it('refuses code, property access and anything outside the grammar before working a step', () => {
    for (const attempt of [
      'constructor', '__proto__', 'constructor.constructor', 'x.constructor', 'toString()', 'valueOf()', 'hasOwnProperty(1)',
      "process.exit()", "require('fs')", 'process', 'globalThis', 'this', 'eval(1)', 'Function(1)', 'import(1)',
      '"1"', "'1'", '`1`', '[1]', '{1}', 'a = 1', 'x => 1', '1; 2', '1 ? 2 : 3', '1 == 1', '1 && 2', '!1', '~1', '1 << 2',
      '2 ** 3', '2x', '2(3)', '(1)(2)', '1 2', '1..2', '1.2.3', '1e', '1__0', '1_', '1,23', '1,2345',
      // Lookalikes: fullwidth digits and plus, a Cyrillic а, the minus sign, a multiplication sign, a zero-width space.
      '１ + 1', '1 ＋ 1', 'pаy', '5 − 1', '2 × 3', '1​+ 1', 'MAX(1)', 'Price',
      '', '   ', '1 +', '(1 + 2', '1 + 2)', 'max(', 'max(1,', ',1',
    ]) expect(refused(attempt), attempt).toThrow();
    // Names that look like inherited properties have no value unless the caller gave them one.
    expect(refused('constructor + 1')).toThrow(/has no value/);
    expect(refused('__proto__')).toThrow(/has no value/);
    expect(refused('valueof(1)')).toThrow(/not a function this knows/);
  });

  it('bounds huge numbers, deep nesting and long input', () => {
    expect(refused('9^9^9')).toThrow(/too large/);
    expect(refused('10^308 * 10')).toThrow(/too large/);
    expect(refused('1e400')).toThrow(/too large/);
    expect(refused(`${'('.repeat(200)}1${')'.repeat(200)}`)).toThrow(/nests too deep/);
    expect(refused(`${'-'.repeat(200)}1`)).toThrow(/nests too deep/);
    expect(refused('1+'.repeat(240) + '1')).toThrow(/too long/);
    expect(refused('1'.repeat(501))).toThrow(/too long/);
    expect(refused(`max(${'1,'.repeat(60)}1)`)).toThrow(/takes 1 to 50/);
    expect(value(`${'('.repeat(30)}1${')'.repeat(30)}`)).toBe(1);
  });

  it('says division by zero and impossible results plainly', () => {
    expect(refused('1/0')).toThrow(/division by zero/);
    expect(refused('0/0')).toThrow(/division by zero/);
    expect(refused('5 % 0')).toThrow(/division by zero/);
    expect(refused('0 ^ -1')).toThrow(/division by zero/);
    expect(refused('sqrt(-4)')).toThrow(/no real result/);
    expect(refused('(-8) ^ (1/3)')).toThrow(/no real result/);
    expect(refused('round(1, 2.5)')).toThrow(/whole number of digits/);
    expect(refused('round(1, 99)')).toThrow(/between -15 and 15/);
    expect(refused('sqrt(1, 2)')).toThrow(/takes 1 argument/);
  });

  it('refuses values that are not plain finite numbers under usable names', () => {
    expect(refused('sum + 1', 'sum=3')).toThrow(/name of a function/);
    expect(refused('max', { max: 3 })).toThrow(/name of a function/);
    expect(refused('sum')).toThrow(/is a function/);
    expect(refused('x(2)', 'x=3')).toThrow(/not a function this knows/);
    for (const bad of [NaN, Infinity, -Infinity, '1e999', 'Infinity', 'NaN', '0x10', '', 'abc', '1 + 1', null, true, [1], { a: 1 }]) {
      expect(refused('x', { x: bad }), String(bad)).toThrow(/finite number/);
    }
    for (const name of ['X', 'my-price', '1x', 'constructor.x', 'a b', '']) expect(refused('1', { [name]: 1 }), name).toThrow(/usable name/);
    expect(refused('x', [1])).toThrow(/price=9/);
    expect(refused('x', 42)).toThrow(/price=9/);
    expect(refused('x', 'x 3')).toThrow(/name=number/);
    // A value called __proto__ or constructor is only ever a number here: nothing inherited is reached or changed.
    expect(value('__proto__ + constructor', JSON.parse('{"__proto__": 2, "constructor": 3}'))).toBe(5);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(refused('x', Object.fromEntries(Array.from({ length: 51 }, (_, at) => [`v${at}`, at])))).toThrow(/at most 50/);
  });
});
