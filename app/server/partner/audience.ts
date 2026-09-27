import { companyFacts } from './keep.ts';

// A reply written for the company's customers is not an investor update. Journey 5's beta-user update came back with
// "[Board]" source tags, "Asks (founder to add)", "Runway card not wired" and "fill in any missing metrics, and send it
// to your beta users". What goes to customers carries no source tags, no placeholders, no notes about cards, and none
// of the company's own money (cash, burn, runway); a draft that still holds those is never called ready to send.

const READERS = '(?:customers?|users?|testers?|subscribers?|clients?|members?)';
const TO_THEM = new RegExp(`\\b(?:to|for)\\s+(?:(?:my|our|the|all|your|each|every)\\s+)?(?:\\d+\\s+)?(?:(?:paying|beta|active|early|trial|pilot|free|new|existing)[- ]){0,2}${READERS}\\b`, 'i');
const THEIR = new RegExp(`\\b(?:beta[- ]?)?${READERS}['’]?\\s+(?:update|email|e-mail|newsletter|announcement|note|letter)\\b`, 'i');
const WRITING = /\b(?:update|email|e-mail|message|note|newsletter|announcement|letter|post|write|draft|send)\b/i;

// Whether the founder's ask is for something the customers will read.
export const forCustomers = (ask: string) => WRITING.test(ask) && (TO_THEM.test(ask) || THEIR.test(ask));

// Said to the partner before they write it.
export const CUSTOMER_LINE = 'This is for the company\'s customers to read, not for investors: write it ready to send, in the founder\'s voice, '
  + 'with no source tags in brackets, no placeholders for the founder to fill in, no notes about cards, and none of the company\'s cash, burn or runway.';

const TAG = /\s?\[(?:Board|Decisions?|Metrics|Leads|Runway|Company|Survey|Notes?|Library)(?:\s[^\]\n]{0,40})?\]/g;
const PLACEHOLDER = /founder to add|\(to add\)|\bto be added\b|\bTBD\b|fill in (?:any|the) missing|\bnot wired\b|\[(?:insert|add) [^\]\n]*\]/i;
const READY = /[^.!?\n]*\b(?:ready to send|send-ready|ready to go|good to go|send it (?:to|now|as is)|you can send it|copy and send|paste and send)\b[^.!?\n]*[.!?]?/gi;
const MONEY = /[$€£]\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m)?/gi;
const HEADING = /^\s*#{1,6}\s/;
const amount = (digits: string, scale?: string) => Number(digits.replace(/,/g, '')) * ({ k: 1e3, m: 1e6 }[(scale ?? '').toLowerCase() as 'k'] ?? 1);

// What of the company's own money a text still shows: cash, burn, runway, in that order.
export function internalIn(text: string, numbers: string): string[] {
  const facts = companyFacts(numbers).numbers;
  const known = (label: string) => { const value = facts.find((one) => one.label === label)?.value; const found = value ? /(\d[\d,]*(?:\.\d+)?)\s?(k|m)?/i.exec(value) : null; return found ? amount(found[1], found[2]) : null; };
  const figures = [...text.matchAll(MONEY)].map((match) => amount(match[1], match[2]));
  const lines = text.split('\n');
  const said = (words: RegExp, figure: RegExp) => lines.some((line) => words.test(line) && figure.test(line));
  const found: string[] = [];
  if (said(/\b(?:cash|in the bank|bank balance|savings)\b/i, /[$€£]\s?\d/) || figures.includes(known('Cash') ?? NaN)) found.push('cash');
  if (said(/\bburn\w*\b/i, /[$€£]\s?\d/) || figures.includes(known('Burn') ?? NaN)) found.push('burn');
  if (said(/\brunway\b/i, /\d/)) found.push('runway');
  return found;
}

// The reply as it can go to customers: tags and placeholders out, any heading left with nothing under it out, and when
// the company's own money is still in it, the ready-to-send claim out and a line under it that says so.
export function customerReply(reply: string, numbers: string): string {
  let lines = reply.split('\n').map((line) => line.replace(TAG, '')).filter((line) => !PLACEHOLDER.test(line));
  // The truth net's own lines under the reply are not part of what goes out.
  const internal = internalIn(lines.filter((line) => !/^(?:Unsourced figures: |Unconfirmed: )/.test(line)).join('\n'), numbers);
  if (internal.length) lines = lines.flatMap((line) => { const kept = line.replace(READY, '').replace(/\s+$/, ''); return kept.trim() || !line.trim() ? [kept] : []; });
  // A heading with nothing left under it before the next heading of its level or higher goes too.
  const level = (line: string) => /^\s*(#{1,6})\s/.exec(line)?.[1].length ?? 0;
  lines = lines.filter((line, index) => {
    if (!HEADING.test(line)) return true;
    const next = lines.slice(index + 1).find((one) => one.trim());
    return !!next && (!HEADING.test(next) || level(next) > level(line));
  });
  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (internal.length) text += `\n\nNot for customers: ${internal.join(', ')}. Take them out before this goes to anyone outside the company.`;
  return text === reply.trim() ? reply : text;
}
