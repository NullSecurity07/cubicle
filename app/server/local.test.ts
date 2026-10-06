import { describe, expect, it } from 'vitest';
import { findLocal, realClients } from './providers.ts';

const found = (models: string[], baseURL = 'http://127.0.0.1:11435/v1') => async () => ({ baseURL, models });

describe('a model on this machine, for the people', () => {
  it('picks the best known model the machine has, or the one the founder named, and none it does not know', async () => {
    expect(await findLocal({}, found(['gemma-heretic-4b:latest', 'qwen2.5:3b', 'qwen2.5:7b']))).toEqual({ baseURL: 'http://127.0.0.1:11435/v1', model: 'qwen2.5:7b' });
    expect(await findLocal({}, found(['qwen2.5:3b'], 'http://127.0.0.1:11434/v1'))).toEqual({ baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:3b' });
    expect(await findLocal({ STAGE_LOCAL_MODEL: 'qwen3-coder:30b' } as NodeJS.ProcessEnv, found(['qwen2.5:7b']))).toEqual({ baseURL: 'http://127.0.0.1:11435/v1', model: 'qwen3-coder:30b' });
    expect(await findLocal({}, found(['gemma-heretic-4b:latest', 'gpt-oss:20b']))).toBeUndefined();
    expect(await findLocal({}, found([]))).toBeUndefined();
    expect(await findLocal({}, async () => { throw new Error('nothing there'); })).toBeUndefined();
  });

  it('stays off this machine when the founder says so', async () => {
    expect(await findLocal({ STAGE_NO_LOCAL: '1' } as NodeJS.ProcessEnv, found(['qwen2.5:7b']))).toBeUndefined();
  });

  it('stands last among the clients, needs no key, and is marked as local', () => {
    const clients = realClients({ GROQ_API_KEY: 'a', GEMINI_API_KEY: 'g' } as NodeJS.ProcessEnv, { baseURL: 'http://127.0.0.1:11435/v1', model: 'qwen2.5:7b' });
    expect(clients.map((one) => one.name)).toEqual(['groq', 'groq-small', 'gemini', 'gemini-flash', 'groq-qwen', 'ollama']);
    expect(clients.at(-1)).toMatchObject({ name: 'ollama', model: 'qwen2.5:7b', local: true, tools: true, limits: {} });
    expect(clients.slice(0, -1).every((one) => !one.local)).toBe(true);
    expect(realClients({} as NodeJS.ProcessEnv, { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:3b' }).map((one) => one.name)).toEqual(['ollama']);
    expect(realClients({ GROQ_API_KEY: 'a' } as NodeJS.ProcessEnv).map((one) => one.name)).toEqual(['groq', 'groq-small', 'groq-qwen']);
  });
});
