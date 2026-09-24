import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// The coder's own settings, never the founder's. The founder's opencode loads their plugins, their outside tools and a
// blanket "allow everything"; the one on the stage starts from nothing and asks before it edits a file or runs a
// command, so every step it takes is one the founder saw.

// The providers the app itself holds keys for, and the key each one reads. A provider is named only when its key is
// here, so the model picker never offers something that cannot answer.
const KEYED: [provider: string, key: string][] = [['groq', 'GROQ_API_KEY'], ['google', 'GEMINI_API_KEY'], ['openrouter', 'OPENROUTER_API_KEY']];
const LOCAL = 'http://127.0.0.1:11434/v1';

// Read, search and look: yes. Change a file or run a command: ask. Leave the folder, reach the web, start a helper
// agent (those trip the free models' gate) or stop to ask a question nobody is there to answer: no.
// Skills: no. Every skill opencode can see goes into the prompt by name and description, and the one it always has
// (how to configure opencode itself) is of no use in the founder's project; denied, the list and the tool both go.
const PERMISSION = {
  read: 'allow', glob: 'allow', grep: 'allow', lsp: 'allow', skill: 'deny',
  edit: 'ask', bash: 'ask', doom_loop: 'ask',
  webfetch: 'deny', websearch: 'deny', external_directory: 'deny', task: 'deny', question: 'deny',
};

type Founder = { provider?: Record<string, unknown>; tool_output?: unknown } | undefined;
export type CoderConfig = {
  permission: Record<string, string>; provider: Record<string, any>; enabled_providers: string[];
  compaction: { auto: boolean }; tool_output?: unknown; autoupdate: false; share: 'disabled'; model?: string; small_model?: string;
};

export function coderConfig({ env, founder }: { env: NodeJS.ProcessEnv; founder?: Founder }): { config: CoderConfig; keys: string[] } {
  const keyed = KEYED.filter(([, key]) => env[key]?.trim());
  const provider: Record<string, any> = Object.fromEntries(keyed.map(([id, key]) => [id, { env: [key] }]));
  const bridge = founder?.provider?.['ollama-bridge'];
  if (bridge && typeof bridge === 'object') provider['ollama-bridge'] = bridge;
  const local = (env.OPENCODE_LOCAL_MODELS ?? '').split(',').map((one) => one.trim()).filter(Boolean);
  provider.ollama = { npm: '@ai-sdk/openai-compatible', name: 'Ollama', options: { baseURL: LOCAL }, models: Object.fromEntries(local.map((name) => [name, { name, tool_call: true }])) };
  const model = env.STAGE_CODER_MODEL?.trim();
  return {
    keys: keyed.map(([, key]) => key),
    config: {
      permission: PERMISSION, provider,
      enabled_providers: ['opencode', ...keyed.map(([id]) => id), ...(provider['ollama-bridge'] ? ['ollama-bridge'] : []), 'ollama'],
      compaction: { auto: true },
      ...(founder?.tool_output ? { tool_output: founder.tool_output } : {}),
      autoupdate: false, share: 'disabled',
      ...(model ? { model, small_model: model } : {}),
    },
  };
}

// A login the founder made in their own opencode (a Zen account, a provider key) is carried over, but only when theirs
// is the newer file: whatever the app's copy learned since stays.
export async function copyAuth(from: string, to: string): Promise<boolean> {
  const [theirs, mine] = await Promise.all([stat(from).catch(() => null), stat(to).catch(() => null)]);
  if (!theirs || (mine && mine.mtimeMs >= theirs.mtimeMs)) return false;
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  await chmod(to, 0o600);
  return true;
}

const founderFiles = () => ({ config: join(homedir(), '.config/opencode/opencode.json'), auth: join(homedir(), '.local/share/opencode/auth.json') });

// Everything the coder keeps lives under `workspace/opencode`: its config, its settings folder (empty, so the
// founder's global one is never read) and its data (sessions and their database). Written again at every start.
export async function writeCoderHome({ workspace, env, founderConfig = founderFiles().config, founderAuth = founderFiles().auth }: { workspace: string; env: NodeJS.ProcessEnv; founderConfig?: string; founderAuth?: string }) {
  const root = join(workspace, 'opencode');
  const home = { configPath: join(root, 'opencode.json'), configHome: join(root, 'settings'), dataHome: join(root, 'data') };
  await Promise.all([mkdir(home.configHome, { recursive: true }), mkdir(join(home.dataHome, 'opencode'), { recursive: true })]);
  const founder = await readFile(founderConfig, 'utf8').then((text) => JSON.parse(text) as Founder, () => undefined);
  const { config, keys } = coderConfig({ env, founder });
  await writeFile(home.configPath, JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...config }, null, 2));
  await copyAuth(founderAuth, join(home.dataHome, 'opencode', 'auth.json')).catch(() => false);
  return { ...home, keys };
}
export type CoderHome = Awaited<ReturnType<typeof writeCoderHome>>;
