import type { Handover } from '../../shared/delegation.ts';
import { firstJson, JSON_RULE } from '../json.ts';

// What the colleague is told to finish with. The asker gets this and nothing else, so it has to carry the whole of
// what happened: a summary they can act on, and the names of what really moved.
export const HANDOVER_SHAPE = 'Finish with one json object and nothing after it: {"done": true or false, '
  + '"summary": "what you did and what came of it, in two or three lines", '
  + '"changed": ["each thing that really moved: a document\'s title, a file\'s path, a task"], '
  + '"blocked": "only when done is false: what stopped you"}. '
  + `Only this goes back to whoever asked, so say everything there. ${JSON_RULE}`;

export const correction = (why: string) => `That was not the shape this hand-over needs: ${why}. ${HANDOVER_SHAPE}`;

// The colleague's closing shape, or the reason it is not one. Whatever else they put in the object is dropped: the
// asker reads a hand-over, not another conversation.
export function readHandover(reply: string): Handover {
  const value = firstJson(reply);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('the json was not an object');
  const said = value as Record<string, unknown>;
  if (typeof said.done !== 'boolean') throw new Error('"done" has to be true or false');
  const summary = typeof said.summary === 'string' ? said.summary.trim() : '';
  if (!summary) throw new Error('"summary" is missing');
  const changed = Array.isArray(said.changed) ? said.changed.filter((one): one is string => typeof one === 'string' && !!one.trim()).map((one) => one.trim()) : [];
  const blocked = typeof said.blocked === 'string' && said.blocked.trim() ? said.blocked.trim() : undefined;
  return { done: said.done, summary, changed, ...(blocked ? { blocked } : {}) };
}

// The closing json was the shape the asker needed, not something to read in the colleague's own room; what is left
// after it is what they actually said. A reply that was nothing but the shape keeps its summary instead of going blank.
export function spoken(text: string, hand: Handover | null): string {
  const said = text.replace(/```(?:json)?\s*\{[\s\S]*\}\s*```\s*$/i, '').replace(/\{\s*"done"[\s\S]*\}\s*$/, '').trim();
  return said || hand?.summary || text.trim();
}

// The hand-over as the asker reads it, in plain lines rather than the json it arrived as.
export function told(name: string, hand: Handover): string {
  return [
    `${name} ${hand.done ? 'finished' : 'did not finish'}.`,
    hand.summary,
    hand.changed.length ? `Changed: ${hand.changed.join(', ')}` : '',
    hand.blocked ? `What stopped them: ${hand.blocked}` : '',
  ].filter(Boolean).join('\n');
}
