import type { Attention, ModelInfo } from '../shared/model';
// Which key each model answers with: read-only data the server loads its providers from, so a refused key names its models.
import entries from '../server/models.json';

// One dot per model in the rail. It says only what is known: a model nobody has asked today is untested, not "100%
// left"; a model whose key was refused, or whose free plan is off, is a warning until it answers again (the founder's
// list holds that entry exactly as long); otherwise the share of today's free allowance left.
export type Dot = { tone: 'fine' | 'low' | 'out' | 'untested' | 'refused'; words: string };

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
  const key = KEY_OF.get(model.name);
  const told = key ? refused.get(key) : undefined;
  if (told) return { tone: 'refused', words: told };
  if (!model.requests) return { tone: 'untested', words: 'untested' };
  const left = Math.round(model.left * 100);
  return { tone: model.left <= 0.05 ? 'out' : model.left < 0.2 ? 'low' : 'fine', words: `${left}% left` };
}
