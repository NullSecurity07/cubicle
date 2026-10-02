import { FIND_VARS } from '../leads/openoutreach.ts';
import { ENTRIES, needs } from '../providers.ts';

// Every name in `.env` the app reads, in the words of the health check that asks about it: the model keys straight
// from models.json (so a provider added there is a row here without anyone remembering to add it), then what each
// service row in Health names in its fix. `restart`: the app reads it only when it starts. `where`: where to make one.
export type KeyInfo = { name: string; group: string; label: string; where?: string; restart: boolean };

// The providers as the README's table names them, and where each key is made. A provider not named here still gets
// its row, under its name in models.json.
export const PROVIDERS: Record<string, { label: string; where: string }> = {
  GROQ_API_KEY: { label: 'Groq', where: 'console.groq.com/keys' },
  CEREBRAS_API_KEY: { label: 'Cerebras', where: 'cloud.cerebras.ai' },
  GEMINI_API_KEY: { label: 'Gemini', where: 'aistudio.google.com/apikey' },
  NVIDIA_API_KEY: { label: 'NVIDIA', where: 'build.nvidia.com' },
  ZAI_API_KEY: { label: 'Z.ai', where: 'z.ai' },
  AI_GATEWAY_API_KEY: { label: 'Vercel AI Gateway', where: 'vercel.com' },
  // Cloudflare also draws the pictures; its two names are shown here, once.
  CLOUDFLARE_API_TOKEN: { label: 'Cloudflare token', where: 'dash.cloudflare.com, Workers AI' },
  CLOUDFLARE_ACCOUNT_ID: { label: 'Cloudflare account id', where: 'dash.cloudflare.com, Workers AI' },
  OLLAMA_API_KEY: { label: 'Ollama cloud', where: 'ollama.com/settings/keys' },
  SAMBANOVA_API_KEY: { label: 'SambaNova', where: 'cloud.sambanova.ai' },
  MISTRAL_API_KEY: { label: 'Mistral', where: 'console.mistral.ai' },
  OPENROUTER_API_KEY: { label: 'OpenRouter', where: 'openrouter.ai/keys' },
};

const FIND_LABELS: Record<string, string> = {
  OPENOUTFIND_PRODUCT_DOCS: 'Product docs', OPENOUTFIND_CAMPAIGN_TARGET: 'Who to find', OPENOUTFIND_AI_MODEL: 'Model it uses',
  OPENOUTFIND_LLM_API_KEY: 'Model key', OPENOUTFIND_BETTERCONTACT_API_KEY: 'BetterContact key', OPENOUTFIND_OPERATOR_EMAIL: 'Your email',
  OPENOUTFIND_OPERATOR_COUNTRY: 'Your country', OPENOUTFIND_ACCEPT_LEGAL_NOTICE: 'Legal notice accepted',
};

// The service rows of Health (`keyChecks`), and the phone. The group is the row's own name, so a founder who read
// "Email: needs you" there finds the same word here.
const SERVICES: KeyInfo[] = [
  { name: 'AGENTMAIL_API_KEY', group: 'Email', label: 'AgentMail', where: 'agentmail.to', restart: true },
  { name: 'GMAIL_USER', group: 'Email', label: 'Gmail address', restart: true },
  { name: 'GMAIL_APP_PASSWORD', group: 'Email', label: 'Gmail app password', where: 'myaccount.google.com/apppasswords', restart: true },
  { name: 'CLOUDFLARE_API_TOKEN', group: 'Drawing pictures', label: 'Cloudflare token', where: 'dash.cloudflare.com, Workers AI', restart: true },
  { name: 'CLOUDFLARE_ACCOUNT_ID', group: 'Drawing pictures', label: 'Cloudflare account id', where: 'dash.cloudflare.com, Workers AI', restart: true },
  { name: 'HF_TOKEN', group: 'Making clips', label: 'Hugging Face token', where: 'huggingface.co/settings/tokens', restart: true },
  { name: 'PEXELS_API_KEY', group: 'Real photographs', label: 'Pexels', where: 'pexels.com/api', restart: true },
  { name: 'FREESOUND_API_KEY', group: 'More music', label: 'Freesound', where: 'freesound.org/apiv2/apply', restart: true },
  // OpenOutreach reads .env afresh every time it runs, so these work at once.
  ...FIND_VARS.map((name) => ({ name, group: 'Finding leads', label: FIND_LABELS[name] ?? name, restart: false })),
  { name: 'TELEGRAM_BOT_TOKEN', group: 'Phone', label: 'Telegram bot token', where: '@BotFather in Telegram', restart: true },
];

// One row a name. A name two groups need (Cloudflare draws pictures and answers as a model) is shown once, in the
// first group that needs it.
export function catalogue(entries: { name: string; keyEnv: string; baseURL: string; local?: boolean }[] = ENTRIES): KeyInfo[] {
  const models: KeyInfo[] = entries.filter((entry) => !entry.local).flatMap((entry) => needs(entry).map((name) => ({
    name, group: 'Models', label: PROVIDERS[name]?.label ?? entry.name, where: PROVIDERS[name]?.where, restart: true,
  })));
  const seen = new Set<string>();
  return [...models, ...SERVICES].filter((one) => !seen.has(one.name) && seen.add(one.name));
}

// Names the route will write that are not keys: where backups go, which the Health panel sets.
export const SETTINGS = ['STAGE_BACKUP_DIR'];

// The free sign-ups that would each put another model behind Gemini on a room-sized turn, best first (the round-5
// research): NVIDIA and Mistral are strong on their own, Cerebras and OpenRouter hold a whole room prompt.
export const FALLBACK_KEYS = ['NVIDIA_API_KEY', 'MISTRAL_API_KEY', 'CEREBRAS_API_KEY', 'OPENROUTER_API_KEY'];

// The ones not set here, as "NVIDIA at build.nvidia.com (nemotron-3-super-120b-a12b, kimi-k3)", or null when every one is set.
export function fallbackList(isSet: (name: string) => boolean, entries: { keyEnv: string; model: string }[] = ENTRIES): string | null {
  const unset = FALLBACK_KEYS.filter((name) => !isSet(name));
  if (!unset.length) return null;
  return unset.map((name) => {
    const models = entries.filter((entry) => entry.keyEnv === name).map((entry) => entry.model.split('/').pop());
    return `${PROVIDERS[name]?.label ?? name}${PROVIDERS[name] ? ` at ${PROVIDERS[name].where}` : ''} (${models.join(', ')})`;
  }).join('; ');
}

export function fallbackLine(isSet: (name: string) => boolean): string | null {
  const list = fallbackList(isSet);
  return list ? `Keys that would add a fallback, each a free sign-up: ${list}.` : null;
}
