import type { Tool } from './registry.ts';

// Sums without code. A person working out a runway or a price used to write a run_code script for it and wait on the
// founder's yes; this reads one expression in a small fixed grammar and works it out here, so it needs no approval
// because nothing in it can run. There is no eval, no Function, no vm and no sandbox: a tokenizer, a recursive-descent
// parser and a walk over the tree. Numbers, + - * / % ^, brackets, 15% as 0.15, a fixed list of pure functions and the
// names the caller passes in; anything else is refused before a single step is worked.

const MAX_CHARS = 500;
const MAX_DEPTH = 40;
const MAX_NODES = 300;
const MAX_VALUES = 50;
const NAME = /^[a-z_][a-z0-9_]*$/;

type Node =
  | { kind: 'number'; value: number; percent: boolean }
  | { kind: 'name'; name: string }
  | { kind: 'negate'; operand: Node }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/' | '%' | '^'; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };
type Token = { kind: 'number'; value: number; text: string } | { kind: 'name'; text: string } | { kind: 'op'; text: string };

const FUNCTIONS: Record<string, { min: number; max: number; run(args: number[]): number }> = {
  min: { min: 1, max: 50, run: (args) => Math.min(...args) },
  max: { min: 1, max: 50, run: (args) => Math.max(...args) },
  sum: { min: 1, max: 50, run: (args) => args.reduce((total, one) => total + one, 0) },
  avg: { min: 1, max: 50, run: (args) => args.reduce((total, one) => total + one, 0) / args.length },
  round: { min: 1, max: 2, run: ([value, digits = 0]) => roundTo(value, digits) },
  floor: { min: 1, max: 1, run: ([value]) => Math.floor(value) },
  ceil: { min: 1, max: 1, run: ([value]) => Math.ceil(value) },
  abs: { min: 1, max: 1, run: ([value]) => Math.abs(value) },
  sqrt: { min: 1, max: 1, run: ([value]) => { if (value < 0) throw new Error('sqrt of a negative number has no real result'); return Math.sqrt(value); } },
};
const has = (table: object, key: string) => Object.prototype.hasOwnProperty.call(table, key);

function roundTo(value: number, digits: number) {
  if (!Number.isInteger(digits) || Math.abs(digits) > 15) throw new Error('round takes a whole number of digits between -15 and 15');
  const scale = 10 ** Math.abs(digits);
  return digits >= 0 ? Math.round(value * scale) / scale : Math.round(value / scale) * scale;
}

// One number with its separators: 1_000 always, 1,234,567 only outside a function's brackets, where a comma is what
// parts the arguments; inside them, max(1,234) is two numbers.
const PLAIN = /^\d*(?:_\d+)*(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+)?/;
const GROUPED = /^\d{1,3}(?:,\d{3})+(?!\d)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  // What each open bracket belongs to, so a comma inside a call is never read as a thousands mark.
  const brackets: ('call' | 'group')[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (char === ' ' || char === '\t' || char === '\n') { at += 1; continue; }
    if ((char >= '0' && char <= '9') || (char === '.' && /[0-9]/.test(source[at + 1] ?? ''))) {
      const rest = source.slice(at);
      const text = ((!brackets.includes('call') && GROUPED.exec(rest)) || PLAIN.exec(rest)!)[0];
      if (/[0-9_a-z.]/i.test(source[at + text.length] ?? '')) throw new Error(`"${rest.slice(0, 12)}" is not a number this can read`);
      const value = Number(text.replace(/[_,]/g, ''));
      if (!Number.isFinite(value)) throw new Error(`${text} is too large to be a number`);
      tokens.push({ kind: 'number', value, text });
      at += text.length;
      continue;
    }
    if (/[a-z_]/.test(char)) {
      const text = /^[a-z_][a-z0-9_]*/.exec(source.slice(at))![0];
      if (/[A-Za-z0-9_.]/.test(source[at + text.length] ?? '')) throw new Error(`names are lower case letters, digits and _ only (near "${source.slice(at, at + 12)}")`);
      tokens.push({ kind: 'name', text });
      at += text.length;
      continue;
    }
    if ('+-*/%^(),'.includes(char)) {
      if (char === '*' && source[at + 1] === '*') throw new Error('write powers with ^, as in 2^10');
      if (char === '(') brackets.push(tokens.at(-1)?.kind === 'name' ? 'call' : 'group');
      if (char === ')') brackets.pop();
      tokens.push({ kind: 'op', text: char });
      at += 1;
      continue;
    }
    throw new Error(`"${char}" is not part of an expression this can work out: numbers, + - * / % ^, brackets, the functions ${Object.keys(FUNCTIONS).join(', ')} and the names you pass in`);
  }
  return tokens;
}

function parse(tokens: Token[]): Node {
  let at = 0;
  let nodes = 0;
  let depth = 0;
  const peek = () => tokens[at];
  const isOp = (text: string) => peek()?.kind === 'op' && peek()!.text === text;
  const expect = (text: string) => { if (!isOp(text)) throw new Error(peek() ? `expected "${text}" before "${peek()!.text}"` : `expected "${text}" at the end`); at += 1; };
  const node = (made: Node): Node => { nodes += 1; if (nodes > MAX_NODES) throw new Error(`the expression is too long (more than ${MAX_NODES} parts)`); return made; };
  const nested = <T>(go: () => T): T => {
    depth += 1;
    if (depth > MAX_DEPTH) throw new Error(`the expression nests too deep (more than ${MAX_DEPTH} levels)`);
    try { return go(); } finally { depth -= 1; }
  };
  // A number, a name or a bracket after "%" makes it a remainder; anything else, a sign included, leaves it a percent,
  // so 15% + 5% is 0.2.
  const startsOperand = (token?: Token) => !!token && (token.kind !== 'op' || token.text === '(');

  const sum = (): Node => {
    let left = product();
    while (isOp('+') || isOp('-')) { const op = peek()!.text as '+' | '-'; at += 1; left = node({ kind: 'binary', op, left, right: product() }); }
    return left;
  };
  const product = (): Node => {
    let left = unary();
    while (isOp('*') || isOp('/') || isOp('%')) { const op = peek()!.text as '*' | '/' | '%'; at += 1; left = node({ kind: 'binary', op, left, right: unary() }); }
    return left;
  };
  // Every bracket and every sign passes through here once, so this is where nesting is counted.
  // Unary minus binds looser than a power, as on paper: -2^2 is -4.
  const unary = (): Node => nested(() => {
    if (isOp('-')) { at += 1; return node({ kind: 'negate', operand: unary() }); }
    if (isOp('+')) { at += 1; return unary(); }
    return power();
  });
  // A power is right-associative, 2^3^2 is 2^9, and its exponent may carry its own sign: 2^-1.
  const power = (): Node => {
    const base = primary();
    if (!isOp('^')) return base;
    at += 1;
    return node({ kind: 'binary', op: '^', left: base, right: unary() });
  };
  const primary = (): Node => {
    const token = peek();
    if (!token) throw new Error('the expression ends too early');
    if (token.kind === 'number') {
      at += 1;
      // 15% is 0.15 when nothing that could be its right-hand side follows; 10 % 3 is a remainder.
      const percent = isOp('%') && !startsOperand(tokens[at + 1]);
      if (percent) at += 1;
      return node({ kind: 'number', value: token.value, percent });
    }
    if (token.kind === 'name') {
      at += 1;
      if (!isOp('(')) return node({ kind: 'name', name: token.text });
      at += 1;
      const args: Node[] = [];
      if (!isOp(')')) {
        args.push(sum());
        while (isOp(',')) { at += 1; args.push(sum()); }
      }
      expect(')');
      return node({ kind: 'call', name: token.text, args });
    }
    if (token.text === '(') {
      at += 1;
      const inner = sum();
      expect(')');
      return inner;
    }
    throw new Error(`"${token.text}" cannot stand here`);
  };

  if (!tokens.length) throw new Error('the expression is empty');
  const tree = sum();
  if (at < tokens.length) throw new Error(`"${tokens[at].text}" cannot follow there`);
  return tree;
}

// Every step must give a real, finite number; a step that does not is said plainly and nothing further is worked.
function checked(value: number, what: string) {
  if (Number.isNaN(value)) throw new Error(`${what} has no real result`);
  if (!Number.isFinite(value)) throw new Error(`${what} is too large to be a number`);
  return value;
}

function evaluate(tree: Node, values: Record<string, number>): number {
  switch (tree.kind) {
    case 'number': return tree.percent ? tree.value / 100 : tree.value;
    case 'name': {
      if (has(values, tree.name)) return values[tree.name];
      if (has(FUNCTIONS, tree.name)) throw new Error(`${tree.name} is a function: write ${tree.name}(…)`);
      throw new Error(`"${tree.name}" has no value: pass it in values, as {"${tree.name}": 120}`);
    }
    case 'negate': return -evaluate(tree.operand, values);
    case 'call': {
      if (!has(FUNCTIONS, tree.name)) throw new Error(`${tree.name}() is not a function this knows; it knows ${Object.keys(FUNCTIONS).join(', ')}`);
      const fn = FUNCTIONS[tree.name];
      if (tree.args.length < fn.min || tree.args.length > fn.max) throw new Error(`${tree.name} takes ${fn.min === fn.max ? fn.min : `${fn.min} to ${fn.max}`} argument${fn.max > 1 ? 's' : ''}`);
      return checked(fn.run(tree.args.map((arg) => evaluate(arg, values))), `${tree.name}()`);
    }
    case 'binary': {
      const left = evaluate(tree.left, values);
      const right = evaluate(tree.right, values);
      switch (tree.op) {
        case '+': return checked(left + right, 'the sum');
        case '-': return checked(left - right, 'the difference');
        case '*': return checked(left * right, 'the product');
        case '/': if (right === 0) throw new Error('division by zero'); return checked(left / right, 'the division');
        case '%': if (right === 0) throw new Error('remainder of a division by zero'); return checked(left % right, 'the remainder');
        case '^': if (left === 0 && right < 0) throw new Error('division by zero (0 to a negative power)'); return checked(left ** right, `${left}^${right}`);
      }
    }
  }
}

const RANK = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 4 } as const;
const rankOf = (tree: Node) => (tree.kind === 'binary' ? RANK[tree.op] : tree.kind === 'negate' ? 3 : 5);

// The expression back as it was worked, names replaced by their values, with only the brackets it needs, so the founder
// can check every step by hand.
function show(tree: Node, values: Record<string, number>): string {
  switch (tree.kind) {
    case 'number': return tree.percent ? `${tree.value}%` : String(tree.value);
    // A negative value keeps its brackets, so x^2 with x = -8 reads (-8) ^ 2, as it was worked.
    case 'name': return !has(values, tree.name) ? tree.name : values[tree.name] < 0 ? `(${values[tree.name]})` : String(values[tree.name]);
    case 'negate': return `-${wrap(tree.operand, rankOf(tree.operand) <= 3, values)}`;
    case 'call': return `${tree.name}(${tree.args.map((arg) => show(arg, values)).join(', ')})`;
    case 'binary': {
      const rank = RANK[tree.op];
      // A power groups to the right and a negative base needs its brackets; - / % group to the left.
      const left = wrap(tree.left, tree.op === '^' ? rankOf(tree.left) <= rank : rankOf(tree.left) < rank, values);
      const right = wrap(tree.right, tree.op === '^' ? rankOf(tree.right) < 3 : rankOf(tree.right) < rank || (rankOf(tree.right) === rank && tree.op !== '+' && tree.op !== '*'), values);
      return `${left} ${tree.op} ${right}`;
    }
  }
}
const wrap = (tree: Node, needed: boolean, values: Record<string, number>) => (needed ? `(${show(tree, values)})` : show(tree, values));

// Shown to ten significant digits, so 0.1 + 0.2 reads 0.3; the exact value goes alongside whenever it differs.
export function display(value: number) {
  const short = Number(value.toPrecision(10));
  const size = Math.abs(short);
  if (size !== 0 && (size >= 1e15 || size < 1e-6)) return short.toExponential().replace(/\.?0+e/, 'e');
  return short.toLocaleString('en-US', { maximumFractionDigits: 20 });
}

// The values come as text, "price=9, users=120", which every provider's schema takes; an object of names to numbers
// is read too, for a model that sends one anyway.
function readValues(raw: unknown): Record<string, number> {
  if (raw === undefined || raw === null || raw === '') return Object.create(null);
  const entries = typeof raw === 'string'
    ? raw.split(/[;\n]|,(?=\s*[A-Za-z_][A-Za-z0-9_]*\s*=)/).filter((part) => part.trim()).map((part) => {
      const pair = /^\s*([^=\s]+)\s*=\s*(.*?)\s*$/.exec(part);
      if (!pair) throw new Error(`"${part.trim().slice(0, 40)}" is not name=number`);
      return [pair[1], pair[2]] as [string, unknown];
    })
    : typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw as Record<string, unknown>)
    : null;
  if (!entries) throw new Error('values must read like "price=9, users=120"');
  if (entries.length > MAX_VALUES) throw new Error(`at most ${MAX_VALUES} values`);
  const values: Record<string, number> = Object.create(null);
  for (const [name, given] of entries) {
    if (!NAME.test(name) || name.length > 40) throw new Error(`"${name.slice(0, 40)}" is not a usable name: lower case letters, digits and _, starting with a letter or _`);
    if (has(FUNCTIONS, name)) throw new Error(`"${name}" is the name of a function; call the value something else`);
    const value = typeof given === 'number' ? given
      : typeof given === 'string' && /^-?(?:\d{1,3}(?:,\d{3})+|\d+(?:_\d+)*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(given.trim()) ? Number(given.trim().replace(/[_,]/g, ''))
      : NaN;
    if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number, not ${JSON.stringify(given)?.slice(0, 40)}`);
    values[name] = value;
  }
  return values;
}

export type Worked = { value: number; display: string; worked: string };

// The whole of it: refuse anything outside the grammar before a step is worked, then work it.
export function calculate(expression: string, rawValues?: unknown): Worked {
  if (typeof expression !== 'string' || !expression.trim()) throw new Error('"expression" is missing');
  if (expression.length > MAX_CHARS) throw new Error(`the expression is too long (${expression.length} characters, limit ${MAX_CHARS})`);
  const values = readValues(rawValues);
  const tree = parse(tokenize(expression));
  const value = evaluate(tree, values) || 0;
  return { value, display: display(value), worked: show(tree, values) };
}

export function calcTools(): Tool[] {
  return [{
    name: 'calc',
    perTurn: 12,
    description: 'Work out a sum exactly, at once, with no approval: numbers, + - * / % ^, brackets, 15% for 0.15, and min max sum avg round(x, digits) floor ceil abs sqrt. '
      + 'Put known figures in values and use their names, as "price * users". Use this for every number you calculate; run_code is for real code.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'One expression, as "(cash - 2000) / burn"' },
        values: { type: 'string', description: 'Known figures by name, as "cash=48000, burn=6500"' },
      },
      required: ['expression'],
    },
    async run(args) {
      const result = calculate(args.expression as string, args.values);
      const shortened = Number(result.display.replace(/,/g, '')) !== result.value;
      return { text: `${result.worked} = ${result.display}${shortened ? ` (exact: ${result.value})` : ''}` };
    },
  }];
}
