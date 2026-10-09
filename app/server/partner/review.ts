import { join } from 'node:path';
import { localDay, now as clockNow } from '../clock.ts';
import { newMessageId, type Attention, type Stage } from '../../shared/model.ts';
import { writeAtomic } from '../fsx.ts';
import { readableDocIds } from '../prompt.ts';
import { readBook } from '../rescue.ts';
import type { Handler } from '../seams.ts';
import { calculate } from '../tools/calc.ts';
import { markUnbacked, markUnworked, unbackedClaims } from '../tools/evidence.ts';
import { unsourcedIn } from './call.ts';
import { sectionText } from './company.ts';
import { stateOf, type EconomicsState } from './economics.ts';

// Journey 13: Tom wrote Unit Economics with a net burn of €1,380 (the brief's €2,100 burn less €720 of MRR, the €534 a
// month the boxes cost left out), worked out with calc, so the guard let it stand; the partner never looked. A
// co-founder checks a colleague's work before the founder acts on it. When a colleague finishes a turn that wrote a
// doc, the partner reviews it on the next tick, unasked, once:
// (a) numbers: each figure added is read, worked out with calc or marked, by the write guard's own checks;
// (b) sense: a net burn, runway or margin is worked out again with calc from the Company brief's Numbers, and a wrong
//     one is named with the right working;
// (c) claims: customer feedback or "it works" with no record behind it, marked as an assumption or not;
// (d) a one-line verdict, "Fit for the founder." or "Fix first: …".
// Everything here is worked out in code; a model, within the day's budget for unasked work, only puts the line in the
// partner's words, and its words are kept only when every number in them is one the review gave. The doc itself is
// never touched: the review is a line in the colleague's room and, when something needs fixing, a Needs you row whose
// Fix sends the colleague the ask.

export type ReviewFlag = { kind: 'number' | 'sense' | 'claim' | 'duplicate'; said: string; short: string; line?: number };
export type DocReview = { flags: ReviewFlag[]; verdict: string; checked: boolean };

const FIT = 'Fit for the founder.';
const MARK = '(assumption)';
const money = (value: number, currency = '') => `${value < 0 ? '-' : ''}${currency}${Math.abs(Math.round(value * 100) / 100).toLocaleString('en-US')}`;
const clip = (text: string, most = 70) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > most ? `${flat.slice(0, most - 1)}…` : flat; };

// ------------------------------------------------------------ (b) sense: the derived figures, worked out again

type Derived = { name: 'net burn' | 'runway' | 'margin' | 'margin %' | 'break-even'; right: number; working: string; shown: string; near: (claimed: number, line: string) => boolean; hint?: (claimed: number) => string };
// Journey 16: a colleague's figure is flagged only when the one state has the inputs for it and disagrees beyond
// rounding: two in a hundred of the right figure (a runway of 3.16 against 3.2 is the same runway).
export const SHARE = 0.02;
const near = (right: number, least = 0) => (claimed: number) => Math.abs(claimed - right) <= Math.max(least, Math.abs(right) * SHARE);
const sumOf = (state: EconomicsState, label: string) => state.economics()?.working.find((one) => one.label === label)?.result;

// What the one state gives for each derived figure, each with its calc working, worked again now.
export function rightFigures(state: EconomicsState): Derived[] {
  const out: Derived[] = [];
  const currency = state.currency ?? '';
  const unit = state.unit;
  const net = state.net();
  const price = state.monthly('price');
  const cost = state.monthly('cost');
  const fixed = state.monthly('burn');
  const paying = state.current();
  if (net !== undefined) {
    const working = state.inputs.net ? `the Company brief gives ${money(net, currency)} a month` : `${calculate(state.inputs.cost ? 'fixed - paying * (price - cost)' : 'burn - paying * price', state.inputs.cost ? `fixed=${fixed}, paying=${paying}, price=${round(price!)}, cost=${round(cost!)}` : `burn=${fixed}, paying=${paying}, price=${round(price!)}`).worked} = ${money(net)} (calc)`;
    const positive = state.cashPositive();
    out.push({
      name: 'net burn', right: net, working, shown: positive ? `${money(net, currency)} a month (cash-positive)` : `${money(net, currency)} a month`,
      // Cash-positive, the surplus may be written as a plus: its size is what is checked.
      near: (claimed) => near(net, 1)(claimed) || (positive && near(Math.abs(net), 1)(Math.abs(claimed))),
      hint: (claimed) => (cost !== undefined && paying !== undefined && price !== undefined && fixed !== undefined && near(fixed - paying * price, 1)(claimed) ? `it leaves out what the ${paying} ${unit} cost (${money(paying * cost, currency)} a month)`
        : fixed !== undefined && near(fixed, 1)(claimed) ? 'it is the burn before anything the paying ones bring in' : ''),
    });
  }
  const runway = state.runway();
  if (runway) {
    const gross = runway.gross;
    if (Number.isFinite(runway.value)) {
      out.push({ name: 'runway', right: runway.value, working: `${sumOf(state, 'Runway')} (calc)`, shown: `${runway.display} months`,
        near: (claimed, line) => near(runway.value, 0.05)(claimed) || (!!gross && /\bgross\b/i.test(line) && near(gross.value, 0.05)(claimed)) });
    } else if (gross) {
      // Cash-positive: the only months there are, are the gross burn's.
      out.push({ name: 'runway', right: gross.value, working: `${sumOf(state, 'Net burn') ?? ''} a month, cash-positive; at the gross burn ${sumOf(state, 'Runway')} (calc)`.replace(/^ a month, /, ''), shown: `cash-positive (${gross.display} months at the gross burn alone)`, near: near(gross.value, 0.05) });
    }
  }
  if (price !== undefined && cost !== undefined && price > 0) {
    const each = calculate('price - cost', `price=${round(price)}, cost=${round(cost)}`);
    out.push({ name: 'margin', right: each.value, working: `${each.worked} = ${each.display} (calc)`, shown: `${money(each.value, currency)} a month on each`, near: near(each.value, 1) });
    const share = calculate('round((price - cost) / price * 100, 1)', `price=${round(price)}, cost=${round(cost)}`);
    out.push({ name: 'margin %', right: share.value, working: `${share.worked} = ${share.display} (calc)`, shown: `${share.display}%`, near: near(share.value, 1) });
  }
  return out;
}
const round = (value: number) => Math.round(value * 100) / 100;

const FIGURE = /(?<![\p{L}\d.,])([$€£]\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s?k\b)?(\s?%)?/gu;
type Figure = { text: string; value: number; at: number; money: boolean; share: boolean; months: boolean };
function figuresIn(line: string, from: number): Figure[] {
  return [...line.slice(from).matchAll(FIGURE)].map((hit) => {
    const rest = line.slice(from + (hit.index ?? 0) + hit[0].length);
    return {
      text: hit[0].trim(), at: from + (hit.index ?? 0), money: !!hit[1], share: !!hit[5],
      value: Number(`${hit[2].replace(/,/g, '')}${hit[3] ?? ''}`) * (hit[4] ? 1000 : 1),
      months: /^\s*(?:\(unsourced\)\s*)?(?:months?|mo)\b/i.test(rest),
    };
  }).filter((one) => !(one.value >= 1900 && one.value <= 2099 && !one.money && !one.share));
}

// The figure a line gives as its result: after its last ":" or "=" (a working's result), else the first after the label.
function claimedOn(line: string, label: RegExpExecArray, pick: (one: Figure) => boolean): Figure | undefined {
  const end = label.index + label[0].length;
  const cut = Math.max(line.lastIndexOf(':'), line.lastIndexOf('='));
  const from = cut >= end ? cut + 1 : end;
  return figuresIn(line, from).find(pick) ?? (from !== end ? figuresIn(line, end).find(pick) : undefined);
}

// Each derived figure the doc states that the one state does not give, with both workings: the state's and the doc's.
export function senseFlags(text: string, given: string | EconomicsState): { flags: ReviewFlag[]; lines: Set<number> } {
  const state = typeof given === 'string' ? stateOf(given) : given;
  const economics = state.economics();
  const lines = new Set<number>();
  if (!economics?.inputs) return { flags: [], lines };
  const derived = rightFigures(state);
  const worked = (label: string) => economics.working.find((one) => one.label === label);
  const by = (name: Derived['name']) => derived.find((one) => one.name === name);
  const flags: ReviewFlag[] = [];
  const said = new Set<string>();
  text.split('\n').forEach((line, index) => {
    if (/^\s*#/.test(line) || /^\s*(?:>|```)/.test(line)) return;
    const runway = /\brunway\b/i.exec(line);
    const margin = /\b(?:gross\s+|unit\s+|contribution\s+)?margins?\b/i.exec(line);
    const net = /\bnet\s+(?:burn|cash\s*flow|cashflow)\b/i.exec(line);
    let found: { derived: Derived; claimed: Figure } | undefined;
    const runwayRight = by('runway');
    if (runway && runwayRight) {
      const claimed = claimedOn(line, runway, (one) => one.months) ?? figuresIn(line, 0).find((one) => one.months);
      if (claimed) found = { derived: runwayRight, claimed };
    }
    if (!found && margin) {
      const share = by('margin %');
      const claimedShare = share ? claimedOn(line, margin, (one) => one.share) : undefined;
      if (share && claimedShare) found = { derived: share, claimed: claimedShare };
      else {
        const each = by('margin');
        // A margin in money is checked only when it is said per paying unit or per month, never per box or per order.
        const perUnit = new RegExp(`\\bper\\s+${state.unit.split(' ').pop()!.replace(/s$/, '')}\\b|\\ba month\\b|\\bper month\\b|\\/\\s?mo`, 'i');
        const claimed = each && perUnit.test(line) ? claimedOn(line, margin, (one) => one.money) : undefined;
        if (each && claimed) found = { derived: each, claimed };
      }
    }
    // Break-even in the state's own count and unit: journey 15's "50 paying hosts" for 50 print jobs a month.
    const even = /\bbreak[- ]?even(?:\s+point)?\b/i.exec(line);
    const right = state.breakEven();
    if (!found && even && right !== undefined && Number.isFinite(right) && worked('Break-even')) {
      const claimed = claimedOn(line, even, (one) => !one.money && !one.share && !one.months);
      const noun = state.unit.split(' ').find((word) => !/^(?:paying|a|per|month)$/.test(word))?.replace(/s$/, '') ?? '';
      const after = claimed ? line.slice(claimed.at + claimed.text.length, claimed.at + claimed.text.length + 40) : '';
      const unitWrong = !!claimed && /^\s*[a-z]/i.test(after) && !new RegExp(`^\\s*(?:[a-z-]+\\s+){0,2}${noun}`, 'i').test(after);
      if (claimed && (claimed.value !== right || unitWrong)) {
        const shown = `${right} ${state.unit}`;
        const wrongAs = `${claimed.text}${unitWrong ? ` ${/^\s*((?:[a-z-]+\s?){1,3})/i.exec(after)?.[1].trim() ?? ''}` : ''}`;
        found = { derived: { name: 'break-even', right, working: `${worked('Break-even')!.result} (calc)`, shown, near: () => false }, claimed: { ...claimed, text: wrongAs } };
      }
    }
    const netRight = by('net burn');
    if (!found && net && netRight) {
      const claimed = claimedOn(line, net, (one) => !one.share && !one.months);
      if (claimed) found = { derived: netRight, claimed };
    }
    if (!found || found.derived.near(found.claimed.value, line)) return;
    lines.add(index);
    const { derived: rightOne, claimed } = found;
    if (said.has(rightOne.name)) return;
    said.add(rightOne.name);
    const hint = rightOne.hint?.(claimed.value);
    const what = rightOne.name === 'margin %' ? 'margin' : rightOne.name;
    const theirs = clip(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''), 90);
    flags.push({
      kind: 'sense',
      said: `${what[0].toUpperCase()}${what.slice(1)} is ${rightOne.shown}, not ${claimed.text}: ${rightOne.working}${hint ? `; ${hint}` : ''}. The doc has "${theirs}".`,
      short: `${what} is ${rightOne.shown}, not ${claimed.text}`, line: index,
    });
  });
  return { flags, lines };
}

// ------------------------------------------------------------ the review

// The lines a write added since the doc was last reviewed, as text, each with its index in the doc.
function addedLines(before: string, after: string): { index: number; line: string }[] {
  const had = new Set(before.split('\n').map((line) => line.trim()));
  return after.split('\n').map((line, index) => ({ index, line })).filter(({ line }) => line.trim() && !had.has(line.trim()) && !/^\s*#/.test(line));
}

// Every value a calc this turn gave (as shown and exact) and every figure the one state works out, signs dropped: the
// sense check, not this one, says when a net burn has the wrong sign.
export function workedValues(read: string, state: EconomicsState): number[] {
  const out = [...read.matchAll(/(?:=|\(exact:)\s*(-?\d[\d,]*(?:\.\d+)?(?:e[-+]?\d+)?)/g)].map((hit) => Number(hit[1].replace(/,/g, '')));
  for (const one of state.economics()?.working ?? []) out.push(Number(one.result.split(' = ').at(-1)!.replace(/,/g, '')));
  for (const one of rightFigures(state)) out.push(one.right);
  return out.filter(Number.isFinite).map(Math.abs);
}
// As exact as it is written: "3.16" is any value from 3.155 to 3.165, "€2,812" one from 2,811.5 to 2,812.5.
function isWorked(claimed: Figure, worked: number[]): boolean {
  const decimals = /\.(\d+)/.exec(claimed.text.replace(/\s?k$/i, ''))?.[1].length ?? 0;
  const half = 0.5 * 10 ** -decimals * (/k$/i.test(claimed.text) ? 1000 : 1);
  return worked.some((one) => Math.abs(one - Math.abs(claimed.value)) <= half + 1e-9);
}

const CLAIMISH = /\b(?:customers?|users?|clients?|managers?|offices?|staff|people|they|feedback|works|validated|proven|love|loved|report\w*|say|said|demand|popular)\b/i;

// One doc, reviewed. `read` is everything the writer's turn read (tool results, the founder's ask) and what they could
// read without asking (the Company brief, their wired docs); `said` is what may back a claim of what someone said or did.
// `twins`: how many other docs on the stage carry this doc's title (journey 15 had three "Runway" docs from one turn,
// each called "Fit for the founder.").
export function reviewDoc(input: { text: string; before?: string; numbers: string; read: string[]; said: string[]; title?: string; twins?: number; state?: EconomicsState | null }): DocReview {
  const before = input.before ?? '';
  const state = input.state ?? stateOf(input.numbers);
  const added = addedLines(before, input.text);
  const twin: ReviewFlag[] = input.twins ? [{ kind: 'duplicate', said: `${input.twins + 1} documents on the stage are called "${input.title ?? 'this'}": keep one and take the other${input.twins > 1 ? 's' : ''} away, so nobody reads the wrong one.`, short: `${input.twins + 1} docs are called "${input.title ?? 'this'}"` }] : [];
  if (!added.length && twin.length) return { flags: twin, verdict: `Fix first: ${twin[0].short}.`, checked: true };
  const addedText = added.map((one) => one.line).join('\n');
  const checked = /\d/.test(addedText) || CLAIMISH.test(addedText);
  if (!added.length) return { flags: [], verdict: FIT, checked: false };
  const flags: ReviewFlag[] = [...twin];
  // (b) first: a wrong derived figure is named once, with the right one, not again as unsourced.
  const sense = senseFlags(input.text, state);
  const addedAt = new Set(added.map((one) => one.index));
  flags.push(...sense.flags.filter((flag) => flag.line !== undefined && addedAt.has(flag.line)).map(({ line: _line, ...flag }) => flag));
  // (a) the guard's own checks, on the added lines only: a count nothing read gives, and a derived figure no calc
  // worked out. The working of the right figures is read too, so a figure that matches it stands.
  const sums = [...rightFigures(state).flatMap((one) => (/ = /.test(one.working) ? [one.working.replace(/ \(calc\)$/, '')] : [])), ...state.explain()];
  const read = [input.numbers, ...input.read, ...sums];
  const bare = input.text.split('\n').map((line, index) => (sense.lines.has(index) ? '' : line)).join('\n');
  const marks = [...markUnworked({ before, after: bare, read }).marked, ...markUnbacked({ before, after: bare, read }).marked];
  const figures = [...new Set(marks.map((mark) => mark.label))];
  // A runway, break-even, net burn or margin is a sum: its figure comes from a calc this turn ran or the one state's
  // own working, never from the writer's head, even when it sits near the right one. Journey 17: Otto worked every
  // figure of Runway with calc and wrote "net_burn = burn - mrr = -€912.33"; the check lost the minus and held 3.16
  // against calc's 3.157894737, and the right doc was flagged "no calc" four days. A figure is worked when its VALUE,
  // as exact as it is written, is a calc result or a figure of the one state, whatever words surround it.
  const worked = workedValues(read.join('\n'), state);
  const unworked: string[] = [];
  for (const { line, index } of added) {
    if (sense.lines.has(index)) continue;
    const label = /\b(?:runway|break[- ]?even|net\s+burn|(?:gross\s+|unit\s+|contribution\s+)?margin)\b/i.exec(line);
    if (!label) continue;
    const claimed = claimedOn(line, label, (one) => one.months || one.share || one.money || !/^\s*(?:%|months?)/i.test(line.slice(one.at + one.text.length)));
    if (!claimed || isWorked(claimed, worked) || figures.some((one) => one.includes(claimed.text))) continue;
    unworked.push(clip(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''), 60));
  }
  if (unworked.length) {
    const quoted = unworked.slice(0, 2).map((one) => `"${one}"`).join(' and ');
    flags.push({ kind: 'number', said: `${quoted}${unworked.length > 2 ? ` and ${unworked.length - 2} more` : ''} ${unworked.length > 1 ? 'are sums' : 'is a sum'} with no calc behind ${unworked.length > 1 ? 'them' : 'it'}: work ${unworked.length > 1 ? 'each' : 'it'} out with calc from the Company brief's Numbers.`, short: `${unworked.length > 1 ? `${unworked.length} derived figures have` : 'a derived figure has'} no calc` });
  }
  if (figures.length) {
    const quoted = figures.slice(0, 4).map((one) => `"${one}"`).join(', ');
    flags.push({ kind: 'number', said: `${quoted}${figures.length > 4 ? ` and ${figures.length - 4} more` : ''} ${figures.length > 1 ? 'are' : 'is'} in nothing read and worked out with no calc: back ${figures.length > 1 ? 'each' : 'it'} with a source or a calc, or mark ${figures.length > 1 ? 'them' : 'it'} "(unsourced)".`, short: `${figures.length > 1 ? `${figures.length} figures have` : `${quoted} has`} no source or calc` });
  }
  // (c) claims of what customers said or did, or that it works, with nothing on record: as written, or kept as the
  // writer's assumption, which is still nothing the founder can act on.
  const claims: string[] = [];
  for (const { line } of added) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const assumed = sentence.includes(MARK);
      const hits = unbackedClaims(assumed ? sentence.replace(MARK, '') : sentence, input.said);
      if (hits.length) claims.push(clip(sentence.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\s*\(assumption\)/, ''), 80));
    }
  }
  if (claims.length) {
    const first = claims.slice(0, 2).map((one) => `"${one}"`).join(' and ');
    flags.push({ kind: 'claim', said: `${first}${claims.length > 2 ? ` and ${claims.length - 2} more` : ''} ${claims.length > 1 ? 'say' : 'says'} what customers said or did, or that it works, with no notes or record behind it: take ${claims.length > 1 ? 'them' : 'it'} out, or write "no feedback on record".`, short: `${claims.length > 1 ? `${claims.length} claims have` : 'a claim has'} no record behind ${claims.length > 1 ? 'them' : 'it'}` });
  }
  const verdict = flags.length ? `Fix first: ${flags.map((one) => one.short).join('; ')}.` : FIT;
  return { flags, verdict, checked: checked || flags.length > 0 };
}

// The line in the colleague's room, worked out in full.
export const reviewLine = (title: string, review: DocReview) => [`I read "${title}".`, ...review.flags.map((flag) => `- ${flag.said}`), review.verdict].join('\n');
// What Fix sends the colleague, as the founder.
export const fixAsk = (title: string, review: DocReview) => `Please fix "${title}" before I act on it: ${review.flags.map((flag) => flag.said).join(' ')} Change only what is wrong, work every figure out with calc from the Company brief's Numbers, and leave the rest as it is.`;

// A model's wording of the line, kept only when every number in it is one the review gave.
export const phrasingHolds = (phrased: string, line: string) => !!phrased.trim() && phrased.length <= 600 && !unsourcedIn(phrased, line).length;

// ------------------------------------------------------------ the budget for unasked work

// The day's budget for model calls nobody asked for: the app's one (`unasked` in usage.ts) in the app, anything with
// `take(reason)` in a check. Its answer may be a yes/no or a `{ ok, release }`; `release` hands the turn back when the
// model never answered. `dailyBudget` is a plain two-a-day counter for checks.
type Take = boolean | { ok: boolean; release?: () => void };
export type UnaskedBudget = { take(reason: string): Take | Promise<Take> };
export function dailyBudget(cap = 2, now: () => number = clockNow): UnaskedBudget {
  let day = '';
  let used = 0;
  return {
    take() {
      const today = localDay(now());
      if (today !== day) { day = today; used = 0; }
      if (used >= cap) return false;
      used += 1;
      return true;
    },
  };
}
export const granted = async (budget: UnaskedBudget, reason: string): Promise<{ ok: boolean; release: () => void }> => {
  const answer = await Promise.resolve(budget.take(reason)).catch(() => false as Take);
  return typeof answer === 'boolean' ? { ok: answer, release: () => {} } : { ok: !!answer?.ok, release: answer?.release ?? (() => {}) };
};

// ------------------------------------------------------------ the runtime

type Pending = { docId: string; roomId: string; at: number; read: string[]; said: string[] };
// `basis`: the inputs the flag was worked on (economics.ts snapshot, as JSON); `kinds`: each flag's kind. A flag on the
// figures whose inputs changed since is worked again, and withdrawn when the doc agrees with the numbers now.
export type Flagged = { id: string; docId: string; roomId: string; who: string; title: string; flags: string[]; verdict: string; ask: string; at: number; by: string; basis?: string; kinds?: ReviewFlag['kind'][] };
type ReviewState = { pending: Pending[]; seen: Record<string, string>; open: Flagged[] };

export type ReviewDeps = {
  workspace: string;
  store: { loadStage(): Promise<Stage>; readDoc(id: string): Promise<string>; appendChat(roomId: string, message: { id: string; role: 'user' | 'assistant'; text: string; at: number; from?: string }): Promise<unknown> };
  attention: { refresh(): Promise<unknown> };
  busy: Set<string>;
  now: () => number;
  budget: UnaskedBudget;
  // The Company document as it is now.
  company: (stage: Stage) => Promise<{ id: string; text: string } | null>;
  // The one picture of the numbers (economics.ts), with the founder's corrections and readings in it.
  economics?: (stage: Stage) => Promise<EconomicsState | null>;
  // The partner's words for the line, on a small model: null when it could not.
  phrase?: (prompt: string) => Promise<string | null>;
  notify?: (title: string, body: string) => void;
};

const MOST_SOURCE = 6000;
const MOST_SEEN = 40_000;
const isDocWrite = (kind?: string) => kind === 'doc-created' || kind === 'doc-changed';

export function createReviews(deps: ReviewDeps) {
  const path = join(deps.workspace, 'reviews.json');
  let held: ReviewState | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<ReviewState> => {
    if (held) return held;
    const saved = await readBook<Partial<ReviewState>>(path, deps.workspace, { empty: { pending: [], seen: {}, open: [] }, what: { thing: 'The partner\'s reviews file', again: 'the partner\'s reviews started again', first: 'the partner\'s reviews start empty' } });
    held = { pending: Array.isArray(saved?.pending) ? saved.pending : [], seen: saved?.seen && typeof saved.seen === 'object' ? saved.seen : {}, open: Array.isArray(saved?.open) ? saved.open : [] };
    return held;
  };
  const change = <T>(edit: (state: ReviewState) => T | Promise<T>): Promise<T> => {
    const job = queue.then(async () => {
      const state = await read();
      const out = await edit(state);
      await writeAtomic(path, JSON.stringify(state, null, 2), { mkdir: true });
      return out;
    });
    queue = job.catch(() => {});
    return job;
  };

  // A colleague's turn is finished: each doc it wrote waits for the next tick, with what the turn read.
  const heard: Handler<'turn:after'> = async (payload, next) => {
    const writes = payload.reply.tools.filter((tool) => tool.ok !== false && isDocWrite(tool.effect?.kind) && typeof (tool.effect as { id?: unknown })?.id === 'string');
    if (writes.length && !payload.reply.stopped) {
      const results = payload.reply.tools.filter((tool) => tool.ok !== false).map((tool) => (tool.result ?? '').slice(0, MOST_SOURCE));
      const read = [payload.query.slice(0, MOST_SOURCE), ...results];
      await change((state) => {
        for (const docId of new Set(writes.map((tool) => (tool.effect as { id: string }).id))) {
          state.pending = [...state.pending.filter((one) => one.docId !== docId), { docId, roomId: payload.roomId, at: deps.now(), read, said: read }];
        }
      }).catch((error: Error) => console.error(`partner review: ${error.message}`));
    }
    return next(payload);
  };

  async function reviewOne(stage: Stage, partner: { id: string; name: string }, job: Pending, company: { id: string; text: string } | null): Promise<void> {
    const room = stage.rooms.find((one) => one.id === job.roomId);
    const doc = stage.docs.find((one) => one.id === job.docId);
    if (!room || room.partner || !doc || doc.id === company?.id) return;
    const text = await deps.store.readDoc(doc.id).catch(() => null);
    if (text === null) return;
    const { seen } = await read();
    const others = await Promise.all(readableDocIds(stage, room.id).filter((id) => id !== doc.id).map((id) => deps.store.readDoc(id).catch(() => '')));
    const sources = [...job.read, ...others.map((one) => one.slice(0, MOST_SOURCE))];
    const twins = stage.docs.filter((one) => one.id !== doc.id && one.title.trim().toLowerCase() === doc.title.trim().toLowerCase()).length;
    const numbers = company ? sectionText(company.text, 'Numbers') : '';
    const state = (await deps.economics?.(stage).catch(() => null)) ?? stateOf(numbers);
    const review = reviewDoc({ text, before: seen[doc.id] ?? '', numbers, read: sources, said: sources, title: doc.title, twins, state });
    await change((state) => {
      state.seen[doc.id] = text.slice(0, MOST_SEEN);
      const keys = Object.keys(state.seen);
      for (const key of keys.slice(0, Math.max(0, keys.length - 100))) delete state.seen[key];
    });
    if (!review.checked) return;
    const full = reviewLine(doc.title, review);
    let line = full;
    // The model only puts it in the partner's words, within the day's budget, and only for a review that found something.
    const taken = review.flags.length && deps.phrase ? await granted(deps.budget, 'partner review') : null;
    if (taken?.ok && deps.phrase) {
      const phrased = await deps.phrase(`You are ${partner.name}, the founder's partner. You reviewed "${doc.title}", written by ${room.name}. Say to ${room.name}, in one or two short plain sentences, what must be fixed and why it matters to the founder. Use only these facts and numbers, nothing else:\n${full}`).catch(() => undefined);
      // No model answered: the turn never ran, so it goes back to the day's budget.
      if (phrased === undefined) taken.release();
      if (phrased && phrasingHolds(phrased, full)) line = `${phrased.trim()}\n${review.flags.map((flag) => `- ${flag.said}`).join('\n')}\n${review.verdict}`;
    }
    const at = deps.now();
    await deps.store.appendChat(room.id, { id: newMessageId(), role: 'user', from: partner.name, text: line, at });
    if (!review.flags.length) {
      // A flag already raised on this doc that the doc no longer bears out is withdrawn on its next review.
      const dropped = await change((state) => { const had = state.open.length; state.open = state.open.filter((one) => one.docId !== doc.id); return had !== state.open.length; });
      if (dropped) await deps.attention.refresh().catch(() => {});
      return;
    }
    const flagged: Flagged = { id: `${doc.id}-${at.toString(36)}`, docId: doc.id, roomId: room.id, who: room.name, title: doc.title, flags: review.flags.map((flag) => flag.said), verdict: review.verdict, ask: fixAsk(doc.title, review), at, by: partner.name, basis: JSON.stringify(state.snapshot()), kinds: review.flags.map((flag) => flag.kind) };
    await change((state) => { state.open = [...state.open.filter((one) => one.docId !== doc.id), flagged].slice(-50); });
    await deps.attention.refresh().catch(() => {});
    deps.notify?.(`${partner.name} flagged ${doc.title}`, review.verdict);
  }

  // Journey 16: the first "Sam flagged" sat four days on a right doc after the founder put the inputs right. A flag on
  // the figures is worked again whenever the inputs it was made on change: one that no longer stands is withdrawn, its
  // row cleared and one line said in the colleague's room; one that still stands is said with the numbers now.
  async function withdrawStale(stage: Stage, partner: { id: string; name: string }, company: { id: string; text: string } | null) {
    const { open } = await read();
    const numbers = company ? sectionText(company.text, 'Numbers') : '';
    const state = (await deps.economics?.(stage).catch(() => null)) ?? stateOf(numbers);
    const now = JSON.stringify(state.snapshot());
    let cleared = false;
    for (const one of open.filter((each) => each.basis && each.basis !== now && each.kinds?.includes('sense'))) {
      const text = await deps.store.readDoc(one.docId).catch(() => null);
      const sense = text === null ? [] : senseFlags(text, state).flags;
      const rest = one.flags.filter((_flag, index) => one.kinds![index] !== 'sense');
      const restKinds = one.kinds!.filter((kind) => kind !== 'sense');
      if (sense.length || rest.length) {
        const flags = [...sense.map((flag) => flag.said), ...rest];
        await change((state2) => { const held2 = state2.open.find((each) => each.id === one.id); if (held2) Object.assign(held2, { flags, kinds: [...sense.map(() => 'sense' as const), ...restKinds], basis: now, verdict: `Fix first: ${[...sense.map((flag) => flag.short), ...(rest.length ? [one.verdict.replace(/^Fix first: |\.$/g, '').split('; ').slice(-rest.length).join('; ')] : [])].join('; ')}.` }); });
        continue;
      }
      await change((state2) => { state2.open = state2.open.filter((each) => each.id !== one.id); });
      await deps.store.appendChat(one.roomId, { id: newMessageId(), role: 'user', from: partner.name, text: `I take back my flag on "${one.title}": the numbers changed since, and the doc agrees with them now. Fit for the founder.`, at: deps.now() }).catch(() => {});
      cleared = true;
    }
    if (cleared) await deps.attention.refresh().catch(() => {});
  }

  return {
    heard,
    // ---- the review tick: each doc written since, reviewed once; one whose writer is mid-turn waits.
    async tick(partner: { id: string; name: string } | undefined) {
      const { pending, open } = await read();
      if (!pending.length && !open.some((one) => one.basis)) return;
      if (!partner) { await change((state) => { state.pending = []; }); return; }
      const stage = await deps.store.loadStage();
      const company = await deps.company(stage).catch(() => null);
      await withdrawStale(stage, partner, company).catch((error: Error) => console.error(`partner review: ${error.message}`));
      for (const job of [...pending]) {
        if (deps.busy.has(job.roomId)) continue;
        await change((state) => { state.pending = state.pending.filter((one) => one !== job && !(one.docId === job.docId && one.at === job.at)); });
        await reviewOne(stage, partner, job, company).catch((error: Error) => console.error(`partner review: ${error.message}`));
      }
    },
    // What waits for the founder: one row per flagged doc, until Fix or Ignore.
    async rows(): Promise<Attention[]> {
      return (await read()).open.map((one) => ({
        id: `review-flag:${one.id}`, kind: 'review-flag' as const, at: one.at, who: one.by, roomId: one.roomId,
        title: `${one.by} flagged: ${one.who}'s "${one.title}". ${one.verdict}`,
        detail: one.flags.join(' '), about: one.ask,
      }));
    },
    // The founder's answer: Fix hands back the ask for the colleague's room (the window sends it as the founder's own
    // words), Ignore lets it go. Either way the row goes.
    async answer(id: string): Promise<Flagged | null> {
      return change((state) => {
        const found = state.open.find((one) => one.id === id) ?? null;
        state.open = state.open.filter((one) => one.id !== id);
        return found;
      });
    },
    settled: () => queue,
  };
}
export type Reviews = ReturnType<typeof createReviews>;
