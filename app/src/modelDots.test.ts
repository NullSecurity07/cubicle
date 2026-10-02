import { describe, expect, it } from 'vitest';
import type { Attention, ModelInfo } from '../shared/model';
import { dotOf, refusedKeys } from './modelDots';

const model = (name: string, more: Partial<ModelInfo> = {}): ModelInfo => ({ name, model: 'm', ready: true, left: 1, requests: 3, tokens: 90, ...more });
const refused = (keyEnv: string, title = `${keyEnv} key rejected; fix it in Keys`): Attention => ({ id: `key-rejected:${keyEnv}:1`, kind: 'key-rejected', title, at: 1 });

describe('a model dot says what is known about the model, not a guess', () => {
  it('says untested for a model nobody has asked today, instead of 100% left', () => {
    expect(dotOf(model('cloudflare', { requests: 0 }), new Map())).toEqual({ tone: 'untested', words: 'untested' });
  });

  it('gives the share left once it has answered, amber under a fifth, red when gone', () => {
    expect(dotOf(model('groq', { left: 0.62 }), new Map())).toEqual({ tone: 'fine', words: '62% left' });
    expect(dotOf(model('groq', { left: 0.1 }), new Map())).toEqual({ tone: 'low', words: '10% left' });
    expect(dotOf(model('groq', { left: 0 }), new Map())).toEqual({ tone: 'out', words: '0% left' });
  });

  it('warns for a model whose key was refused or whose plan is off, used or not, with what the founder was told', () => {
    const keys = refusedKeys([refused('MISTRAL_API_KEY', "Mistral's free plan is not on; turn it on at console.mistral.ai")]);
    expect(dotOf(model('mistral', { requests: 0 }), keys)).toEqual({ tone: 'refused', words: "Mistral's free plan is not on; turn it on at console.mistral.ai" });
    expect(dotOf(model('mistral', { left: 0.9 }), keys).tone).toBe('refused');
  });

  it('marks every model that shares the refused key, and no other', () => {
    const keys = refusedKeys([refused('GROQ_API_KEY')]);
    expect(dotOf(model('groq-small'), keys).tone).toBe('refused');
    expect(dotOf(model('groq-qwen'), keys).tone).toBe('refused');
    expect(dotOf(model('gemini'), keys).tone).toBe('fine');
  });

  it('says needs a card on file for a provider every key of which wants a card, as a warning, not as a full ring', () => {
    expect(dotOf(model('sambanova', { needsCard: true, requests: 0 }), new Map())).toEqual({ tone: 'refused', words: 'needs a card on file' });
  });

  it('says free plan not on for a provider every key of which wants a plan, before anything else', () => {
    expect(dotOf(model('mistral', { planOff: true, requests: 0 }), new Map())).toEqual({ tone: 'refused', words: 'free plan not on' });
    expect(dotOf(model('mistral', { planOff: true }), refusedKeys([refused('MISTRAL_API_KEY')]))).toEqual({ tone: 'refused', words: 'free plan not on' });
  });

  it('reads only refused-key entries from the founder\'s list', () => {
    expect(refusedKeys([{ id: 'x', kind: 'approval', title: 'Maya needs your OK', at: 1 }]).size).toBe(0);
  });

  it('says untested only for a model that never answered and never passed a key check (pass 8)', () => {
    expect(dotOf(model('groq', { requests: 0 }), new Map()).tone).toBe('untested');
    expect(dotOf(model('groq', { requests: 0, checked: true }), new Map())).toEqual({ tone: 'fine', words: 'key checked, 100% left' });
    expect(dotOf(model('groq', { requests: 0, lastAnswerAt: 1 }), new Map())).toEqual({ tone: 'fine', words: '100% left' });
  });

  it('shows a model resting after two silences as slow, not untested, and a refused key or plan off before that', () => {
    expect(dotOf(model('nvidia', { requests: 0, slow: true }), new Map())).toEqual({ tone: 'slow', words: 'slow to start, resting' });
    expect(dotOf(model('nvidia', { slow: true, left: 0.8 }), new Map()).tone).toBe('slow');
    expect(dotOf(model('mistral', { slow: true, planOff: true }), new Map()).tone).toBe('refused');
    expect(dotOf(model('nvidia', { slow: true }), refusedKeys([refused('NVIDIA_API_KEY')])).tone).toBe('refused');
  });
});
