// A page that did not load is no source. Journey 13: Tom read Samplely's site, got "Page Not Found", and still added
// Samplely as a lead "with team size in ICP range". A not-found or server-error page, an empty page, a bot wall and a
// read that failed outright all come back as a block of their own; that block is taken out of what a turn counts as
// read, and the address is kept, so a lead made from it can say the page was not reachable instead of why it fits.

import { safeHost } from '../../shared/sources.ts';

// A page that answers with an error instead of itself: by its title, or by a short body that says so.
// A bare code counts only at the start: "404 Not Found" is an error page, "How to fix a 404 page" is a page about one.
const NOT_FOUND = /^\W*(?:404|410|5\d\d)\b|\b(?:page not found|not found|internal server error|bad gateway|service unavailable|gateway time-?out|page (?:does not|doesn['’]t) exist|could not be found|no longer (?:exists|available))\b/i;
export const unreachable = (title: string, text: string) => NOT_FOUND.test(title) || (text.length < 1500 && NOT_FOUND.test(text.slice(0, 400)));
export const UNREACHED = 'This page was not reachable';
export const unreachedNote = (title: string) => `${UNREACHED}: it says "${title.replace(/\s+/g, ' ').trim().slice(0, 80) || 'not found'}". It backs nothing: say nothing about this page or its company from it, and find another source.`;

// The opening words of a block that read nothing: a failure, an error page, an empty page, a bot wall.
const FAILED = /^## ([^\n]*)\n(?:Failed: |This page was not reachable|This page came back almost empty|This site asked for a human check)/;
const BREAK = '\n\n---\n\n';

// A tool result with every block that read nothing taken out, the addresses of those, and the addresses that did load.
export function readsOf(result: string): { text: string; unreached: string[]; reached: string[] } {
  const unreached: string[] = [];
  const reached: string[] = [];
  const kept = result.split(BREAK).filter((block) => {
    const at = block.indexOf('## ');
    const failed = at >= 0 ? FAILED.exec(block.slice(at)) : null;
    if (failed) { unreached.push(failed[1].trim()); return false; }
    const page = at >= 0 ? /^## [^\n]*\n(https?:\/\/\S+)\n/.exec(block.slice(at)) : null;
    if (page) reached.push(page[1]);
    return true;
  });
  return { text: kept.join(BREAK), unreached, reached };
}

// The address read this turn that did not load and that a lead for `company` comes from: its site names the company
// or the reason names its site, and no page on that site loaded this turn.
export function unreachedFor(company: string, why: string, reads: { reached: string[]; unreached: string[] }): string | null {
  const name = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  const loaded = new Set(reads.reached.map((url) => safeHost(url)).filter(Boolean));
  for (const url of reads.unreached) {
    const host = safeHost(url);
    if (!host || loaded.has(host)) continue;
    const label = host.replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/g, '');
    const named = name.length >= 3 && label.length >= 3 && (label.includes(name) || name.includes(label));
    if (named || why.toLowerCase().includes(host.replace(/^www\./, ''))) return url;
  }
  return null;
}
