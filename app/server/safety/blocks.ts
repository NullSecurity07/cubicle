import { webUrl } from '../browser.ts';
import { findKey } from './keys.ts';

// What nothing gets past. Every rule here is a plain function over one argument of one call, asked before the founder
// is asked anything, and a rule that fires ends the step: there is no yes for these.
export type Where = { tool: string; key: string };
export type Rule = { id: string; says: string; hits(value: string, where: Where, own: string[]): boolean };

// Tools whose arguments leave this machine one way or another. A key may not travel in one of these.
const OUTWARD = new Set(['send_email', 'draft_email', 'web_search', 'web_fetch', 'browse', 'code_task', 'code_reply', 'read_youtube', 'read_feed', 'read_reddit', 'crawl_site', 'watch_page']);
// Where a path or a command can really be acted on. A question typed at a search engine is words, not a file.
const FILE_TOOLS = new Set(['run_code', 'code_task', 'code_reply', 'write_file', 'read_file']);
const CODER = new Set(['code_task', 'code_reply']);
const FILE_KEYS = new Set(['code', 'task', 'brief', 'path', 'file', 'command', 'url']);
const touchesFiles = (where: Where) => FILE_TOOLS.has(where.tool) || FILE_KEYS.has(where.key);

// `rm -rf /`, `~`, `$HOME`, or a top-level folder of the system. `rm -rf ./build` is somebody's build folder and passes.
const WIPE = /\b(?:rm|unlink)\s+(?:-{1,2}[\w-]+\s+)*(?:-{1,2}[\w-]*[rR][\w-]*)\s+(?:-{1,2}[\w-]+\s+)*(\S+)/g;
const WIPED = /^(?:\/|~|\$HOME|\$\{HOME\}|\/(?:bin|boot|dev|etc|home|lib|lib64|opt|root|sbin|srv|sys|usr|var)|~\/Documents|~\/Desktop)\/?\*?$/;
// The classic fork bomb, with or without the spaces, and the shell loop that does the same thing by hand.
const FORK = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:?\s*&\s*\}\s*;\s*:|while\s+(?:true|:)\s*;?\s*do\s+.{0,40}&\s*done/;
// Anything fetched from the web and handed straight to a shell.
const PIPE_TO_SHELL = /\b(?:curl|wget|fetch|iwr|Invoke-WebRequest)\b[^|\n]{0,300}\|\s*(?:sudo\s+|env\s+)?(?:\/\w+\/)*(?:ba|z|k|da|fi)?sh\b/i;
// The founder's own keys and clouds, and any .env file anywhere. `.env.example` is a template and passes.
const PRIVATE_FILES = /(?:^|[\s"'`(=:;&|])(?:~|\$HOME|\$\{HOME\}|\/home\/[^/\s"']+|\/root|\/Users\/[^/\s"']+)\/\.(?:ssh|aws|kube|gnupg|docker|config\/gcloud)\b|(?:^|[\s"'`(=:;&|])(?:[\w.~$/-]*\/)?\.env(?![\w.-])/;
// Letters that are not what they look like: invisible marks, writing direction switches, and the Cyrillic, Greek and
// full-width shapes that stand in for Latin ones in an address.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
const LOOKALIKE = /[\u0370-\u03FF\u0400-\u04FF\u0500-\u052F\u2010-\u2015\u2212\uFF01-\uFF5E]/;

// A web address as it sits in a line of prose or a line of code. Square brackets stay in, because an address written
// the IPv6 way is nothing but brackets; what trails off the end of a sentence is trimmed instead.
const URLS = /\bhttps?:\/\/[^\s"'`<>{}|\\^]+/gi;
// Where an address really names somewhere: the part after @ in a mailbox, and the authority of a web address. Read
// out of the raw text rather than out of a parsed address, because parsing quietly tidies away the invisible marks
// this is looking for. The path is left out: a Cyrillic word in a link to an article is nobody's trick.
const WHERE_IT_GOES = /[^\s,;<>()"'`]+@([^\s,;<>()"'`]+)|https?:\/\/([^\s/,;<>()"'`]+)/gi;
const named = (value: string) => [...value.matchAll(WHERE_IT_GOES)].map((found) => found[1] ?? found[2]).filter(Boolean);
// The addresses a machine's own secrets are asked for on. These are never a mistake, wherever they turn up.
const METADATA = new Set(['169.254.169.254', '100.100.100.200', '192.0.0.192', 'metadata.google.internal', 'metadata.goog', 'metadata', '[fd00:ec2::254]', 'fd00:ec2::254']);

const number = (part: string): number | null => {
  const clean = part.trim();
  if (/^0[xX][0-9a-fA-F]+$/.test(clean)) return Number.parseInt(clean, 16);
  if (/^0[0-7]+$/.test(clean)) return Number.parseInt(clean, 8);
  if (/^\d+$/.test(clean)) return Number.parseInt(clean, 10);
  return null;
};

// An address as a number, whichever of the four ways it was written in (1.2.3.4, 0x7f000001, 2130706433, 0177.0.0.1).
// `webUrl` in the browser already refuses the plain dotted forms; these are the ways round it.
export function asAddress(host: string): number | null {
  const parts = host.split('.');
  if (parts.length > 4 || parts.some((part) => !part)) return null;
  const values = parts.map(number);
  if (values.some((value) => value === null || value < 0)) return null;
  const numbers = values as number[];
  const last = numbers[numbers.length - 1];
  if (numbers.slice(0, -1).some((value) => value > 255) || last >= 2 ** (8 * (5 - numbers.length))) return null;
  return numbers.slice(0, -1).reduce((total, value, at) => total + value * 2 ** (8 * (3 - at)), last);
}

const ownNetwork = (address: number): boolean => {
  const [a, b] = [address >>> 24, (address >>> 16) & 255];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && b >= 18 && b < 20) || address === -1 >>> 0;
};
// The four-byte tail of an address written the long way (`::ffff:127.0.0.1`) or the short way (`::ffff:7f00:1`).
const mappedTail = (tail: string): number | null => {
  if (tail.includes('.')) return asAddress(tail);
  const groups = tail.split(':').filter(Boolean);
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return (Number.parseInt(groups[0], 16) * 65_536 + Number.parseInt(groups[1], 16)) >>> 0;
};

// This machine, its own network, or the address a cloud keeps its machine's credentials on.
export function privateHost(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (METADATA.has(host)) return true;
  if (host === 'localhost' || /\.(?:localhost|local|internal|home\.arpa)$/.test(host)) return true;
  if (host.includes(':')) {
    if (host === '::' || host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
    const tail = host.startsWith('::ffff:') ? mappedTail(host.slice(7)) : null;
    return tail !== null && ownNetwork(tail);
  }
  const address = asAddress(host);
  return address !== null && ownNetwork(address);
}

const hosts = (value: string) => [...value.matchAll(URLS)].flatMap((found) => { try { return [new URL(found[0].replace(/[).,;]+$/, '')).hostname]; } catch { return []; } });
// The tools that open the web already refuse this machine and its network, and say so in their own words. Asking the
// very same function is how this stays out of their way instead of answering the same call twice, differently.
const WEB_TOOLS = new Set(['browse', 'web_fetch', 'web_search', 'read_youtube', 'read_feed', 'read_reddit', 'crawl_site', 'watch_page']);
const refusedAlready = (host: string) => { try { webUrl(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}/`); return false; } catch { return true; } };

export const RULES: Rule[] = [
  {
    id: 'wipe',
    says: 'This step was stopped: it would have erased a whole disk or home folder.',
    // What the command was aimed at, without the quotes and brackets the rest of a line of code wraps it in.
    hits: (value) => [...value.matchAll(WIPE)].some((found) => WIPED.test(found[1].replace(/^["'`]+/, '').replace(/["'`);,&|]+$/, ''))),
  },
  {
    id: 'fork-bomb',
    says: 'This step was stopped: it would have gone on copying itself until the machine froze.',
    hits: (value) => FORK.test(value),
  },
  {
    id: 'pipe-to-shell',
    says: 'This step was stopped: it would have run a script fetched from the web without anybody reading it first.',
    hits: (value) => PIPE_TO_SHELL.test(value),
  },
  {
    id: 'private-files',
    says: 'This step was stopped: it reaches into the keys and passwords kept on this machine.',
    hits: (value, where) => touchesFiles(where) && PRIVATE_FILES.test(value),
  },
  {
    id: 'look-alike',
    says: 'This step was stopped: that address is written with hidden or look-alike letters, so it is not the address it appears to be.',
    hits: (value) => named(value).some((part) => INVISIBLE.test(part) || LOOKALIKE.test(part)),
  },
  {
    id: 'own-network',
    says: 'This step was stopped: that address belongs to this machine or its own network, not the open web.',
    // A coding agent works on the founder's machine, where a dev server on localhost is the whole point; what it may
    // never reach is the address a cloud hands out its machine's credentials on. The web tools already turn these
    // away themselves, in their own words, so here they are only held to the ways round that check: an address
    // written as a number, a mapped one, or a name a cloud keeps its secrets behind.
    hits: (value, where) => hosts(value).some((host) => {
      if (CODER.has(where.tool)) return METADATA.has(host.toLowerCase());
      if (!privateHost(host)) return false;
      return !WEB_TOOLS.has(where.tool) || !refusedAlready(host);
    }),
  },
  {
    id: 'key-leaving',
    says: 'This step was stopped: it was about to send one of this machine\'s keys out.',
    hits: (value, where, own) => OUTWARD.has(where.tool) && findKey(value, own) !== null,
  },
];

const strings = (args: Record<string, unknown>): [string, string][] => Object.entries(args).flatMap(([key, value]) => {
  if (typeof value === 'string') return [[key, value] as [string, string]];
  if (Array.isArray(value)) return value.filter((one) => typeof one === 'string').map((one) => [key, one as string] as [string, string]);
  if (value && typeof value === 'object') return Object.values(value).filter((one) => typeof one === 'string').map((one) => [key, one as string] as [string, string]);
  return [];
});

// The one question the turn asks of all of it: is there anything in this call that must not happen? The sentence that
// comes back is what the person reads as the result and the founder reads on the receipt.
export function checkCall(tool: string, args: Record<string, unknown>, own: string[] = []): string | null {
  for (const [key, value] of strings(args)) {
    for (const rule of RULES) {
      try { if (rule.hits(value, { tool, key }, own)) return rule.says; } catch { /* a rule that cannot answer is not a yes for the others */ }
    }
  }
  return null;
}
