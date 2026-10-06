import type { Receipt } from './truth.ts';

// An email the turn did not draft is not drafted. Journey 15: draft_email was refused (the founder had said no) and the
// colleague still wrote "Drafted the reply to Mira explaining pickup options"; the partner, after the same refusal,
// pasted a draft into chat and said "Send the draft directly in Gmail" with no draft to open. The claim net let both
// through ("drafted" is no verb it knows, and "in Gmail" claims nothing). Here, in code: a refused draft says so at
// the head of its result, a reply claiming a draft the turn did not make says the refusal instead, and words that send
// the founder to Gmail stand only beside a draft they can open from this same message.

const MAIL = /^(?:draft_email|send_email)$/;
// What a refused draft's result starts with, so the person reading it cannot take it for a draft.
export const notDone = (tool: string, refusal: string) => (tool === 'draft_email' ? `NOT drafted: ${refusal}` : tool === 'send_email' ? `NOT sent: ${refusal}` : refusal);
export const NO_DRAFT = '(no draft was made)';

// "Drafted the reply", "I've drafted it", "the email is ready", "I have written the reply", "I sent it".
const CLAIMS = /\bdrafted\b|\b(?:I|we)(?:'ve| have)?\s+(?:just\s+|now\s+|already\s+)?(?:written|wrote|prepared|sent)\s+(?:the|an|a|your|her|his|their|it)\b|\b(?:draft|email|e-mail|reply|message)\s+(?:is|was)\s+(?:now\s+)?(?:ready|done|prepared|sent|written)\b/i;
const DENIED = /\b(?:not|n't|no|never|nothing|refused|declined|could not|cannot)\b/i;
// Words that send the founder to Gmail to open or send something: "Open in Gmail", "send it directly in Gmail".
const TO_GMAIL = /\b(?:open|send|review|find|check)(?:\s+(?:it|this|that|the\s+(?:draft|email|reply|message)|them))?(?:\s+(?:directly|now|yourself|from\s+there))?\s+(?:in|from|via)\s+(?:your\s+)?Gmail\b/gi;

const refusalWords = (result: string) => {
  const said = result.replace(/^NOT (?:drafted|sent):\s*/, '').replace(/^Already declined:\s*/i, '').split(/(?<=[.!?])\s/)[0].trim().replace(/[.!?]$/, '');
  return said.replace(/\bthe founder\b/gi, 'you').replace(/\btheir\b/g, 'your').replace(/\bthem\b/g, 'you');
};

export function holdDraftClaims(reply: string, receipts: Receipt[]): string {
  const drafted = receipts.some((one) => one.name === 'draft_email' && one.ok);
  const sent = receipts.some((one) => one.name === 'send_email' && one.ok);
  let text = reply;
  const refused = receipts.find((one) => MAIL.test(one.name) && one.ok === false);
  if (refused && !drafted && !sent) {
    const line = `The email was not ${refused.name === 'send_email' ? 'sent' : 'drafted'}: ${refusalWords(refused.result ?? 'it was refused')}.`;
    let said = false;
    // Sentence by sentence, keeping what ends each one: the first claim becomes the refusal, any later one goes.
    text = text.replace(/[^.!?\n]+[.!?]*/g, (sentence) => {
      if (!CLAIMS.test(sentence) || DENIED.test(sentence)) return sentence;
      const lead = /^\s*/.exec(sentence)![0];
      if (said) return '';
      said = true;
      return `${lead}${line}`;
    }).replace(/[ \t]{2,}/g, ' ');
  }
  if (!drafted) text = text.replace(TO_GMAIL, NO_DRAFT);
  return text;
}
