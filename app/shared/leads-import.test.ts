import { describe, expect, it } from 'vitest';
import { leadsCsv, type Lead } from './leads.ts';
import { companyFromEmail, delimiterOf, importedLine, mapColumns, MOST_ROWS, parseCsv, readLeads } from './leads-import.ts';

describe('reading a spreadsheet', () => {
  it('reads quoted fields with commas, doubled quotes and line breaks in them', () => {
    expect(parseCsv('a,b,c\n"Smith, Jo","say ""hi""","two\nlines"\n')).toEqual([['a', 'b', 'c'], ['Smith, Jo', 'say "hi"', 'two\nlines']]);
  });

  it('takes tabs from a spreadsheet copied to the clipboard and semicolons from a European CSV', () => {
    expect(delimiterOf('Name\tCompany\nJo\tAcme')).toBe('\t');
    expect(delimiterOf('Name;Company;"a,b"\nJo;Acme;x')).toBe(';');
    expect(delimiterOf('Name')).toBe(',');
    expect(parseCsv('﻿Name;Company\r\nJo;Acme\r\n\r\n')).toEqual([['Name', 'Company'], ['Jo', 'Acme']]);
  });

  it('knows a column by the names tools give it', () => {
    expect(mapColumns(['Full Name', 'Organisation', 'E-mail', 'LinkedIn Profile URL', 'Job Title'])).toEqual({ name: 0, company: 1, email: 2, linkedin: 3, title: 4 });
    expect(mapColumns(['First Name', 'Last Name', 'Account Name', 'Work Email (primary)', 'Person LinkedIn Link'])).toEqual({ first: 0, last: 1, company: 2, email: 3, linkedin: 4 });
  });
});

describe('a paste, read into leads', () => {
  it('maps name, company, email and LinkedIn, and joins first and last names', () => {
    const read = readLeads('First name,Last name,Company,Email,LinkedIn\nAda,Lovelace,Analytical,ada@analytical.io,linkedin.com/in/ada\n');
    expect(read.problem).toBeUndefined();
    expect(read.rows).toEqual([{ row: 2, name: 'Ada Lovelace', company: 'Analytical', email: 'ada@analytical.io', linkedin: 'https://linkedin.com/in/ada' }]);
    expect(read.columns).toEqual({ first: 'First name', last: 'Last name', company: 'Company', email: 'Email', linkedin: 'LinkedIn' });
  });

  it('takes the company from a work address, never from one anybody can have', () => {
    expect(companyFromEmail('jane@acme-labs.io')).toBe('Acme Labs');
    expect(companyFromEmail('jane@gmail.com')).toBe('');
    const read = readLeads('Name,Email\nJane,jane@acme-labs.io\nJoe,joe@gmail.com\n,x@y.com\n');
    expect(read.rows.map((row) => row.company)).toEqual(['Acme Labs']);
    expect(read.skipped).toEqual([{ row: 3, why: 'no company' }, { row: 4, why: 'no name' }]);
  });

  it('keeps a lead whose email is not an address, without the email', () => {
    expect(readLeads('Name,Company,Email\nJo,Acme,not an email\n').rows).toEqual([{ row: 2, name: 'Jo', company: 'Acme' }]);
  });

  it('says what is wrong when there is no name column, no rows, or far too many', () => {
    expect(readLeads('Company,Email\nAcme,a@acme.com\n').problem).toMatch(/No column for names/);
    expect(readLeads('Name,Company\n').problem).toMatch(/no rows/);
    expect(readLeads('').problem).toBe('');
    expect(readLeads(`Name,Company\n${'Jo,Acme\n'.repeat(MOST_ROWS + 1)}`).problem).toMatch(/up to 1,000/);
  });

  it('reads back what Copy as CSV wrote', () => {
    const lead: Lead = { id: 'lead-1', person: { name: 'Ada', title: 'CTO', email: 'ada@x.io', linkedin: 'https://www.linkedin.com/in/ada' }, company: { name: 'X', site: 'https://x.io', size: '11-50' }, stage: 'fit', notes: [], source: 'founder', addedAt: 0, updatedAt: 0 };
    expect(readLeads(leadsCsv([lead])).rows).toEqual([{ row: 2, name: 'Ada', company: 'X', email: 'ada@x.io', linkedin: 'https://www.linkedin.com/in/ada', title: 'CTO', site: 'https://x.io', size: '11-50' }]);
  });

  it('says how it went in one line', () => {
    expect(importedLine({ added: 1, already: 0, skipped: [] })).toBe('Added 1 lead.');
    expect(importedLine({ added: 3, already: 2, skipped: [{ row: 4, why: 'no company' }] })).toBe('Added 3 leads, 2 already here, 1 skipped (row 4: no company).');
  });
});
