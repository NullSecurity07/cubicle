import { mkdtemp, readFile, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coderConfig, copyAuth, discoverLocal, writeCoderHome } from './config.ts';

const founder = { permission: { '*': 'allow' }, tool_output: { max_lines: 150, max_bytes: 8192 }, plugin: ['./plugins/notify.ts'], mcp: { laya: {} }, provider: { 'ollama-bridge': { options: { baseURL: 'http://127.0.0.1:11435/v1' } }, google: { env: ['GEMINI_API_KEY'] } } };
// A machine's answers, by address: the bridge's model list, Ollama's own, or nothing there.
const machine = (answers: Record<string, unknown>) => (async (url: string) => (url in answers ? { ok: true, json: async () => answers[url] } : { ok: false, json: async () => null })) as unknown as typeof fetch;

describe('the coder config', () => {
  it('names a provider only when its key is here, and hands the child only those keys', () => {
    const none = coderConfig({ env: {} });
    expect(Object.keys(none.config.provider)).toEqual(['ollama']);
    expect(none.config.enabled_providers).toEqual(['opencode', 'ollama']);
    expect(none.keys).toEqual([]);

    const some = coderConfig({ env: { GROQ_API_KEY: 'gsk_x', GEMINI_API_KEY: 'AIza', ANTHROPIC_API_KEY: 'sk-ant' } });
    expect(Object.keys(some.config.provider).sort()).toEqual(['google', 'groq', 'ollama']);
    expect(some.config.provider.google).toEqual({ env: ['GEMINI_API_KEY'] });
    expect(some.config.enabled_providers).toEqual(['opencode', 'groq', 'google', 'ollama']);
    expect(some.keys).toEqual(['GROQ_API_KEY', 'GEMINI_API_KEY']);
    expect(JSON.stringify(some.config)).not.toContain('gsk_x');
  });

  it('asks before an edit or a command, and never lets the coder out of the folder, onto the web or into a subagent', () => {
    const { permission } = coderConfig({ env: {} }).config;
    expect(permission).toMatchObject({ edit: 'ask', bash: 'ask', doom_loop: 'ask', webfetch: 'deny', websearch: 'deny', external_directory: 'deny', task: 'deny', question: 'deny', skill: 'deny', read: 'allow', glob: 'allow', grep: 'allow', lsp: 'allow' });
    expect(permission).not.toHaveProperty('*');
    // Skills: every one found rides in the prompt by name and description, which a free model's small window cannot
    // afford. The founder's own folders are kept out by the server's environment; the built-in one is denied here.
    expect(permission.skill).toBe('deny');
  });

  it('takes nothing of the founder\'s own opencode but the output caps', () => {
    const { config } = coderConfig({ env: {}, founder });
    expect(config.provider).not.toHaveProperty('ollama-bridge');
    expect(config.provider).not.toHaveProperty('google');
    expect(config.enabled_providers).toEqual(['opencode', 'ollama']);
    expect(config.tool_output).toEqual({ max_lines: 150, max_bytes: 8192 });
    expect(config).not.toHaveProperty('plugin');
    expect(config).not.toHaveProperty('mcp');
    expect(config.compaction).toEqual({ auto: true });
    expect(config).toMatchObject({ autoupdate: false, share: 'disabled' });
  });

  it('lists the models found on this machine and the ones the founder named, under one ollama provider', () => {
    const { config } = coderConfig({ env: { OPENCODE_LOCAL_MODELS: 'qwen2.5-coder:7b, llama3.2' }, local: { baseURL: 'http://127.0.0.1:11435/v1', models: ['qwen3-coder:30b', 'qwen2.5-coder:7b'] } });
    expect(config.provider.ollama.options.baseURL).toBe('http://127.0.0.1:11435/v1');
    expect(Object.keys(config.provider.ollama.models)).toEqual(['qwen3-coder:30b', 'qwen2.5-coder:7b', 'llama3.2']);
    expect(config.provider.ollama.models['qwen3-coder:30b']).toEqual({ name: 'qwen3-coder:30b', tool_call: true, limit: { context: 16384, output: 4096 } });
    expect(coderConfig({ env: {} }).config.provider.ollama).toMatchObject({ options: { baseURL: 'http://127.0.0.1:11434/v1' }, models: {} });
  });

  it('finds local models through the bridge when it is up, through Ollama itself otherwise, and starts nothing', async () => {
    const tags = { models: [{ name: 'qwen3-coder:30b' }, { name: 'nomic-embed-text:latest' }, { name: 'gpt-oss:20b' }] };
    expect(await discoverLocal(machine({ 'http://127.0.0.1:11435/v1/models': { data: [{ id: 'old' }] }, 'http://127.0.0.1:11434/api/tags': tags }))).toEqual({ baseURL: 'http://127.0.0.1:11435/v1', models: ['qwen3-coder:30b', 'gpt-oss:20b'] });
    expect(await discoverLocal(machine({ 'http://127.0.0.1:11434/api/tags': tags }))).toEqual({ baseURL: 'http://127.0.0.1:11434/v1', models: ['qwen3-coder:30b', 'gpt-oss:20b'] });
    expect(await discoverLocal(machine({ 'http://127.0.0.1:11435/v1/models': { data: [{ id: 'qwen2.5:7b' }] } }))).toEqual({ baseURL: 'http://127.0.0.1:11435/v1', models: ['qwen2.5:7b'] });
    expect(await discoverLocal(machine({}))).toEqual({ baseURL: 'http://127.0.0.1:11434/v1', models: [] });
  });

  it('takes the founder\'s chosen model as the default', () => {
    expect(coderConfig({ env: { STAGE_CODER_MODEL: 'opencode/big-pickle' } }).config).toMatchObject({ model: 'opencode/big-pickle', small_model: 'opencode/big-pickle' });
    expect(coderConfig({ env: {} }).config).not.toHaveProperty('model');
  });
});

describe('the coder home', () => {
  it('is written inside the workspace, and a login carries over only when the founder\'s is newer', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'coder-home-'));
    const theirs = join(workspace, 'theirs', 'auth.json');
    await mkdir(join(workspace, 'theirs'), { recursive: true });
    await writeFile(theirs, '{"opencode":{"type":"api","key":"one"}}');
    const home = await writeCoderHome({ workspace, env: { GROQ_API_KEY: 'x' }, founderConfig: join(workspace, 'missing.json'), founderAuth: theirs, discover: async () => ({ baseURL: 'http://127.0.0.1:11435/v1', models: ['qwen3-coder:30b'] }) });
    expect(home.configPath).toBe(join(workspace, 'opencode', 'opencode.json'));
    const written = JSON.parse(await readFile(home.configPath, 'utf8'));
    expect(written.provider.groq).toEqual({ env: ['GROQ_API_KEY'] });
    expect(Object.keys(written.provider.ollama.models)).toEqual(['qwen3-coder:30b']);
    expect(home.keys).toEqual(['GROQ_API_KEY']);
    const copied = join(home.dataHome, 'opencode', 'auth.json');
    expect(await readFile(copied, 'utf8')).toContain('one');
    expect((await stat(copied)).mode & 0o777).toBe(0o600);

    // The app's own copy is newer: it stays.
    await writeFile(copied, '{"mine":true}');
    const later = new Date(Date.now() + 60_000);
    await utimes(copied, later, later);
    expect(await copyAuth(theirs, copied)).toBe(false);
    expect(await readFile(copied, 'utf8')).toContain('mine');
  });
});
