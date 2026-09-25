// A spreadsheet of contacts, read into leads. Founders arrive with one: exported from LinkedIn, a CRM, a sheet they
// kept by hand. Its columns are called whatever that tool called them, so each column is recognised by its header
// among the names people give it, and a row becomes a lead only with a person's name and a company. The same reading
// runs in the window, to say what will happen before anything does, and on the server, which does it.

export const MOST_ROWS = 1000;
export const MOST_CHARS = 1_000_000;

export type Field = 'name' | 'first' | 'last' | 'company' | 'email' | 'linkedin' | 'title' | 'site' | 'size' | 'note';
export type ImportRow = { row: number; name: string; company: string; email?: string; linkedin?: string; title?: string; site?: string; size?: string; note?: string };
export type Skipped = { row: number; why: string };
export type Read = { rows: ImportRow[]; skipped: Skipped[]; columns: Partial<Record<Field, string>>; problem?: string };
// What the server says once it has added them. `already`: somebody at that company by that name was on the card, or
// earlier in the same paste.
export type Imported = { added: number; already: number; skipped: Skipped[] };

// Header names, squeezed to letters and digits, for each field. Our own "Copy as CSV" columns are among them, so an
// exported list comes back in as it went out.
const NAMES: Record<Field, string[]> = {
  name: ['name', 'fullname', 'contact', 'contactname', 'person', 'personname', 'lead', 'leadname'],
  first: ['firstname', 'first', 'givenname', 'forename'],
  last: ['lastname', 'last', 'surname', 'familyname'],
  company: ['company', 'companyname', 'organization', 'organisation', 'org', 'account', 'accountname', 'employer', 'business', 'currentcompany'],
  email: ['email', 'emailaddress', 'workemail', 'mail', 'businessemail', 'emails'],
  linkedin: ['linkedin', 'linkedinurl', 'linkedinprofile', 'linkedinprofileurl', 'profileurl', 'liurl', 'linkedinlink'],
  title: ['title', 'jobtitle', 'position', 'role', 'headline', 'currentposition'],
  site: ['website', 'site', 'companywebsite', 'domain', 'companydomain', 'web'],
  size: ['size', 'companysize', 'employees', 'headcount'],
  note: ['note', 'notes', 'why', 'comment', 'comments'],
};
const squeeze = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Addresses anybody can have. A work address names the company; one of these names only the mail service.
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'mail.com', 'yandex.com', 'zoho.com', 'hey.com', 'fastmail.com']);

// Comma, semicolon or tab: whichever the first line has most of, outside quotes. A spreadsheet copied to the
// clipboard is tabs; a European CSV is often semicolons.
export function delimiterOf(text: string): string {
  const first = text.split(/\r?\n/).find((line) => line.trim()) ?? '';
  const outside = first.replace(/"[^"]*"/g, '');
  const most = [',', ';', '\t'].map((mark) => ({ mark, many: outside.split(mark).length - 1 })).sort((a, b) => b.many - a.many)[0];
  return most.many ? most.mark : ',';
}

// CSV as spreadsheets write it: quoted fields may hold the delimiter, line breaks and doubled quotes.
export function parseCsv(text: string, mark = delimiterOf(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at];
    if (quoted) {
      if (char === '"' && body[at + 1] === '"') { cell += '"'; at += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && !cell.trim()) { quoted = true; cell = ''; }
    else if (char === mark) { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[at + 1] === '\n') at += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((one) => one.map((value) => value.trim())).filter((one) => one.some(Boolean));
}

// Which column is which, from the header row. The first column to answer to a field keeps it.
export function mapColumns(header: string[]): Partial<Record<Field, number>> {
  const found: Partial<Record<Field, number>> = {};
  header.forEach((title, index) => {
    const key = squeeze(title);
    for (const field of Object.keys(NAMES) as Field[]) if (found[field] === undefined && NAMES[field].includes(key)) { found[field] = index; return; }
    // "LinkedIn Profile Link", "E-mail (work)": a header that says it plainly enough.
    if (found.linkedin === undefined && key.includes('linkedin')) found.linkedin = index;
    else if (found.email === undefined && /e?mail/.test(key) && !key.includes('linkedin')) found.email = index;
  });
  return found;
}

// A company in words from a work address: jane@acme-labs.io is Acme Labs. Nothing from an address anybody can have.
export function companyFromEmail(email: string): string {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (!domain || FREE_MAIL.has(domain)) return '';
  const label = domain.split('.').filter((part) => !['www', 'mail', 'email'].includes(part))[0] ?? '';
  return label.split(/[-_]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

const linkOf = (value: string) => {
  const trimmed = value.trim();
  if (!/linkedin\.com\//i.test(trimmed)) return undefined;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, '')}`;
};
const siteOf = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed) || !trimmed.includes('.')) return undefined;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

// The whole paste, read: the rows that will become leads, the rows that will not and why, and which header was
// taken for which field. Row numbers are the spreadsheet's own, the header being row 1.
export function readLeads(text: string): Read {
  if (text.length > MOST_CHARS) return { rows: [], skipped: [], columns: {}, problem: 'That is more than a list of contacts should be. Split it into files under 1 MB.' };
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], skipped: [], columns: {}, problem: table.length ? 'There is a header but no rows under it.' : '' };
  const [header, ...body] = table;
  const at = mapColumns(header);
  const columns = Object.fromEntries(Object.entries(at).map(([field, index]) => [field, header[index!]])) as Partial<Record<Field, string>>;
  if (at.name === undefined && at.first === undefined) {
    return { rows: [], skipped: [], columns, problem: 'No column for names. The first row should name the columns, like: Name, Company, Email, LinkedIn.' };
  }
  if (body.length > MOST_ROWS) return { rows: [], skipped: [], columns, problem: `That is ${body.length.toLocaleString()} rows. Import up to ${MOST_ROWS.toLocaleString()} at a time.` };
  const cell = (row: string[], field: Field) => (at[field] === undefined ? '' : row[at[field]!] ?? '').replace(/\s+/g, ' ').trim();

  const rows: ImportRow[] = [];
  const skipped: Skipped[] = [];
  body.forEach((row, index) => {
    const number = index + 2;
    const name = cell(row, 'name') || [cell(row, 'first'), cell(row, 'last')].filter(Boolean).join(' ');
    const typed = cell(row, 'email');
    const email = EMAIL.test(typed) ? typed : undefined;
    const company = cell(row, 'company') || (email ? companyFromEmail(email) : '');
    if (!name) { skipped.push({ row: number, why: 'no name' }); return; }
    if (!company) { skipped.push({ row: number, why: 'no company' }); return; }
    const lead: ImportRow = { row: number, name: name.slice(0, 120), company: company.slice(0, 120) };
    const linkedin = linkOf(cell(row, 'linkedin'));
    const site = siteOf(cell(row, 'site'));
    const title = cell(row, 'title');
    const size = cell(row, 'size');
    const note = cell(row, 'note');
    if (email) lead.email = email;
    if (linkedin) lead.linkedin = linkedin;
    if (title) lead.title = title;
    if (site) lead.site = site;
    if (size) lead.size = size;
    if (note) lead.note = note;
    rows.push(lead);
  });
  return { rows, skipped, columns };
}

// What the founder is told once it is done, in one line.
export function importedLine(done: Imported): string {
  const parts = [`Added ${done.added} ${done.added === 1 ? 'lead' : 'leads'}`];
  if (done.already) parts.push(`${done.already} already here`);
  if (done.skipped.length) {
    const shown = done.skipped.slice(0, 3).map((one) => `row ${one.row}: ${one.why}`).join(', ');
    parts.push(`${done.skipped.length} skipped (${shown}${done.skipped.length > 3 ? ', …' : ''})`);
  }
  return `${parts.join(', ')}.`;
}
