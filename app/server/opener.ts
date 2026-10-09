// What a first message says about the person it goes to is a fact about them, and it has to be on record. Journey 18:
// "Draft first message" on Tom Becker opened "I saw your comment on Reddit about spending your evenings after jobs
// writing up quotes in the van." Nothing was searched or read; the skill said never to invent a detail, and the
// model did. Here, in code: a sentence that says what the person did, wrote, said or posted (or where) stands only
// when something about them backs it: their row and notes on the Leads card, what they wrote back, the founder's own
// words or a read that worked this turn. The Company brief is no source for them: it says what we do. With nothing,
// the opener is a plain line about what we do, from the brief.

// A source with a name the founder can read: "Company brief", "Tom Becker's row on the Leads card".
export type Labelled = { label: string; text: string };

// What a sentence says about the person: "I saw your comment", "you mentioned", "congrats on the launch", "on Reddit".
const PERSONAL: RegExp[] = [
  /\b(?:I|we)(?:'ve|’ve| have)?\s+(?:just\s+|recently\s+)?(?:saw|seen|noticed|read|came across|come across|spotted|loved|enjoyed|liked|heard|watched|followed|listened to)\b/i,
  /\byour\s+(?:recent\s+|latest\s+|last\s+|great\s+)?(?:comment|post|article|tweet|talk|podcast|interview|review|thread|video|blog|newsletter|launch|funding|round|announcement|hire|hiring|job (?:post|ad)|website|site|profile|answer|question|reel|story)s?\b/i,
  /\byou(?:'ve|’ve| have)?\s+(?:recently\s+|just\s+)?(?:mentioned|said|wrote|written|posted|shared|commented|asked|told|tweeted|spoke|spoken|talked|complained|raised|launched|opened|hired|grew|expanded|won)\b/i,
  /\bcongrat\w*\b/i,
  /\b(?:on|in|via)\s+(?:Reddit|LinkedIn|Twitter|X|Facebook|Instagram|TikTok|YouTube|Hacker News|Product Hunt|a forum|a podcast|r\/\w+)\b/i,
];
// Places a detail came from: named in a sentence, one of the sources has to name it too.
const PLACES = /\b(Reddit|LinkedIn|Twitter|Facebook|Instagram|TikTok|YouTube|Hacker News|Product Hunt|podcast|forum|r\/\w+)\b/gi;
// Words that say nothing about what was seen.
const STOP = new Set(('the and you your yours our we i me my it its this that these those with from about into onto over for after before '
  + 'what when where who how which have has had was were are is be been being just recently really very also some any all '
  + 'saw seen noticed read came come across spotted loved enjoyed liked heard watched found followed listened '
  + 'comment comments post posts article talk podcast interview review thread video blog newsletter website site profile '
  + 'mentioned said wrote written posted shared commented asked told tweeted spoke spoken talked congrats congratulations '
  + 'reddit linkedin twitter facebook instagram tiktok youtube hi hello there great love would could should will can '
  + 'their them they his her him she he one two lot much more most many such like than then them').split(' '));
const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? []).filter((one) => !STOP.has(one))
  .map((one) => one.replace(/(?:'s|’s)$/, '').replace(/(?:ing|ed|es|s)$/, ''));

const sentencesOf = (text: string) => text.split('\n').flatMap((line) => line.split(/(?<=[.!?])\s+/)).map((one) => one.trim()).filter(Boolean);
// Journey 20: "Regarding your questions:" was refused twice as a thing said about Ines. A line that only frames what
// follows says nothing about anyone: a short header ending in a colon, a greeting, a sign-off, a name under it.
const HEADER = /^(?:[-*]\s+)?[^.!?:\n]{1,60}:\s*$/;
const GREETING = /^(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))\b[\p{L}\s'.-]{0,40}[,!]?$/iu;
const SIGN_OFF = /^(?:best|kind|warm|many|all the best|regards|thanks|thank you|cheers|sincerely|yours)(?:\s+(?:regards|wishes|thanks|truly))?\s*[,.!]?$/i;
const NAME = /^\p{Lu}[\p{L}'.&-]*(?:(?:\s*[/|,–—]\s*|\s+)\p{Lu}[\p{L}'.&-]*){0,4}$/u;
export const isFraming = (line: string) => {
  const said = line.trim();
  return !!said && (HEADER.test(said) && said.split(/\s+/).length <= 8 || GREETING.test(said) || SIGN_OFF.test(said) || NAME.test(said));
};
const isPersonal = (sentence: string) => !/\?\s*$/.test(sentence) && !isFraming(sentence) && PERSONAL.some((pattern) => pattern.test(sentence));

// Words that say only that they are who their row says they are: "you run Becker Sanitär", "your work at ...".
const LIGHT = new Set(['run', 'runn', 'work', 'lead', 'own', 'manag', 'found', 'team', 'company', 'business', 'shop', 'place']);

// The source a personal sentence rests on, or null: the place it names is in the source, and two words of substance
// are (one, when the sentence has only one). Journey 20: "I saw Repair Café Kreuzberg's work running community repair
// evenings" rested on Ines's row because the row holds her café's name. Their own name and company are who they are,
// not what they did: those words never count as substance, and a sentence with nothing else needs only one of them.
function restsOn(sentence: string, about: Labelled[], names: string[] = []): Labelled | null {
  const named = new Set(names.flatMap(words));
  const all = [...new Set(words(sentence))];
  const own = all.filter((one) => !named.has(one) && !LIGHT.has(one));
  const theirs = all.filter((one) => named.has(one));
  const places = [...sentence.matchAll(PLACES)].map((hit) => hit[1].toLowerCase());
  const need = Math.min(2, own.length);
  return about.find((source) => {
    const low = source.text.toLowerCase();
    if (places.some((place) => !low.includes(place))) return false;
    const said = new Set(words(source.text));
    if (need === 0) return places.length > 0 || theirs.some((one) => said.has(one));
    return own.filter((one) => said.has(one)).length >= need;
  }) ?? null;
}

// The sentences about the person that nothing about them backs, as written. `names` are their name and company.
export function unbackedPersonal(body: string, about: Labelled[], names: string[] = []): string[] {
  return sentencesOf(body).filter((sentence) => isPersonal(sentence) && !restsOn(sentence, about, names));
}

// Who a first message is for, from the ask "Draft a first message to Ines Vogel at Repair Café Kreuzberg ...", so a
// room the Leads card is not wired to holds the opener to the same rule.
export function namesIn(ask: string): string[] {
  const hit = /\bfirst message to\s+(.+?)\s+at\s+(.+?)(?:\s+using\b|[.]\s|[.]?$)/i.exec(ask);
  return hit ? [hit[1], hit[2]] : [];
}

// The line of the brief that says what we do: the first line under its Idea (or Product) heading.
export function productLine(brief: string): string {
  const section = /^##\s+(?:Idea|Product|What we do)\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(brief)?.[1] ?? '';
  const line = section.split('\n').map((one) => one.replace(/^\s*(?:[-*]\s+)?/, '').trim()).find((one) => one && !/^#/.test(one));
  return line ? sentencesOf(line)[0] ?? line : '';
}

// What a draft used, one "(from: ...)" line each: the source of each sentence about the person, and the Company brief
// when the body says what we do in its words.
export function usedSources(body: string, about: Labelled[], brief: Labelled | null, names: string[] = []): string[] {
  const used: string[] = [];
  for (const sentence of sentencesOf(body)) {
    if (!isPersonal(sentence)) continue;
    const source = restsOn(sentence, about, names);
    if (source) used.push(source.label);
  }
  if (brief?.text.trim()) {
    const ours = new Set(words(brief.text));
    const said = sentencesOf(body).filter((sentence) => !isPersonal(sentence)).some((sentence) => words(sentence).filter((one) => ours.has(one)).length >= 2);
    if (said) used.push(brief.label);
  }
  return [...new Set(used)].map((label) => `(from: ${label})`);
}
