import { describe, expect, it } from 'vitest';
import models from '../server/models.json' with { type: 'json' };
import { modelTitle } from './modelNames.ts';

describe('what the founder calls a model', () => {
  it('names every model the app ships by its own name, never its id', () => {
    for (const { name } of models as { name: string }[]) {
      expect(modelTitle(name), name).not.toBe(name);
    }
    expect(modelTitle('nvidia-lightning')).toBe('Nemotron Lightning');
    expect(modelTitle('gemini-flash')).toBe('Gemini Flash');
  });

  it('says a second key as that key, and tidies an id it does not know', () => {
    expect(modelTitle('groq#2')).toBe('gpt-oss on Groq (key 2)');
    expect(modelTitle('my-local-model')).toBe('My local model');
  });
});
