import { mkdtemp, readFile, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coderConfig, copyAuth, writeCoderHome } from './config.ts';

const bridge = { npm: '@ai-sdk/openai-compatible', name: 'Ollama Bridge', options: { baseURL: 'http://127.0.0.1:11435/v1' }, models: { 'qwen7b-coder': { name: 'Qwen', tool_call: true } } };
const founder = { permission: { '*': 'allow' }, tool_output: { max_lines: 150, max_bytes: 8192 }, plugin: ['./plugins/notify.ts'], mcp: { laya: {} }, provider: { 'ollama-bridge': bridge, google: { env: ['GEMINI_API_KEY'] } } };

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
    expect(permission).toMatchObject({ edit: 'ask', bash: 'ask', doom_loop: 'ask', webfetch: 'deny', websearch: 'deny', external_directory: 'deny', task: 'deny', question: 'deny', read: 'allow', glob: 'allow', grep: 'allow', lsp: 'allow' });
    expect(permission).not.toHaveProperty('*');
  });

  it('copies the founder\'s local bridge as it is, and nothing else of theirs but the output caps', () => {
    const { config } = coderConfig({ env: {}, founder });
    expect(config.provider['ollama-bridge']).toEqual(bridge);
    expect(config.enabled_providers).toEqual(['opencode', 'ollama-bridge', 'ollama']);
    expect(config.tool_output).toEqual({ max_lines: 150, max_bytes: 8192 });
    expect(config).not.toHaveProperty('plugin');
    expect(config).not.toHaveProperty('mcp');
    expect(config.compaction).toEqual({ auto: true });
    expect(config).toMatchObject({ autoupdate: false, share: 'disabled' });
  });

  it('lists the founder\'s own local models under a plain ollama provider, which nothing starts', () => {
    const { config } = coderConfig({ env: { OPENCODE_LOCAL_MODELS: 'qwen2.5-coder:7b, llama3.2' } });
    expect(config.provider.ollama.options.baseURL).toBe('http://127.0.0.1:11434/v1');
    expect(Object.keys(config.provider.ollama.models)).toEqual(['qwen2.5-coder:7b', 'llama3.2']);
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
    const home = await writeCoderHome({ workspace, env: { GROQ_API_KEY: 'x' }, founderConfig: join(workspace, 'missing.json'), founderAuth: theirs });
    expect(home.configPath).toBe(join(workspace, 'opencode', 'opencode.json'));
    expect(JSON.parse(await readFile(home.configPath, 'utf8')).provider.groq).toEqual({ env: ['GROQ_API_KEY'] });
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
