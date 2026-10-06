import { describe, expect, it } from 'vitest';
import type { CoderModels } from '../../shared/coder';
import { pillName } from './CoderModel';

const list: CoderModels = {
  default: 'opencode/big-pickle',
  groups: [
    { name: 'Free (OpenCode Zen)', models: [{ id: 'opencode/big-pickle', name: 'Big Pickle' }, { id: 'opencode/nemotron-3-ultra-free', name: 'Nemotron 3 Ultra (free)' }] },
    { name: 'Your keys', models: [{ id: 'groq/llama-4', name: 'Llama 4', provider: 'Groq' }] },
  ],
};

describe('the coder card\'s model pill', () => {
  it.each([
    ['no pick, list not asked for yet', undefined, null, 'Big Pickle · free'],
    ['no pick, list known', undefined, list, 'Big Pickle · free'],
    ['a free pick', 'opencode/nemotron-3-ultra-free', list, 'Nemotron 3 Ultra · free'],
    ['a free pick before the list', 'opencode/nemotron-3-ultra-free', null, 'Nemotron 3 Ultra · free'],
    ['a keyed pick', 'groq/llama-4', list, 'Llama 4'],
  ])('%s', (_case, model, known, said) => {
    expect(pillName(model, known)).toBe(said);
  });
});
