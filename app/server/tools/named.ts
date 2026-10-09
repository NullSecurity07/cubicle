// Customers by name, held to the record. Journey 21: the brief said "6 paying cafés" and named none; Lea's "Customer
// notes" named six ("Café Neukölln: Organiser: Sarah ... Volunteers love seeing the item list", "Kreuzberg Repair Hub:
// Organiser: Jan ... requested SMS reminders") and four more, each with feedback nobody gave, and the partner's
// review passed it. A place or a person a doc presents as a customer, a lead or a user must be on record: a row on
// the Leads card, the brief, something read, the founder's words. And what a named one said, wanted or did needs
// their own words on record (their reply, notes on their row), not a line in somebody else's doc.

import type { Stage } from '../../shared/model.ts';
import { leadRecord } from '../../shared/leads.ts';
import { leadsCardIds, leadsFor } from '../leads/store.ts';

const HEADING = /^\s*(#{1,6})\s+(.*)$/;
// Words that make a section, a title or a line about customers.
const CUSTOMERISH = /(?<![\p{L}])(?:customers?|clients?|users?|leads?|prospects?|paying|subscribers?|accounts?|pilots?|buyers?|members?|venues?|caf[eé]s?|shops?|stores?|studios?|practices?|restaurants?|bakeries|salons?|clinics?|businesses|compan(?:y|ies)|organi[sz]ations?|testimonials?|case stud(?:y|ies)|organi[sz]ers?)(?![\p{L}])/iu;
// What a place is: a name that holds one of these is a place, however few words it has.
const PLACE = /^(?:caf[eé]s?|coffee|shop|store|hub|studio|bakery|restaurant|bar|bistro|clinic|salon|practice|garage|kitchen|workshop|werkstatt|gmbh|ltd|inc|llc|corp|ag|club|cent(?:er|re)|collective|co-?op|cooperative|library|school|gym|hotel|pharmacy|agency|market|gallery|haus|house|lab|labs|space|makerspace|stube|verein|association|foundation|repair|fix-it|fixit)$/i;
// Title-case words a label is made of: "Key Insights", "Next Steps", "Pain Points" name nothing.
const LABEL = new Set(`feedback notes note status organiser organizer owner contact contacts plan plans pricing price prices next steps step key
insight insights summary overview total totals paying customer customers client clients user users lead leads prospect prospects cafe cafes café
cafés repair repairs shop shops store stores hub club studio why what who how when where pain pains points point problem problems solution
solutions goal goals risk risks open questions question action actions item items details detail name names role location locations city area
size stage source fit score email phone website site date day week month year usage use uses current new active churned lost pending won
contacted interested booked meeting meetings call calls interview interviews quote quotes testimonial testimonials request requests ask asks
ideas idea learnings learning takeaways takeaway observations observation themes theme pattern patterns segment segments persona personas
profile profiles type types category categories volunteer volunteers visitor visitors organisers organizers team teams event events session
sessions booking bookings flow spec feature features product products numbers metrics revenue cost costs burn runway cash mrr traction market
competition competitors competitor channel channels pilot pilots trial trials survey surveys data reason reasons objections objection signal
signals summary top main other others general overall early first second third last recent monthly weekly why-not passed declined lost won
prospective potential target targets ideal profile icp jobs job tasks task outcome outcomes result results
the a an of and for with to in on by our their your my its this that these those at from`.split(/\s+/));
const CONNECTOR = /^(?:of|the|de|di|da|del|la|le|les|am|an|im|der|die|das|des|du|von|van|&|and|und|e|y)$/i;
// A person by their part in a customer's place: "Organiser: Sarah", "run by Jan Weber".
const ROLE = /\b(?:[Oo]rgani[sz]er|[Oo]wner|[Mm]anager|[Cc]ontact(?:\s+person)?|[Ff]ounder|[Cc]oordinator|[Hh]ost|[Rr]un by|[Ll]ed by|[Oo]wned by|[Mm]anaged by|[Oo]rgani[sz]ed by|[Hh]osted by)\s*:?\s+(\p{Lu}\p{Ll}+(?:[ -]\p{Lu}\p{Ll}+)?)\b/gu;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\*\*|__)?([^*_:\n—–(|]{2,70}?)(?:\*\*|__)?\s*(?::|—|–|\s-\s|\()/u;
// A name inside a sentence that holds a word for a place: "our first customer, Café Neukölln, ...".
const INLINE = /(?<![\p{L}])\p{Lu}[\p{L}'’-]*(?:\s+(?:(?:of|the|de|am|an|im|der|des|du|von|&)\s+)?\p{Lu}[\p{L}'’-]*)*/gu;

export type Named = { name: string; kind: 'place' | 'person'; line: number; end: number };

const words = (phrase: string) => phrase.trim().split(/\s+/).filter(Boolean);
const bare = (word: string) => word.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '');
// A phrase that names one place: every word capitalised (or a connector), not a label, and either two words or more,
// or a word for a place beside a word of its own ("Café Neukölln", "Prenzlauer Berg Fix-It", "Schöneberg Flick-Stube").
export function isName(phrase: string): boolean {
  const all = words(phrase).map(bare).filter(Boolean);
  if (!all.length || all.length > 6) return false;
  if (!all.every((word, index) => /^\p{Lu}/u.test(word) || /^\d/.test(word) || (index > 0 && CONNECTOR.test(word)))) return false;
  const own = all.filter((word) => !CONNECTOR.test(word) && !LABEL.has(word.toLowerCase()) && !word.split('-').every((part) => LABEL.has(part.toLowerCase())) && !/^\d/.test(word));
  if (!own.length) return false;
  return all.length >= 2 || all.some((word) => PLACE.test(word) || word.split('-').some((part) => PLACE.test(part)));
}

// The places and people a text presents as customers, with the line each stands on and where the name ends there.
// A line counts when the doc's title, a heading above it or the line itself is about customers.
export function namesIn(text: string, title = ''): Named[] {
  const found: Named[] = [];
  const headings: { level: number; text: string }[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      while (headings.length && headings.at(-1)!.level >= level) headings.pop();
      // A heading names a customer when what stands above it is about customers: "## Paying cafés" over "### Café Neukölln".
      const above = [title, ...headings.map((one) => one.text)].join(' ');
      const said = heading[2].replace(/[*_`]/g, '').replace(/\s*\(.*\)\s*$/, '').trim();
      if (level > 1 && CUSTOMERISH.test(above) && isName(said)) found.push({ name: said, kind: 'place', line: index, end: line.indexOf(said) + said.length });
      headings.push({ level, text: heading[2] });
      return;
    }
    if (/^\s*(?:>|```|\|)/.test(line)) return;
    const context = [title, ...headings.map((one) => one.text), line].join(' ');
    if (!CUSTOMERISH.test(context)) return;
    const taken: [number, number][] = [];
    const item = ITEM.exec(line);
    if (item) {
      const said = item[2].trim();
      if (isName(said)) {
        const at = line.indexOf(said);
        const end = /^\*\*|^__/.test(line.slice(at + said.length)) ? at + said.length + 2 : at + said.length;
        found.push({ name: said, kind: 'place', line: index, end });
        taken.push([at, at + said.length]);
      }
    }
    for (const hit of line.matchAll(INLINE)) {
      const said = hit[0].trim();
      const at = hit.index!;
      if (taken.some(([from, to]) => at < to && at + said.length > from)) continue;
      if (!words(said).some((word) => PLACE.test(bare(word)) || bare(word).split('-').some((part) => PLACE.test(part)))) continue;
      if (!isName(said) || words(said).length < 2) continue;
      // The first word of a sentence is capitalised anyway: "Repair Café Neukölln" stands, "Several Cafés" does not.
      found.push({ name: said, kind: 'place', line: index, end: at + said.length });
      taken.push([at, at + said.length]);
    }
    for (const hit of line.matchAll(ROLE)) {
      const said = hit[1];
      if (LABEL.has(said.toLowerCase())) continue;
      const at = hit.index! + hit[0].length - said.length;
      found.push({ name: said, kind: 'person', line: index, end: at + said.length });
    }
  });
  return found;
}

const fold = (text: string) => text.normalize('NFC').replace(/[*_`]/g, '').replace(/[’']/g, "'").replace(/\s+/g, ' ').toLowerCase();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// On record: a place by its whole name, a person by their first name, in something read, a Leads card row, the brief
// or the founder's words. A line that marked the name "(not on record)" is no record of it.
// A "/tool" line is a call typed out, not anyone's words: the doc's own text inside it names nothing.
export function onRecord(named: Pick<Named, 'name' | 'kind'>, sources: string[]): boolean {
  const text = fold(sources.filter((source) => !/^\/tool\s/.test(source.trim())).join('\n').split('\n').filter((line) => !/\(not on record\)/i.test(line)).join('\n'));
  const key = named.kind === 'person' ? named.name.split(/[ -]/)[0] : named.name;
  return new RegExp(`(?<![\\p{L}\\d])${escape(fold(key)).replace(/ /g, '\\s+')}(?![\\p{L}\\d])`, 'u').test(text);
}

// The names a text presents as customers that nothing on record names, once each. `before`: only the lines a write
// added are held to it; what was already there was held when it was written.
export function unrecordedNames(input: { after: string; before?: string; read: string[]; title?: string }): Named[] {
  const had = new Set((input.before ?? '').split('\n').map((line) => line.trim()));
  const lines = input.after.split('\n');
  // The doc's own lines, read back in the same turn, are no record of what they name.
  const own = new Set(lines.map((line) => line.replace(/\s*\(not on record\)/g, '').trim()).filter((line) => line.length > 20));
  const read = input.read.map((source) => source.split('\n').filter((line) => !own.has(line.replace(/\s*\(not on record\)/g, '').trim())).join('\n'));
  const seen = new Set<string>();
  return namesIn(input.after, input.title).filter((named) => {
    if (had.has(lines[named.line].trim())) return false;
    if (onRecord(named, read)) return false;
    const key = `${named.kind}:${named.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const NOT_ON_RECORD = '(not on record)';
// A plain doc keeps the writer's words, with "(not on record)" after each name nothing on record gives, once a line.
export function markNames(input: { after: string; before?: string; read: string[]; title?: string }): { text: string; marked: string[] } {
  const missing = unrecordedNames(input);
  const keys = new Set(missing.map((one) => `${one.kind}:${one.name.toLowerCase()}`));
  const had = new Set((input.before ?? '').split('\n').map((line) => line.trim()));
  const lines = input.after.split('\n');
  const all = namesIn(input.after, input.title).filter((named) => keys.has(`${named.kind}:${named.name.toLowerCase()}`) && !had.has(lines[named.line].trim()));
  for (const named of [...all].sort((a, b) => b.line - a.line || b.end - a.end)) {
    const line = lines[named.line];
    if (line.slice(named.end).startsWith(` ${NOT_ON_RECORD}`)) continue;
    lines[named.line] = `${line.slice(0, named.end)} ${NOT_ON_RECORD}${line.slice(named.end)}`;
  }
  return { text: lines.join('\n'), marked: missing.map((one) => one.name) };
}

// What a named customer said, wanted, liked or did, said of them in their block (the rest of their line and the lines
// under it): it needs their own words on record, a source that names them and shares a word of substance with it.
const SAYS = /\b(?:feedback|loves?|loved|likes?|liked|appreciat\w+|enjoy\w*|request\w*|asked|asks|wants?|wanted|wish(?:es|ed)?|said|says|told|complain\w*|prefer\w*|happy|unhappy|satisfied|dissatisfied|frustrat\w*|struggl\w*|prais\w+|uses|used|using|runs|ran|pays|paid|signed|renew\w*|cancel\w*|churn\w*|smooth|easy|praise)\b/i;
const DOUBT = /\b(?:no feedback|not on record|nothing on record|unknown|to find out|ask (?:them|her|him)|whether|if they)\b/i;
const STOP = new Set('the and for with from that this have has had been were was are they them their there what which when where who about into over just also very really only some than then your our each more most such much many other its his her you not but all any per can via yet now'.split(' '));
const substance = (text: string) => (text.toLowerCase().match(/[\p{L}][\p{L}'-]{3,}/gu) ?? []).filter((word) => !STOP.has(word) && !SAYS.test(word));
export type Unheard = { name: string; sentence: string };
export function unheardSayings(input: { after: string; before?: string; read: string[]; title?: string }): Unheard[] {
  const had = new Set((input.before ?? '').split('\n').map((line) => line.trim()));
  const lines = input.after.split('\n');
  const named = namesIn(input.after, input.title).filter((one) => one.kind === 'place' || !namesIn(lines[one.line]).some((other) => other.kind === 'place'));
  const out: Unheard[] = [];
  const firsts = new Map<number, Named>();
  for (const one of named) if (!firsts.has(one.line)) firsts.set(one.line, one);
  for (const [index, one] of firsts) {
    // The block: the rest of the line, and the lines under it that sit deeper or carry no mark of a new item.
    const indent = /^\s*/.exec(lines[index])![0].length;
    const block = [lines[index].slice(one.end)];
    const at = [index];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (!line.trim() || HEADING.test(line) || firsts.has(next)) break;
      if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line) && /^\s*/.exec(line)![0].length <= indent) break;
      block.push(line);
      at.push(next);
    }
    // Their own words: a source that names them (a lead's row holds what they wrote back and the notes on it).
    const theirs = input.read.filter((source) => onRecord(one, [source])).map((source) => new Set(substance(source)));
    block.forEach((text, place) => {
      if (had.has(lines[at[place]].trim())) return;
      for (const sentence of text.split(/(?<=[.!?])\s+/)) {
        const clean = sentence.replace(/[*_`]/g, '').trim();
        if (!clean || /\?\s*$/.test(clean) || DOUBT.test(clean) || !SAYS.test(clean)) continue;
        const words = substance(clean.replace(/^\s*(?:feedback|notes?)\s*:\s*/i, ''));
        if (theirs.some((source) => words.some((word) => source.has(word)))) continue;
        out.push({ name: one.name, sentence: clean.replace(/^[:\s—–-]+/, '') });
      }
    });
  }
  return out;
}

// What a reply or a review line says about the names: "Café Neukölln", "Kreuzberg Repair Hub" and 4 more.
export const listed = (names: string[], most = 3) => `${names.slice(0, most).map((one) => `"${one}"`).join(', ')}${names.length > most ? ` and ${names.length - most} more` : ''}`;

// Every lead on the stage's Leads cards as it stands on record: their row, the notes on it, what they wrote back.
export async function leadRecords(stage: Stage, workspace: string | null): Promise<string[]> {
  if (!workspace) return [];
  const lists = await Promise.all(leadsCardIds(stage).map((id) => leadsFor(workspace).list(id).catch(() => [])));
  return lists.flat().map((lead) => leadRecord(lead));
}
