// A draft the founder sends themselves: a Gmail compose link that opens with the fields filled, and a mailto: link for
// any other mail program. Built the same way on the server (the tool, Needs you) and in the window (the chat's
// button), so both point at the same draft and the same Needs you entry.

// A Gmail compose link stops working somewhere past 2,000 characters; the body is cut well before that.
export const DRAFT_BODY_MOST = 1800;
export type Draft = { to: string; subject: string; body: string };

// The body as the link carries it, and whether anything was left out.
export function draftBody(body: string): { body: string; cut: boolean } {
  return body.length > DRAFT_BODY_MOST ? { body: body.slice(0, DRAFT_BODY_MOST), cut: true } : { body, cut: false };
}

// The addresses as Gmail wants them: comma-separated with no spaces.
const addresses = (to: string) => to.split(/[,;\s]+/).filter(Boolean).join(',');

export function gmailLink(draft: Draft): string {
  const params = [['view', 'cm'], ['fs', '1'], ['to', addresses(draft.to)], ['su', draft.subject], ['body', draftBody(draft.body).body]];
  return `https://mail.google.com/mail/?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

export function mailtoLink(draft: Draft): string {
  return `mailto:${addresses(draft.to).split(',').map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draftBody(draft.body).body)}`;
}

// The Needs you entry for one draft: the same words drafted twice are one entry, and the window can name it from the
// step's own arguments to clear it when the founder opens the draft.
export function draftId(draft: Draft): string {
  let hash = 5381;
  for (const char of `${draft.to}\n${draft.subject}\n${draft.body}`) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
  return `mail-draft:${hash.toString(36)}`;
}

// The step's arguments as a draft, when they are one.
export function draftOf(args: Record<string, unknown>): Draft | null {
  const { to, subject, body } = args;
  return typeof to === 'string' && typeof subject === 'string' && typeof body === 'string' ? { to, subject, body } : null;
}
