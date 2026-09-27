// The line an empty chat opens with. The partner is asked about the company, whatever their title says; anyone else
// about their work, unless the work is only their own name again ("Ask Partner anything about partner.").
export function askLine(person: { name: string; role?: string; partner?: boolean }): string {
  const role = (person.role ?? '').trim();
  const about = person.partner ? 'the company' : role && role.toLowerCase() !== person.name.trim().toLowerCase() ? role.toLowerCase() : '';
  return about ? `Ask ${person.name} anything about ${about}.` : `Ask ${person.name} anything.`;
}
