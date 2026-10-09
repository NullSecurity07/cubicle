import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from '../fsx.ts';
import { now as clockNow } from '../clock.ts';

// The founder's "no", kept. Journeys found people putting the same thing in front of the founder again a day after
// they had turned it down: "cut the price to €29" declined with a reason, and back in the next morning's advice as if
// it were new. Every no the founder gives (Don't on an approval, Reject on a coder's question, Decline on a bet, a plan
// or a decision, Dismiss on a drafted email, a chat reply that opens with "no" to a proposal) is written here, in
// `workspace/said-no.json`, and read by the standing facts and every person's prompt. A proposal that matches one
// within the window is held in code, not by a prompt line: asked again once with the earlier no quoted, then not
// raised at all.

export type SaidNoEntry = {
  id: string;
  // The tool that proposed it (`propose_bet`, `send_email`, `coder_permission`…), or `chat` for a proposal in words.
  tool: string;
  // What was proposed, short: a bet's what, a decision's title, an email's subject.
  subject: string;
  // The one thing it is about when there is one: a lead's address, a decision or doc id, a source's address.
  key?: string;
  // Whom it was for, when that makes it a different proposal: the same subject to another address is another email.
  to?: string;
  who?: string;
  // The latest no; the window counts from here.
  at: number;
  reason?: string;
  // A decision's options and the pick its proposer made: what it would do, whatever its title says.
  options?: string[];
  pick?: string;
  // How often it has been put to the founder again since the first no: once is all it gets.
  asked: number;
};

export type Proposal = { tool: string; subject: string; key?: string; to?: string; who?: string; options?: string[]; pick?: string };
export type SaidNoCheck = { verdict: 'fresh' } | { verdict: 'reask' | 'declined'; entry: SaidNoEntry; line: string };

export const SAID_NO_MOST = 50;
export const SAID_NO_SHOWN = 10;
export const SAID_NO_WINDOW_DAYS = 14;
export const SAID_NO_OVERLAP = 0.6;
const DAY = 86_400_000;

// Tools that propose the same kind of thing are one family: an email drafted and an email sent, one task or many.
const FAMILY: Record<string, string> = { draft_email: 'email', send_email: 'email', propose_task: 'tasks', propose_tasks: 'tasks' };
const familyOf = (tool: string) => FAMILY[tool] ?? tool;

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'our', 'your', 'you', 'are', 'was', 'were', 'will', 'would', 'should',
  'have', 'has', 'been', 'then', 'than', 'them', 'they', 'about', 'just', 'only', 'also', 'more', 'all', 'any', 'can', 'could', 'its', 'let', 'lets',
  'out', 'now', 'new', 'get', 'got', 'put', 'make', 'use', 'via', 'per', 'off', 'one', 'not', 'but']);
// The words that say what a proposal is: figures of any length, words of three letters or more, without the glue.
export const subjectWords = (text: string) => [...new Set((text.toLowerCase().match(/\d+(?:[.,]\d+)?|[a-z][a-z'-]{2,}/g) ?? []).map((word) => word.replace(/,/g, '')).filter((word) => !STOP.has(word)))];

// How much two subjects share, from 0 to 1: twice the words in common over all the words of both.
export function overlap(a: string, b: string): number {
  const left = subjectWords(a);
  const right = new Set(subjectWords(b));
  if (!left.length || !right.size) return 0;
  return (2 * left.filter((word) => right.has(word)).length) / (left.length + right.size);
}

// The same proposal: the same kind of tool (a no said in chat stands against any tool), and the same lead or doc, or
// most of the same words.
export function sameProposal(entry: Pick<SaidNoEntry, 'tool' | 'subject' | 'key' | 'to'>, proposal: Proposal): boolean {
  if (entry.tool !== 'chat' && proposal.tool !== 'chat' && familyOf(entry.tool) !== familyOf(proposal.tool)) return false;
  // An email is the same email only to the same lead and about much the same thing. Journey 15: one Don't on an intro
  // to a lead, keyed by the lead alone, refused every email to her after it, the answer to her own question too.
  if (familyOf(entry.tool) === 'email' && familyOf(proposal.tool) === 'email') {
    if (entry.key && proposal.key && entry.key.toLowerCase() !== proposal.key.toLowerCase()) return false;
    if (entry.to && proposal.to && entry.to !== proposal.to) return false;
    return overlap(entry.subject, proposal.subject) >= SAID_NO_OVERLAP;
  }
  if (entry.key && proposal.key && entry.key.toLowerCase() === proposal.key.toLowerCase()) return true;
  if (entry.to && proposal.to && entry.to !== proposal.to) return false;
  if (overlap(entry.subject, proposal.subject) >= SAID_NO_OVERLAP) return true;
  // Journey 18: a decision declined twice came back a third time as "Referral program with a free month for two
  // referrals", and the partner said the new title "bypasses the duplicate block". A decision is the same decision when
  // it does the same thing: the same effect and most of the same words in its title, options and pick.
  if (DECIDES.has(proposal.tool) && DECIDES.has(entry.tool)) return sameDecision(entry, proposal);
  return false;
}

// The tools whose proposal is a thing to do, matched by what it does rather than what it is called.
const DECIDES = new Set(['propose_decision', 'propose_bet', 'propose_task', 'propose_tasks']);
// What a proposal does, in a few kinds: a price cut is a discount whatever it is called, a free month is free, a reward
// for bringing others is a referral.
const EFFECTS: [string, RegExp][] = [
  ['discount', /\bdiscount\w*|\d+\s*%\s*(?:off|discount|cheaper|reduction)|\bpercent\s+off\b|\bcheaper\b|\bprice\s+cut|\b(?:cut|lower|reduce|drop)\w*\s+(?:the\s+|our\s+)?prices?\b|\bcoupon|\bpromo\s+code/i],
  ['free', /\bfree\s+(?:month|months|week|weeks|period|plan|tier|access|seat|seats)\b|\bfor\s+free\b|\bcomplimentary\b|\bon\s+the\s+house\b/i],
  ['referral', /\brefer(?:s|red|ring|ral|rals)?\b|\bword\s+of\s+mouth\b|\binvite\s+(?:friends|colleagues|others)\b/i],
  ['raise', /\b(?:raise|increase|lift)\w*\s+(?:the\s+|our\s+)?prices?\b|\bprice\s+(?:rise|increase|hike)\b/i],
  ['outreach', /\boutreach\b|\bcold\s+(?:email|emails|call|calls|message|messages|dm)\b|\breach\s+out\b/i],
  ['ads', /\b(?:paid|google|facebook|meta|linkedin|instagram)\s+ads?\b|\bad\s+(?:spend|campaign)\b/i],
  ['hire', /\bhir(?:e|ing)\b|\bcontractor\b|\bfreelancer\b/i],
];
// What a proposal does by its title and its pick; what it says it will do without does not count.
export function effectsOf(text: string): Set<string> {
  const doing = text.replace(WITHOUT, ' ');
  return new Set(EFFECTS.filter(([, test]) => test.test(doing)).map(([name]) => name));
}
const decisionText = (one: Pick<Proposal, 'subject' | 'options' | 'pick'>) => [one.subject, one.pick ?? '', ...(one.options ?? [])].join('\n');
// How much of the shorter of two word sets is in the longer, from 0 to 1, on words that say the same act as one.
export function shareOf(a: string, b: string): number {
  const left = actWords(a);
  const right = actWords(b);
  if (!left.size || !right.size) return 0;
  return [...left].filter((word) => right.has(word)).length / Math.min(left.size, right.size);
}
export const DECISION_SHARE = 0.5;
export function sameDecision(entry: Pick<Proposal, 'subject' | 'options' | 'pick'>, proposal: Pick<Proposal, 'subject' | 'options' | 'pick'>): boolean {
  const was = effectsOf(`${entry.subject}\n${entry.pick ?? ''}`);
  const now = effectsOf(`${proposal.subject}\n${proposal.pick ?? ''}`);
  if (!was.size || was.size !== now.size || [...was].some((one) => !now.has(one))) return false;
  return shareOf(entry.subject, proposal.subject) >= DECISION_SHARE || shareOf(decisionText(entry), decisionText(proposal)) >= DECISION_SHARE;
}

const short = (text: string, most: number) => { const one = text.replace(/\s+/g, ' ').trim(); return one.length > most ? `${one.slice(0, most - 1)}…` : one; };
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const DAY_NAME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
export const saidOn = (at: number) => DAY_NAME.format(new Date(at));

// What a tool call proposes, in the words the log keeps. `leads` are the addresses on the Leads cards: an email to one
// of them is about that lead, whatever its subject says. Nothing for a question put to the founder.
export function proposalOf(tool: string, args: Record<string, unknown>, leads: Iterable<string> = []): Proposal | null {
  if (tool === 'ask_founder') return null;
  const lead = new Set([...leads].map((one) => one.toLowerCase()));
  switch (tool) {
    case 'propose_bet': return { tool, subject: short(string(args.what) || string(args.hypothesis), 160) };
    case 'propose_decision': {
      const options = Array.isArray(args.options) ? args.options.filter((one): one is string => typeof one === 'string' && !!one.trim()).map((one) => short(one, 160)).slice(0, 5) : [];
      const pick = short(string(args.recommendation), 200);
      return { tool, subject: short(string(args.title), 160), ...(options.length ? { options } : {}), ...(pick ? { pick } : {}) };
    }
    case 'propose_task': case 'propose_tasks': return { tool, subject: short(string(args.title), 160) };
    case 'propose_source': return { tool, subject: short(`${string(args.about)} ${string(args.url)}`, 160), ...(string(args.url) ? { key: string(args.url) } : {}) };
    case 'propose_target': return { tool, subject: short(`${string(args.key)} target ${String(args.value ?? '')}`, 160), ...(string(args.key) ? { key: `target:${string(args.key)}` } : {}) };
    case 'draft_email': case 'send_email': {
      const to = string(args.to).split(/[,;\s]+/).filter(Boolean).map((one) => one.toLowerCase());
      const known = to.find((one) => lead.has(one));
      return { tool, subject: short(string(args.subject) || `email to ${to.join(', ')}`, 160), ...(to.length ? { to: [...to].sort().join(',') } : {}), ...(known ? { key: `lead:${known}` } : {}) };
    }
    case 'coder_permission': return { tool, subject: short(string(args.command) || string(args.file), 160) };
    default: {
      const said = Object.values(args).filter((value): value is string => typeof value === 'string' && !!value.trim()).join(' ');
      return said.trim() ? { tool, subject: short(said, 160) } : null;
    }
  }
}

// One line per no, the way a prompt and the standing facts say it.
// What was said no to, with its kind where the subject alone does not say it: an email names whom it was to.
export const whatSaidNo = (entry: Pick<SaidNoEntry, 'tool' | 'subject' | 'to'>) => (familyOf(entry.tool) === 'email' && entry.to
  ? `email to ${entry.to} about "${short(entry.subject, 90)}"` : `"${short(entry.subject, 90)}"`);
export const saidNoLine = (entry: SaidNoEntry) => `- ${whatSaidNo(entry)} (${entry.who ? `${entry.who}, ` : ''}${saidOn(entry.at)}${entry.reason ? `: ${short(entry.reason, 80)}` : ''})`;
export const reaskLine = (entry: SaidNoEntry) => `You said no to this on ${saidOn(entry.at)}${entry.reason ? `: '${short(entry.reason, 120)}'` : ''}. Ask again?`;
export const declinedLine = (entry: SaidNoEntry) => `Already declined: the founder said no to ${whatSaidNo(entry)} on ${saidOn(entry.at)}${entry.reason ? ` ('${short(entry.reason, 120)}')` : ''} `
  + 'and again when it was put to them once more, so it was not raised. Do not propose it again. If something has changed, say what in your reply and let the founder ask for it.';
export const promptLine = (entries: SaidNoEntry[]) => (entries.length
  ? `The founder said no to:\n${entries.slice(0, SAID_NO_SHOWN).map(saidNoLine).join('\n')}\nDo not put these to the founder again unless something has changed, and then say what changed.`
  : '');

// The check itself, on a list: the latest no inside the window that matches. Its first match is asked again; after
// that it is declined.
export function checkAgainst(entries: SaidNoEntry[], proposal: Proposal, now: number): SaidNoCheck {
  const since = now - SAID_NO_WINDOW_DAYS * DAY;
  const entry = entries.filter((one) => one.at >= since && sameProposal(one, proposal)).sort((a, b) => b.at - a.at)[0];
  if (!entry) return { verdict: 'fresh' };
  return entry.asked < 1 ? { verdict: 'reask', entry, line: reaskLine(entry) } : { verdict: 'declined', entry, line: declinedLine(entry) };
}

export type SaidNo = ReturnType<typeof createSaidNo>;

export function createSaidNo(workspace: string, now: () => number = clockNow) {
  const path = join(workspace, 'said-no.json');
  let queue: Promise<unknown> = Promise.resolve();
  async function read(): Promise<SaidNoEntry[]> {
    try {
      const saved = JSON.parse(await readFile(path, 'utf8')) as { entries?: SaidNoEntry[] };
      return Array.isArray(saved.entries) ? saved.entries.filter((one) => one && typeof one.subject === 'string' && typeof one.at === 'number') : [];
    } catch { return []; }
  }
  // One change at a time, each on the list as the one before it left it, newest first and never more than the cap.
  function change<T>(edit: (entries: SaidNoEntry[]) => T): Promise<T> {
    const job = queue.then(async () => {
      const entries = await read();
      const out = edit(entries);
      entries.sort((a, b) => b.at - a.at);
      await writeAtomic(path, JSON.stringify({ entries: entries.slice(0, SAID_NO_MOST) }, null, 2), { mkdir: true });
      return out;
    });
    queue = job.catch(() => {});
    return job;
  }
  return {
    list: async () => (await read()).sort((a, b) => b.at - a.at),
    // A no to something already said no to inside the window is the same no, said again: it keeps its count of
    // asks, so a re-ask turned down is not asked a third time.
    record(proposal: Proposal & { reason?: string }): Promise<SaidNoEntry> {
      const at = now();
      return change((entries) => {
        const reason = proposal.reason?.trim() ? short(proposal.reason, 300) : undefined;
        const held = entries.find((one) => one.at >= at - SAID_NO_WINDOW_DAYS * DAY && sameProposal(one, proposal));
        if (held) {
          Object.assign(held, { at, ...(reason ? { reason } : {}), ...(proposal.who ? { who: proposal.who } : {}) });
          return { ...held };
        }
        const entry: SaidNoEntry = { id: `no-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, tool: proposal.tool, subject: short(proposal.subject, 160), at, asked: 0,
          ...(proposal.key ? { key: proposal.key } : {}), ...(proposal.to ? { to: proposal.to } : {}), ...(proposal.who ? { who: proposal.who } : {}), ...(reason ? { reason } : {}),
          ...(proposal.options?.length ? { options: proposal.options.slice(0, 5) } : {}), ...(proposal.pick ? { pick: proposal.pick } : {}) };
        entries.push(entry);
        return entry;
      });
    },
    check: async (proposal: Proposal) => checkAgainst(await read(), proposal, now()),
    // A reason said in chat just after a Don't that gave none: journey 15's founder pressed Don't (no place for a
    // reason) and said why in the next message, and the no kept nothing to quote.
    explain: (reason: string, within = 15 * 60_000) => change((entries) => {
      const held = entries.filter((one) => !one.reason && one.at >= now() - within).sort((a, b) => b.at - a.at)[0];
      if (held) held.reason = short(reason, 300);
      return held ? { ...held } : null;
    }),
    // Whether a move the partner would put to the founder unasked is one they ruled out, inside the window.
    ruledOut: async (move: string) => ruledOutBy(await read(), move, now()),
    // The proposal went back to the founder once.
    asked: (id: string) => change((entries) => { const held = entries.find((one) => one.id === id); if (held) held.asked += 1; }),
    // The founder said yes to it after all: the no no longer stands.
    forget: (proposal: Proposal) => change((entries) => {
      const since = now() - SAID_NO_WINDOW_DAYS * DAY;
      for (let at = entries.length - 1; at >= 0; at -= 1) if (entries[at].at >= since && sameProposal(entries[at], proposal)) entries.splice(at, 1);
    }),
    // The last ten, as the standing facts and the prompts carry them.
    lines: async () => (await read()).sort((a, b) => b.at - a.at).slice(0, SAID_NO_SHOWN).map(saidNoLine),
  };
}

const shared = new Map<string, SaidNo>();
// One log per workspace, shared by every slice and route that hears a no or checks a proposal.
export function saidNoFor(workspace: string, now?: () => number): SaidNo {
  let book = shared.get(workspace);
  if (!book) { book = createSaidNo(workspace, now); shared.set(workspace, book); }
  return book;
}

// A chat reply that turns a proposal down: "no", "nope", "not now", "don't", with what follows as the reason.
const SAYS_NO = /^\s*(?:no|nope|nah|not|don'?t|do not)\b(?!\s+(?:problem|worries|idea|doubt|rush|need to (?:ask|explain))\b)(?!\s+sure\b)/i;
export function chatNo(reply: string): { reason?: string } | null {
  if (!SAYS_NO.test(reply)) return null;
  const reason = reply.replace(/^\s*(?:no|nope|nah)\b[\s,.:;!—–-]*/i, '').replace(/^(?:because|since|as)\s+/i, '').trim();
  return reason ? { reason: short(reason, 300) } : {};
}
// A proposal put in words, for a chat no to stand against: the sentence that suggests something.
const SUGGESTS = /[^.!?\n]*\b(?:i (?:propose|suggest|recommend)|we should|you should|shall (?:i|we)|should (?:i|we)|want me to|how about|let'?s)\b[^.!?\n]*[.!?]?/i;
export const suggestionIn = (text: string) => SUGGESTS.exec(text)?.[0]?.trim() ?? '';

// A standing no said in so many words: "Don't propose cold outreach to more makers this week", "No to the task of
// contacting 10 more makers, because…", "No more discounts." What it rules out, without the time it was said for.
const RULES_OUT = [
  /\b(?:don'?t|do not|never|stop)\s+(?:propose|proposing|suggest|suggesting|recommend|recommending|raise|raising|bring(?:ing)? up|push(?:ing)?|plan(?:ning)?)\s+(.+)/i,
  /^\s*no\s+to\s+(.+)/i,
  /^\s*no\s+more\s+(.+)/i,
  // Journey 17: "No cold outreach to nurses we have not met, because nurses hate it." was answered "I have recorded
  // that rule" and nothing was kept. "No X", "Never X", "Don't X", "Stop X" at the head of a sentence, with or without
  // ", because …", is a standing no too; "No problem", "No, too early", "Don't worry" and a question are not.
  /^\s*(?:no|never|don'?t|do not|stop)\s+(?!(?:problem|problems|worries|worry|thanks|thank|idea|doubt|rush|need|way|one|matter|sure|longer|later|wait|kidding|biggie|big deal|chance|clue|offen[cs]e|pressure|hurry|know|think|have|forget|mind|understand|see|get|care|want|be|go|it|that|this|them|there|here|now|yet|i|we|you)\b)([a-z].+)/i,
];
const WHEN_SAID = /\s+(?:this|next)\s+(?:week|month)$|\s+(?:today|tomorrow|again|anymore|any more|for now|from now on|until further notice)$/i;
export function standingNosIn(text: string): { subject: string; reason?: string }[] {
  const because = /\b(?:because|since)\s+([^.!?\n]+)/i.exec(text)?.[1]?.trim();
  const found: { subject: string; reason?: string }[] = [];
  for (const sentence of text.split(/(?<=[.!?\n])\s*/)) {
    if (/\?\s*$/.test(sentence)) continue;
    for (const rule of RULES_OUT) {
      const said = rule.exec(sentence)?.[1];
      if (!said) continue;
      let subject = said.split(/,|\s+because\b|\s+since\b|\s+as\s+(?:we|i|it|they)\b|[.!?\n]/i)[0].trim().replace(/^(?:the task of|the idea of|your|the|any)\s+/i, '');
      for (let at = 0; at < 3; at += 1) subject = subject.replace(WHEN_SAID, '').trim();
      if (subjectWords(subject).length) found.push({ subject: short(subject, 160), ...(because ? { reason: short(because, 300) } : {}) });
      break;
    }
  }
  return found;
}

// A move set against a standing no, by the no's own words: most of what the founder ruled out is in the move. Words
// that say the same act count as one ("contact", "reach out", "outreach", "email"), and what a move says it will do
// without ("close the job without cold outreach") is not part of it.
const SAME_ACT: Record<string, string> = {
  contact: 'reach', contacting: 'reach', contacted: 'reach', outreach: 'reach', reach: 'reach', reaching: 'reach', email: 'reach', emailing: 'reach',
  message: 'reach', messaging: 'reach', ping: 'reach', dm: 'reach', call: 'call', calls: 'call', calling: 'call', meeting: 'call', meet: 'call',
  discount: 'discount', discounts: 'discount', discounting: 'discount',
  refer: 'refer', refers: 'refer', referred: 'refer', referring: 'refer', referral: 'refer', referrals: 'refer', month: 'month', months: 'month', cut: 'cut', cutting: 'cut', lower: 'cut', lowering: 'cut',
};
const NOT_THE_ACT = new Set(['propose', 'suggest', 'task', 'tasks', 'week', 'today', 'again', 'move', 'moves', 'idea', 'thing', 'things']);
const canon = (word: string) => SAME_ACT[word] ?? SAME_ACT[word.replace(/s$/, '')] ?? (word.length > 4 ? word.replace(/(?:ing|s)$/, '') : word);
const actWords = (text: string) => new Set(subjectWords(text).filter((word) => !NOT_THE_ACT.has(word) && !/^\d/.test(word)).map(canon));
const WITHOUT = /\b(?:without|instead of|rather than|not|no|never|avoid(?:ing)?|skip(?:ping)?|stop(?:ping)?)\b[^.,;]*/gi;
export function againstNo(no: string, move: string): boolean {
  const ruled = actWords(no);
  if (!ruled.size) return false;
  const doing = actWords(move.replace(WITHOUT, ' '));
  const shared = [...ruled].filter((word) => doing.has(word)).length;
  return shared / ruled.size >= SAID_NO_OVERLAP && (ruled.size > 1 || shared === 1);
}
export function ruledOutBy(entries: SaidNoEntry[], move: string, now: number): SaidNoEntry | undefined {
  const since = now - SAID_NO_WINDOW_DAYS * DAY;
  return entries.filter((one) => one.at >= since && againstNo(one.subject, move)).sort((a, b) => b.at - a.at)[0];
}
// How the note says a move was dropped for it: "You ruled out cold outreach to more makers on 6 Oct."
export const ruledOutLine = (entry: SaidNoEntry) => `You ruled out ${entry.tool === 'chat' ? short(entry.subject, 90) : `"${short(entry.subject, 90)}"`} on ${saidOn(entry.at)}${entry.reason ? ` ('${short(entry.reason, 100)}')` : ''}`;
