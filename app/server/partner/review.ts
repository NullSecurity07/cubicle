import { join } from 'node:path';
import { newMessageId, type Attention, type Stage } from '../../shared/model.ts';
import { writeAtomic } from '../fsx.ts';
import { readableDocIds } from '../prompt.ts';
import { readBook } from '../rescue.ts';
import type { Handler } from '../seams.ts';
import { calculate } from '../tools/calc.ts';
import { markUnbacked, markUnworked, unbackedClaims } from '../tools/evidence.ts';
import { unsourcedIn } from './call.ts';
import { sectionText } from './company.ts';
import { economicsOf, type Inputs } from './economics.ts';

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

export type ReviewFlag = { kind: 'number' | 'sense' | 'claim'; said: string; short: string; line?: number };
export type DocReview = { flags: ReviewFlag[]; verdict: string; checked: boolean };

const FIT = 'Fit for the founder.';
const MARK = '(assumption)';
const money = (value: number, currency = '') => `${value < 0 ? '-' : ''}${currency}${Math.abs(Math.round(value * 100) / 100).toLocaleString('en-US')}`;
const clip = (text: string, most = 70) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > most ? `${flat.slice(0, most - 1)}…` : flat; };

// ------------------------------------------------------------ (b) sense: the derived figures, worked out again

type Derived = { name: 'net burn' | 'runway' | 'margin' | 'margin %'; right: number; working: string; shown: string; near: (claimed: number) => boolean; hint?: (claimed: number) => string };
const within = (share: number, least: number) => (right: number) => (claimed: number) => Math.abs(claimed - right) <= Math.max(least, Math.abs(right) * share);

// What the brief's Numbers give for each derived figure, each with its calc working.
export function rightFigures(inputs: Inputs, unit = 'paying customers', currency = ''): Derived[] {
  const out: Derived[] = [];
  const { price, cost, fixed, cash, paying } = inputs;
  let net = inputs.net;
  if (net !== undefined) {
    out.push({ name: 'net burn', right: net, working: `the Company brief gives ${money(net, currency)} a month`, shown: `${money(net, currency)} a month`, near: within(0.02, 1)(net) });
  } else if (fixed !== undefined && paying !== undefined && price !== undefined && cost !== undefined) {
    const worked = calculate('fixed + paying * cost - paying * price', `fixed=${fixed}, paying=${paying}, cost=${cost}, price=${price}`);
    if (worked.value > 0) {
      net = worked.value;
      const mrrOnly = fixed - paying * price;
      out.push({
        name: 'net burn', right: net, working: `${worked.worked} = ${worked.display} (calc)`, shown: `${money(net, currency)} a month`, near: within(0.02, 1)(net),
        hint: (claimed) => (Math.abs(claimed - mrrOnly) <= Math.max(1, Math.abs(mrrOnly) * 0.02) ? `it leaves out what the ${paying} ${unit} cost (${money(paying * cost, currency)} a month)`
          : Math.abs(claimed - fixed) <= Math.max(1, fixed * 0.02) ? 'it is the burn before anything the paying ones bring in' : ''),
      });
    }
  }
  if (cash !== undefined && net !== undefined && net > 0) {
    const worked = calculate('round(cash / net, 1)', `cash=${cash}, net=${net}`);
    out.push({ name: 'runway', right: worked.value, working: `${worked.worked} = ${worked.display} (calc)`, shown: `${worked.display} months`, near: within(0.03, 0.15)(worked.value) });
  }
  if (price !== undefined && cost !== undefined && price > 0) {
    const each = calculate('price - cost', `price=${price}, cost=${cost}`);
    out.push({ name: 'margin', right: each.value, working: `${each.worked} = ${each.display} (calc)`, shown: `${money(each.value, currency)} a month on each`, near: within(0.02, 1)(each.value) });
    const share = calculate('round((price - cost) / price * 100, 1)', `price=${price}, cost=${cost}`);
    out.push({ name: 'margin %', right: share.value, working: `${share.worked} = ${share.display} (calc)`, shown: `${share.display}%`, near: within(0, 1)(share.value) });
  }
  return out;
}

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

// Each derived figure the doc states that the brief's numbers do not give, with the right one and its working.
export function senseFlags(text: string, numbers: string): { flags: ReviewFlag[]; lines: Set<number> } {
  const economics = economicsOf(numbers);
  const lines = new Set<number>();
  if (!economics?.inputs) return { flags: [], lines };
  const derived = rightFigures(economics.inputs, economics.unit, economics.currency ?? '');
  const by = (name: Derived['name']) => derived.find((one) => one.name === name);
  const flags: ReviewFlag[] = [];
  const said = new Set<string>();
  text.split('\n').forEach((line, index) => {
    if (/^\s*#/.test(line) || /^\s*(?:>|```)/.test(line)) return;
    const runway = /\brunway\b/i.exec(line);
    const margin = /\b(?:gross\s+|unit\s+|contribution\s+)?margins?\b/i.exec(line);
    const net = /\bnet\s+burn\b/i.exec(line);
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
        const perUnit = economics.unit ? new RegExp(`\\bper\\s+${economics.unit.split(' ').pop()!.replace(/s$/, '')}\\b|\\ba month\\b|\\bper month\\b|\\/\\s?mo`, 'i') : /\ba month\b|\bper month\b/i;
        const claimed = each && perUnit.test(line) ? claimedOn(line, margin, (one) => one.money) : undefined;
        if (each && claimed) found = { derived: each, claimed };
      }
    }
    const netRight = by('net burn');
    if (!found && net && netRight) {
      const claimed = claimedOn(line, net, (one) => !one.share && !one.months);
      if (claimed) found = { derived: netRight, claimed };
    }
    if (!found || found.derived.near(found.claimed.value)) return;
    lines.add(index);
    const { derived: right, claimed } = found;
    if (said.has(right.name)) return;
    said.add(right.name);
    const hint = right.hint?.(claimed.value);
    const what = right.name === 'margin %' ? 'margin' : right.name;
    flags.push({
      kind: 'sense',
      said: `${what[0].toUpperCase()}${what.slice(1)} is ${right.shown}, not ${claimed.text}: ${right.working}${hint ? `; ${hint}` : ''}.`,
      short: `${what} is ${right.shown}, not ${claimed.text}`, line: index,
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

const CLAIMISH = /\b(?:customers?|users?|clients?|managers?|offices?|staff|people|they|feedback|works|validated|proven|love|loved|report\w*|say|said|demand|popular)\b/i;

// One doc, reviewed. `read` is everything the writer's turn read (tool results, the founder's ask) and what they could
// read without asking (the Company brief, their wired docs); `said` is what may back a claim of what someone said or did.
export function reviewDoc(input: { text: string; before?: string; numbers: string; read: string[]; said: string[] }): DocReview {
  const before = input.before ?? '';
  const added = addedLines(before, input.text);
  const addedText = added.map((one) => one.line).join('\n');
  const checked = /\d/.test(addedText) || CLAIMISH.test(addedText);
  if (!added.length) return { flags: [], verdict: FIT, checked: false };
  const flags: ReviewFlag[] = [];
  // (b) first: a wrong derived figure is named once, with the right one, not again as unsourced.
  const sense = senseFlags(input.text, input.numbers);
  const addedAt = new Set(added.map((one) => one.index));
  flags.push(...sense.flags.filter((flag) => flag.line !== undefined && addedAt.has(flag.line)).map(({ line: _line, ...flag }) => flag));
  // (a) the guard's own checks, on the added lines only: a count nothing read gives, and a derived figure no calc
  // worked out. The working of the right figures is read too, so a figure that matches it stands.
  const sums = rightFigures(economicsOf(input.numbers)?.inputs ?? {}).flatMap((one) => (/ = /.test(one.working) ? [one.working.replace(/ \(calc\)$/, '')] : []));
  const read = [input.numbers, ...input.read, ...sums];
  const bare = input.text.split('\n').map((line, index) => (sense.lines.has(index) ? '' : line)).join('\n');
  const marks = [...markUnworked({ before, after: bare, read }).marked, ...markUnbacked({ before, after: bare, read }).marked];
  const figures = [...new Set(marks.map((mark) => mark.label))];
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

// The day's budget for model calls nobody asked for. Written against `take(reason)` so the app-wide one (in usage.ts)
// drops in; its answer may be a yes/no or a `{ ok }`. The default is two a day.
export type UnaskedBudget = { take(reason: string): boolean | { ok: boolean } | Promise<boolean | { ok: boolean }> };
export function dailyBudget(cap = 2, now: () => number = Date.now): UnaskedBudget {
  let day = '';
  let used = 0;
  return {
    take() {
      const today = new Date(now()).toDateString();
      if (today !== day) { day = today; used = 0; }
      if (used >= cap) return false;
      used += 1;
      return true;
    },
  };
}
export const granted = async (budget: UnaskedBudget, reason: string) => {
  const answer = await Promise.resolve(budget.take(reason)).catch(() => false);
  return typeof answer === 'boolean' ? answer : !!answer?.ok;
};

// ------------------------------------------------------------ the runtime

type Pending = { docId: string; roomId: string; at: number; read: string[]; said: string[] };
export type Flagged = { id: string; docId: string; roomId: string; who: string; title: string; flags: string[]; verdict: string; ask: string; at: number; by: string };
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
    const review = reviewDoc({ text, before: seen[doc.id] ?? '', numbers: company ? sectionText(company.text, 'Numbers') : '', read: sources, said: sources });
    await change((state) => {
      state.seen[doc.id] = text.slice(0, MOST_SEEN);
      const keys = Object.keys(state.seen);
      for (const key of keys.slice(0, Math.max(0, keys.length - 100))) delete state.seen[key];
    });
    if (!review.checked) return;
    const full = reviewLine(doc.title, review);
    let line = full;
    // The model only puts it in the partner's words, within the day's budget, and only for a review that found something.
    if (review.flags.length && deps.phrase && await granted(deps.budget, 'partner review')) {
      const phrased = await deps.phrase(`You are ${partner.name}, the founder's partner. You reviewed "${doc.title}", written by ${room.name}. Say to ${room.name}, in one or two short plain sentences, what must be fixed and why it matters to the founder. Use only these facts and numbers, nothing else:\n${full}`).catch(() => null);
      if (phrased && phrasingHolds(phrased, full)) line = `${phrased.trim()}\n${review.flags.map((flag) => `- ${flag.said}`).join('\n')}\n${review.verdict}`;
    }
    const at = deps.now();
    await deps.store.appendChat(room.id, { id: newMessageId(), role: 'user', from: partner.name, text: line, at });
    if (!review.flags.length) return;
    const flagged: Flagged = { id: `${doc.id}-${at.toString(36)}`, docId: doc.id, roomId: room.id, who: room.name, title: doc.title, flags: review.flags.map((flag) => flag.said), verdict: review.verdict, ask: fixAsk(doc.title, review), at, by: partner.name };
    await change((state) => { state.open = [...state.open.filter((one) => one.docId !== doc.id), flagged].slice(-50); });
    await deps.attention.refresh().catch(() => {});
    deps.notify?.(`${partner.name} flagged ${doc.title}`, review.verdict);
  }

  return {
    heard,
    // ---- the review tick: each doc written since, reviewed once; one whose writer is mid-turn waits.
    async tick(partner: { id: string; name: string } | undefined) {
      const { pending } = await read();
      if (!pending.length) return;
      if (!partner) { await change((state) => { state.pending = []; }); return; }
      const stage = await deps.store.loadStage();
      const company = await deps.company(stage).catch(() => null);
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
