import { checkWords, type Attention, type ModelInfo } from '../shared/model';
// Which key each model answers with: read-only data the server loads its providers from, so a refused key names its models.
import entries from '../server/models.json';

// One dot per model in the rail. It says only what is known: a model that has never answered and whose key no check
// has passed is untested, not "100% left"; a model whose key was refused, or whose free plan is off, is a warning until
// it answers again (the founder's list holds that entry exactly as long); a model resting after it twice gave no first
// word is slow, a grey ring; otherwise the share of today's free allowance left.
export type Dot = { tone: 'fine' | 'low' | 'out' | 'untested' | 'refused' | 'slow'; words: string };

const KEY_OF = new Map((entries as { name: string; keyEnv: string }[]).map((entry) => [entry.name, entry.keyEnv]));

// The keys refused right now, each with the line the founder was given about it. Entries are `key-rejected:<ENV>:<n>`.
export function refusedKeys(list: Attention[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const one of list) if (one.kind === 'key-rejected') { const env = one.id.split(':')[1]; if (env && !keys.has(env)) keys.set(env, one.title); }
  return keys;
}

export function dotOf(model: ModelInfo, refused: Map<string, string>): Dot {
  // The server knows when every key wants a plan turned on; that says more than a refusal line, so it comes first.
  if (model.planOff) return { tone: 'refused', words: 'free plan not on' };
  if (model.needsCard) return { tone: 'refused', words: 'needs a card on file' };
  const key = KEY_OF.get(model.name);
  const told = key ? refused.get(key) : undefined;
  if (told) return { tone: 'refused', words: told };
  if (model.slow) return { tone: 'slow', words: 'slow to start, resting' };
  // A key check that timed out, found no such model or got an error is said as that until the model answers after it:
  // never as a key that passed with all its day left.
  const check = model.check;
  if (check && check.outcome !== 'ok' && !((model.lastAnswerAt ?? 0) > check.at)) return { tone: check.outcome === 'slow' ? 'slow' : 'refused', words: checkWords(check) };
  if (!model.requests && !model.lastAnswerAt && !(model.checked || check?.outcome === 'ok')) return { tone: 'untested', words: 'untested' };
  const left = Math.round(model.left * 100);
  const known = !model.requests && !model.lastAnswerAt ? 'key checked, ' : '';
  return { tone: model.left <= 0.05 ? 'out' : model.left < 0.2 ? 'low' : 'fine', words: `${known}${left}% left` };
}
