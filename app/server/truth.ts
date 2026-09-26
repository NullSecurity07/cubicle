// The truth net: what a finished reply says, checked in code against what this turn really did and really read.
// Prompt lines ask a person to claim no save no tool made and to invent no figure; the models still do both now and
// then, so the reply is read afterwards and the founder is told, in a line under it, what nothing backs. The model's
// words are never taken away.

export type Receipt = { name: string; ok?: boolean; effect?: unknown };

// Each kind of claimed action, and the tools whose working receipt confirms it.
const WRITES = /write|create|append|replace|remember|retain|note_|add_|log_|edit_|make_|move_|score_|propose_|generate_|save|delegate|code_task|run_code/;
const KINDS: { verbs: RegExp; tools: RegExp }[] = [
  { verbs: /^(saved|wrote|written|updated|created|stored|recorded)$/i, tools: WRITES },
  { verbs: /^(sent|emailed|mailed|messaged)$/i, tools: /send|mail|reach|telegram|ask_person|note_founder/ },
  { verbs: /^(posted|published)$/i, tools: /post|publish|send|reach|browse|edit_site|make_site/ },
  { verbs: /^(scheduled|booked)$/i, tools: /watch|automation|schedule|repeat|propose_task|remind|nudge|delegate/ },
];
const VERBS = 'saved|wrote|written|updated|created|stored|recorded|sent|emailed|mailed|messaged|posted|published|scheduled|booked';
// "I saved", "I've just sent", "we have posted"; "it has been saved", "the post was published"; a sentence that opens
// with the verb, "Saved it to plan.md".
const FIRST = new RegExp(`\\b(?:I|we)(?:'ve| have| had)?(?:\\s+(?:just|now|already|also|then))?\\s+(${VERBS})\\b`, 'gi');
const PASSIVE = new RegExp(`\\b(?:has been|have been|had been|was|were|is now|are now|is|are)(?:\\s+(?:just|now|already|also))?\\s+(${VERBS})\\b`, 'gi');
const OPENING = new RegExp(`(?:^|[.!?]\\s+|\\n\\s*)(${VERBS})\\s+(?:it|the|this|to|your|a|an|them|\`|")`, 'gi');
// A claim that is not one: under a condition, denied, or about words that sit in this very reply.
const CONDITION = /\b(?:once|after|when|if|before|until|unless|nothing|no one|nobody|none|not|never)\s*$/i;
const HERE = /\b(?:below|above|here|in this (?:reply|message|chat))\b/i;

function sentenceAround(text: string, at: number): { before: string; rest: string } {
  const start = Math.max(text.lastIndexOf('.', at - 1), text.lastIndexOf('!', at - 1), text.lastIndexOf('?', at - 1), text.lastIndexOf('\n', at - 1)) + 1;
  const ends = /[.!?\n]/g;
  ends.lastIndex = at;
  const end = ends.exec(text);
  return { before: text.slice(start, at), rest: text.slice(at, end ? end.index + 1 : text.length) };
}

// The action verbs this reply claims as done that no working receipt of the same kind stands behind, in the order said.
export function unreceiptedClaims(reply: string, receipts: Receipt[]): string[] {
  const found: { at: number; verb: string }[] = [];
  for (const pattern of [FIRST, PASSIVE, OPENING]) {
    for (const match of reply.matchAll(pattern)) {
      const verb = match[1];
      const at = match.index + match[0].length - verb.length;
      // Where the subject starts ("I", "it was"): whatever came before it in the sentence says if this is a claim.
      const start = match.index + match[0].length - match[0].trimStart().length;
      const { before } = sentenceAround(reply, start);
      const { rest } = sentenceAround(reply, at);
      if (CONDITION.test(before) || HERE.test(rest) || rest.trimEnd().endsWith('?')) continue;
      found.push({ at, verb: verb.toLowerCase() });
    }
  }
  const worked = receipts.filter((receipt) => receipt.ok);
  const claims = found.sort((a, b) => a.at - b.at).map((one) => one.verb)
    .filter((verb) => !worked.some((receipt) => KINDS.find((kind) => kind.verbs.test(verb))!.tools.test(receipt.name)));
  return [...new Set(claims)];
}

const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?`;
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
const UNITS = 'users|customers|clients|signups|sign-ups|subscribers|downloads|visitors|leads|employees|hires|seats|months|weeks|days|hours';
// A figure worth checking: money, a percentage, or a count with a unit. Bare numbers (dates, section numbers, steps)
// are not figures here.
const FIGURE = new RegExp(String.raw`[$€£]\s?${AMOUNT}\s?(k|mm|m|bn|b|thousand|million|billion)?\b|${AMOUNT}\s?(%|percent\b)|${AMOUNT}\s?(k|m|x|×)?\s?(${UNITS})\b|${AMOUNT}(x|×)(?![\w])`, 'gi');
const ANY = new RegExp(String.raw`${AMOUNT}\s?(k|mm|m|bn|b|thousand|million|billion)?\b`, 'gi');

const valueOf = (whole: string, fraction: string | undefined, scale?: string) => Number(`${whole.replace(/,/g, '')}${fraction ?? ''}`) * (scale ? SCALE[scale.toLowerCase()] ?? 1 : 1);

// Every figure in the reply whose value appears in none of the inputs of this turn: what the founder said, the history
// and docs the prompt carried, and what the tools gave back. A figure written another way ($22k for $22,000, $36.9k
// for $36,850) counts as found. Counts of ten or less with a unit ("3 weeks", "5 customers") are never flagged.
export function unsourcedFigures(reply: string, sources: string[]): string[] {
  const known: number[] = [];
  for (const source of sources) {
    for (const match of source.matchAll(ANY)) {
      known.push(valueOf(match[1], match[2]));
      if (match[3]) known.push(valueOf(match[1], match[2], match[3]));
    }
  }
  const found = (value: number) => known.some((one) => Math.abs(one - value) <= Math.abs(value) * 0.005 + 1e-9);
  const flagged: string[] = [];
  for (const match of reply.matchAll(FIGURE)) {
    const label = match[0].trim();
    let value: number;
    if (match[1] !== undefined) value = valueOf(match[1], match[2], match[3]);
    else if (match[4] !== undefined) value = valueOf(match[4], match[5]);
    else if (match[7] !== undefined) {
      value = valueOf(match[7], match[8], match[9] && !/x|×/i.test(match[9]) ? match[9] : undefined);
      if (value <= 10) continue;
    } else {
      value = valueOf(match[11], match[12]);
      if (value <= 10) continue;
    }
    // A figure may be quoted in its bare form too ("18" for "18 months"), so the unscaled number also counts.
    if (found(value) || (match[1] === undefined && match[4] === undefined && found(valueOf(match[7] ?? match[11], match[8] ?? match[12])))) continue;
    if (!flagged.includes(label)) flagged.push(label);
  }
  return flagged;
}

// A tool call the model wrote out as words instead of making it: the XML shapes of Qwen and Hermes, a raw JSON call,
// or a tool's name with its JSON arguments right after it ("**ask_founder**{...}").
export function proseToolCall(reply: string, names: string[] = []): boolean {
  if (/<\/?tool_call>|<function=|<\|(?:tool_call|function_call)/i.test(reply)) return true;
  if (/\{\s*"(?:name|tool)"\s*:\s*"[\w.-]+"\s*,\s*"(?:arguments|parameters|args)"\s*:/.test(reply)) return true;
  return [...new Set([...names, 'ask_founder', 'ask_person'])].some((name) =>
    new RegExp(String.raw`(?:^|[^\w])${name}\**\`*\s*\(?\s*\{\s*"`).test(reply));
}

// Said to a model that wrote its tool call out as text: once, before the founder is shown a clean line instead.
export const CALL_THE_TOOL = 'You wrote a tool call as text. Call the tool, do not write it as text. If you meant to answer, answer in plain words.';
export const ANSWER_IN_WORDS = 'You wrote a tool call as text, but no tool can be called here. Answer in plain words.';
export const HELD_BACK = 'This reply wrote a tool call out as text twice instead of making it, so it was held back. Ask again, or ask for a plain answer.';

// The lines the founder sees under a reply that says more than this turn can back.
export function checkReply(input: { reply: string; receipts: Receipt[]; sources: string[] }): string[] {
  const lines: string[] = [];
  const claims = unreceiptedClaims(input.reply, input.receipts);
  if (claims.length) lines.push(`Unconfirmed: this reply claims an action no tool confirmed (${claims.join(', ')}).`);
  const figures = unsourcedFigures(input.reply, input.sources);
  if (figures.length) lines.push(`Unsourced figures: ${figures.slice(0, 8).join(', ')} (not found in anything this turn read).`);
  return lines;
}
