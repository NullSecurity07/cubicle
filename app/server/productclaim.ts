// What the product does, as said to a lead or the founder, is a claim the record has to make. Journey 18: Tom asked
// "Does it work with photos from my old Android phone? And can the quote show VAT separately?" and the partner's
// ready reply said "Yes, QuoteSnap works seamlessly with photos from any Android phone ... And yes, your quotes can
// show VAT separately"; nothing on record said either. The guard on unasked outputs took out figures only. After the
// founder's no, the partner said it would rewrite the email "focusing only on what QuoteSnap currently does (turning
// WhatsApp photos into quotes instantly from iOS/web)", and iOS and web were made up too. A sentence that says what
// the product works with, runs on, supports, integrates with, complies with or how it prices and taxes is a product
// claim: it stands only when a stated sentence on record (the brief's product facts, a read, the founder's words)
// names the same thing, and not as a question, a doubt or a no.

// One kind of product claim: what in a sentence makes it one, and the word a source has to name to back it. A
// `stated` kind is a claim said either way ("non-refundable", "no app needed"): a no in its clause does not make it
// none, and a source backs it whether it says yes or no. A `policy` kind is asked about as itself: "I will check our
// refund policy", never "whether they get the €4 back".
type Kind = { pattern: RegExp; key: (hit: RegExpExecArray) => string | null; about: (hit: RegExpExecArray) => string; stated?: true; policy?: true };

const PLATFORMS: Record<string, string> = {
  ios: 'iOS', iphone: 'iPhone', ipad: 'iPad', android: 'Android', windows: 'Windows', macos: 'macOS', mac: 'Mac', linux: 'Linux',
  web: 'the web', browser: 'the browser', desktop: 'desktop', 'web app': 'the web', 'web-app': 'the web',
};
// Words before a platform that make it a claim about the product: "works on", "from iOS", "available for Android".
const CLAIM_VERB = /\b(?:works?|working|runs?|running|available|supports?|supported|compatible|integrat\w*|syncs?|connects?|exports?|imports?|install\w*|download\w*|built|handles?|shows?|offers?|includes?|does|can|lets?|allows?|via|from|on|for)\b/i;
const STRONG_VERB = /\b(?:works?|working|runs?|running|available|supports?|supported|compatible|install\w*|download\w*|built for)\b/i;
const KINDS_PLATFORM = /^(?:iOS|iPhones?|iPads?|Android|Windows|macOS|Linux|Web|Browsers?|Desktop)\b/i;
// A platform: "from any Android phone", "on iOS/web", "available for Windows".
const PLATFORM_KIND: Kind = {
  pattern: /\b(iOS|iPhones?|iPads?|Android|Windows|macOS|Linux|web[- ]app|(?:the\s+)?web|browsers?|desktop)\b/i,
  key: (hit) => hit[1].toLowerCase().replace(/^the\s+/, '').replace(/s$/, '').replace(/^web[- ]app$/, 'web'),
  about: (hit) => PLATFORMS[hit[1].toLowerCase().replace(/^the\s+/, '').replace(/s$/, '')] ?? hit[1],
};
// Journey 20: Sam's ready reply to Ines said "FixSlot is web-based and works on any phone or tablet browser so
// volunteers can view the list without downloading an app" and "If a visitor cancels, the €4 booking fee is
// non-refundable." Nothing on record said either: the brief says only that visitors book a slot online. A refund,
// cancellation or fee policy, "web-based", "any browser", "no app needed" and a store it is "available on" are claims
// like a platform is.
const KINDS: Kind[] = [
  PLATFORM_KIND,
  // Where it runs, said without a verb: "web-based", "in any browser".
  {
    pattern: /\b(web[- ]based|browser[- ]based|(?:in|on|from|through|with)\s+(?:any|every|your|a|the)\s+(?:(?:phone|tablet|mobile|web|modern)\s+(?:or\s+(?:tablet|phone|desktop)\s+)?)?browsers?)\b/i,
    key: (hit) => (/^web/i.test(hit[1]) ? 'web' : 'browser'),
    about: (hit) => (/^web/i.test(hit[1]) ? 'the web' : 'the browser'),
  },
  // No app to install: a claim however it is said.
  {
    pattern: /\b(no\s+(?:need\s+(?:for|to\s+(?:install|download))\s+(?:an?\s+)?)?(?:app|download|installation|install)s?(?:\s+(?:needed|required|to\s+(?:install|download)))?|without\s+(?:(?:having\s+to\s+)?(?:installing|downloading|install|download)\s+(?:an?\s+|any\s+)?(?:app|anything)|an?\s+app)|nothing\s+to\s+(?:install|download))\b/i,
    key: () => 'app',
    about: () => 'no app needed',
    stated: true,
  },
  // A store it is available on: "available on the App Store", "on Google Play".
  {
    pattern: /\b(App Store|Play Store|Google Play|Microsoft Store|Chrome Web Store)\b/i,
    key: (hit) => hit[1].toLowerCase(),
    about: (hit) => hit[1],
  },
  // A refund, cancellation or fee policy: "non-refundable", "full refund", "cancel for free", "get the €4 back".
  {
    pattern: /\b((?:non[- ]?)?refund(?:s|ed|able|ing)?|money[- ]back|cancell?ation\s+(?:policy|polic(?:y|ies)|fees?|charges?|terms|window|period)|free\s+cancell?ation|cancel\w*\s+(?:for\s+free|free\s+of\s+charge|at\s+no\s+(?:cost|charge)|up\s+to\s+\d+)|no[- ]show\s+(?:fees?|charges?|policy)|late\s+(?:fees?|charges?)|get\s+(?:the(?:ir)?|your|his|her|it|a|all|my|our)?\s*(?:[€$£]\s?\d+(?:[.,]\d+)?\s*|\d+(?:[.,]\d+)?\s*(?:euros?|dollars?|pounds?)\s*)?(?:money\s+|fee\s+)?back)\b/i,
    key: (hit) => (/cancel/i.test(hit[1]) ? 'cancel' : /no[- ]show/i.test(hit[1]) ? 'no-show' : /late/i.test(hit[1]) ? 'late fee' : 'refund'),
    about: (hit) => (/cancel/i.test(hit[1]) ? 'our cancellation policy' : /no[- ]show|late/i.test(hit[1]) ? 'our fees' : 'our refund policy'),
    stated: true,
    policy: true,
  },
  // Pricing terms: "free trial", "billed annually", "pay as you go", "a one-off fee".
  {
    pattern: /\b(free\s+(?:trial|plan|tier)|freemium|billed\s+(?:monthly|annually|yearly|weekly|per\s+\w+)|(?:annual|yearly)\s+(?:plan|billing|discount|subscription)|pay[- ]as[- ]you[- ]go|one[- ]off\s+(?:fee|payment|charge)|lifetime\s+(?:deal|access|licen[cs]e)|no\s+commitment|price\s+(?:lock|guarantee)|volume\s+discount)\b/i,
    key: (hit) => hit[1].toLowerCase().replace(/\s+/g, ' ').replace(/^billed .*$/, 'billed').replace(/^(?:annual|yearly) .*$/, 'annual'),
    about: (hit) => hit[1].toLowerCase().replace(/\s+/g, ' '),
    stated: true,
    policy: true,
  },
  // Works offline.
  { pattern: /\boffline\b/i, key: () => 'offline', about: () => 'offline use' },
  // Tax and compliance: "VAT charged separately", "GDPR compliant", "HIPAA".
  {
    pattern: /\b(VAT|sales tax|GDPR|HIPAA|SOC ?2|ISO ?27001|PCI(?:[- ]DSS)?|(?:fully\s+)?complian(?:t|ce))\b/i,
    key: (hit) => hit[1].toLowerCase().replace(/^fully\s+/, '').replace(/^complian\w+$/, 'complian').replace(/\s+/g, ' '),
    about: (hit) => (/complian/i.test(hit[1]) ? 'compliance' : hit[1].toUpperCase() === hit[1] ? hit[1] : hit[1].toLowerCase()),
  },
  // Terms of sale: "cancel any time", "no contract", "no setup fee", "per seat".
  {
    pattern: /\b(cancel any ?time|no (?:long[- ]term )?contracts?|no (?:setup|set-up|hidden) fees?|per (?:seat|user)|tax(?:es)? included|price includes)\b/i,
    key: (hit) => hit[1].toLowerCase().split(/\s+/).at(-1)!.replace(/s$/, '').replace(/^any ?time$/, 'cancel'),
    about: (hit) => hit[1].toLowerCase(),
  },
  // An integration with something named: "integrates with Xero", "syncs with Google Calendar", "works with WhatsApp".
  {
    pattern: /\b(?:integrat\w*|syncs?|synced|connects?|connected|compatible|exports?|imports?|plugs? into|works?|working)\s+(?:seamlessly\s+|directly\s+|natively\s+|fully\s+)?(?:with|to|into|from)\s+(?:[\p{Ll}]+\s+){0,3}?(\p{Lu}[\p{L}\d]+(?:\s+\p{Lu}[\p{L}\d]+)?)/u,
    key: (hit) => (/^(?:I|We|You|It|The|Yes|No)$/.test(hit[1]) || KINDS_PLATFORM.test(hit[1]) ? null : hit[1].toLowerCase()),
    about: (hit) => `working with ${hit[1]}`,
  },
];

// A clause that says no, doubts or is still to find out: "we have not tested old Android phones", "I will check
// whether it works on Android", "Tom asked about VAT".
const DENIED = /\b(?:no|not|never|cannot|can't|can’t|won't|won’t|don't|don’t|doesn't|doesn’t|isn't|isn’t|aren't|aren’t|unable|untested|yet to|without)\b/i;
const LEARNING = /\b(?:check|find out|ask|asks|asked|asking|confirm|look into|see (?:if|whether)|whether|if|let you know|come back to you|get back to you|wonder\w*|questions?)\b/i;
const QUESTION = /\?\s*["”')]*\s*$/;
// Journey 19: "Regarding your old Android phone and VAT separately: I will check on those details and come back to
// you." was refused as a claim about VAT. A sentence that says the answer is still to come ("I will check", "let me
// confirm", "I don't know yet") asserts nothing about what it names, unless a clause of its own says the product does it.
const HONEST = /\b(?:(?:I|we)(?:'ll|’ll|\s+will|\s+shall|\s+need\s+to|\s+have\s+to|\s+want\s+to)\s+(?:double[- ])?(?:check|confirm|find\s+out|look\s+into|ask|verify|come\s+back|get\s+back)|let\s+me\s+(?:check|confirm|find\s+out|look\s+into|verify|ask)|(?:I|we)\s+(?:don't|don’t|do\s+not)\s+know(?:\s+yet)?|not\s+sure\s+yet|to\s+be\s+confirmed)\b/i;
const ASSERTS = /\b(?:works?|runs?|is|are|was|were|supports?|supported|available|compatible|integrates?|syncs?|connects?|exports?|imports?|handles?|shows?|offers?|includes?|does|do|can|could|will|lets?|allows?|has|have|comes?|charges?|adds?)\b/i;
// The clause around a hit: a "no" in another clause of the sentence ("..., no app to install") says nothing about it.
function clauseAt(sentence: string, at: number, length: number): string {
  // "... any phone or tablet browser so volunteers can view the list without downloading an app": the "without" of a
  // clause that follows says nothing about the browser.
  const cut = /[,;:—–]|\s-\s|\bbut\b|\band\s+(?=(?:it|we|you|they|the|our)\b)|\b(?:so|because|since|which|while|whereas|without)\b/gi;
  let start = 0;
  let end = sentence.length;
  for (const hit of sentence.matchAll(cut)) {
    if (hit.index! + hit[0].length <= at) start = hit.index! + hit[0].length;
    else if (hit.index! >= at + length) { end = hit.index!; break; }
  }
  return sentence.slice(start, end);
}
// A "no" before the term counts in its own clause; one after it counts only when the claim is told as not being so
// ("VAT lines are not built yet").
const said_no = (clause: string) => DENIED.test(clause);
// A policy said not to exist yet claims none: "we have not decided a refund policy yet".
const UNDECIDED = /\b(?:not\s+(?:yet\s+)?(?:decided|set|settled|agreed|final(?:ised|ized)?)|undecided|yet\s+to\s+(?:decide|set|agree)|still\s+(?:deciding|working\s+out))\b/i;

type Claim = { key: string; about: string; index: number; length: number; stated: boolean };
function claimsIn(sentence: string): Claim[] {
  if (QUESTION.test(sentence.trim())) return [];
  return KINDS.flatMap((kind) => {
    const found: Claim[] = [];
    const global = new RegExp(kind.pattern.source, `${kind.pattern.flags.replace('g', '')}g`);
    for (const hit of sentence.matchAll(global)) {
      const key = kind.key(hit as RegExpExecArray);
      if (!key) continue;
      const clause = clauseAt(sentence, hit.index!, hit[0].length);
      // "If a visitor cancels, the fee is non-refundable": an opening "if" sets a case, it does not ask.
      const before = sentence.slice(0, hit.index!).replace(/^\s*(?:and\s+|but\s+)?(?:if|when)\b[^,;:]*[,;:]/i, '');
      if ((!kind.stated && said_no(clause)) || UNDECIDED.test(clause) || LEARNING.test(before) || LEARNING.test(clause)) continue;
      if (HONEST.test(sentence) && !ASSERTS.test(clause)) continue;
      // A platform named only in passing ("Tom has an old Android phone") claims nothing about the product.
      if (kind === PLATFORM_KIND) {
        const before = sentence.slice(Math.max(0, hit.index! - 60), hit.index!);
        // "Results from the web" is no claim: the web, a browser or a desktop needs a verb that says the product
        // runs there, or another platform beside it ("iOS/web").
        const loose = /^(?:web|browser|desktop)$/.test(key);
        if (loose ? !STRONG_VERB.test(before) && !/\b(?:iOS|Android|Windows|macOS|Linux|iPhones?|iPads?)\s*(?:\/|,|\band\b|\bor\b)\s*(?:the\s+)?$/i.test(before) : !CLAIM_VERB.test(before)) continue;
      }
      found.push({ key, about: kind.about(hit as RegExpExecArray), index: hit.index!, length: hit[0].length, stated: !!kind.stated });
    }
    return found;
  });
}

const sentencesOf = (text: string) => text.split(/\n|(?<=[.!?])\s+/).map((one) => one.trim()).filter(Boolean);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A source sentence backs a claim when it states the same thing: a question, a doubt or a no backs nothing.
function backed(key: string, sources: string[], stated = false): boolean {
  // A refund or cancellation is backed by any form of its word: "refundable", "cancellations".
  const term = new RegExp(`\\b${escape(key).replace(/\s+/g, '[-\\s]?')}${/^(?:refund|cancel)$/.test(key) ? '\\w*' : '\\w{0,3}'}\\b`, 'i');
  return sources.flatMap(sentencesOf).some((sentence) => {
    if (QUESTION.test(sentence)) return false;
    const hit = term.exec(sentence);
    if (!hit) return false;
    const clause = clauseAt(sentence, hit.index, hit[0].length);
    return (stated || !said_no(clause)) && !LEARNING.test(clause);
  });
}

// What one sentence claims about the product that nothing on record states, in a few words each.
export function unbackedProductClaims(sentence: string, sources: string[]): string[] {
  return [...new Set(claimsIn(sentence).filter((claim) => !backed(claim.key, sources, claim.stated)).map((claim) => claim.about))];
}

// The same over a whole text, sentence by sentence: for an email body.
export function productClaimsIn(text: string, sources: string[]): string[] {
  return [...new Set(text.split('\n').flatMap((line) => line.split(/(?<=[.!?])\s+/)).flatMap((sentence) => unbackedProductClaims(sentence, sources)))];
}

// A chat reply held to the record: a product claim inside brackets loses the brackets, any other sentence holding one
// goes, and the reply says what was left out. Journey 18's "(turning WhatsApp photos into quotes instantly from
// iOS/web)" goes; the sentence it stood in stays.
export function holdProductClaims(reply: string, sources: string[]): { text: string; left: string[] } {
  const left: string[] = [];
  const lines = reply.split('\n').map((line) => {
    // Code and quotes are what someone else wrote.
    if (!line.trim() || /^\s*(?:>|```|\|)/.test(line)) return line;
    const lead = /^\s*(?:[-*]\s+|\d+[.)]\s+)?/.exec(line)![0];
    const kept = line.slice(lead.length).split(/(?<=[.!?])\s+/).flatMap((sentence) => {
      let held = sentence.replace(/\s*\(([^()]*)\)/g, (whole, inside: string) => {
        const missing = unbackedProductClaims(inside, sources);
        if (!missing.length) return whole;
        left.push(...missing);
        return '';
      });
      const missing = unbackedProductClaims(held, sources);
      if (missing.length) { left.push(...missing); return []; }
      held = held.replace(/\s+([.!?,;:])/g, '$1');
      return [held];
    });
    return kept.length ? `${lead}${kept.join(' ')}` : null;
  }).filter((line): line is string => line !== null);
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const unique = [...new Set(left)];
  return { text: unique.length ? `${text}\n\n(left out: nothing on record says it about ${unique.join(', ')})` : reply, left: unique };
}

// What a lead's question about the product asks, in words for an honest line: "Does it work with photos from my old
// Android phone?" → "whether it works with photos from your old Android phone". Null when the question is not about
// the product's platforms, taxes, compliance, terms or integrations.
export function productTopic(question: string): { name: string; keys: RegExp } | null {
  const plain = question.trim().replace(/^(?:and|also|so|but|plus)\s+/i, '').replace(/\?+\s*["”']*$/, '').trim();
  const asked = plain.replace(/\?/g, '');
  let keyword: string | null = null;
  let about = '';
  let policy = false;
  for (const kind of KINDS) {
    const hit = kind.pattern.exec(asked);
    const key = hit ? kind.key(hit) : null;
    if (hit && key) { keyword = key; about = kind.about(hit); policy = !!kind.policy; break; }
  }
  if (!keyword) return null;
  const keys = new RegExp(`\\b${escape(keyword).replace(/\s+/g, '[-\\s]?')}`, 'i');
  // Journey 20: "If a visitor cancels, do they get the €4 back?" is asked about our refund policy: the honest line says
  // that ("I will check our refund policy"), never a yes or a no.
  if (policy) return { name: about, keys };
  const you = (text: string) => text.replace(/\bmy\b/gi, 'your').replace(/\bme\b/gi, 'you').replace(/\bI\b/g, 'you').replace(/\bmine\b/gi, 'yours').replace(/\bwe\b/gi, 'you').replace(/\bour\b/gi, 'your');
  const subject = '(it|they|this|that|the\\s+\\p{L}+|your\\s+\\p{L}+|\\p{Lu}[\\p{L}]+)';
  const does = new RegExp(`^(does|do)\\s+${subject}\\s+(\\p{L}+)(.*)$`, 'iu').exec(asked);
  if (does) {
    const verb = does[1].toLowerCase() === 'does' ? (/(?:s|sh|ch|x|o)$/i.test(does[3]) ? `${does[3]}es` : /[^aeiou]y$/i.test(does[3]) ? `${does[3].slice(0, -1)}ies` : `${does[3]}s`) : does[3];
    return { name: `whether ${you(does[2]).replace(/^The\b/, 'the')} ${verb}${you(does[4])}`, keys };
  }
  const can = new RegExp(`^(can|could|will|would|is|are)\\s+${subject}\\s+(.*)$`, 'iu').exec(asked);
  if (can) {
    const verb = can[1].toLowerCase() === 'could' ? 'can' : can[1].toLowerCase() === 'would' ? 'will' : can[1].toLowerCase();
    return { name: `whether ${you(can[2]).replace(/^The\b/, 'the')} ${verb} ${you(can[3])}`, keys };
  }
  return { name: about, keys };
}
