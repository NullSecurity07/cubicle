// What the founder calls each model: its own name, and where it runs when the same model is offered in more than one
// place. The ids (`nvidia-lightning`, `gemini-flash`) are the app's and the config's; no line the founder reads says one.
// A second key of the same provider (`groq#2`) is said as that key. A model added to models.json without a name here
// is said from its id, tidied ("my-model" reads "My model").
const NAMES: Record<string, string> = {
  'gemini-flash': 'Gemini Flash', gemini: 'Gemini Flash-Lite',
  'nvidia-ultra': 'Nemotron Ultra', nvidia: 'Nemotron Super', 'nvidia-lightning': 'Nemotron Lightning', 'nvidia-kimi': 'Kimi on NVIDIA',
  'ollama-cloud': 'Nemotron Ultra on Ollama Cloud', 'ollama-gpt-oss': 'gpt-oss on Ollama Cloud',
  'cloudflare-gpt-oss': 'gpt-oss on Cloudflare', 'cloudflare-qwen': 'Qwen on Cloudflare', cloudflare: 'Llama 4 Scout on Cloudflare',
  groq: 'gpt-oss on Groq', 'groq-small': 'gpt-oss 20B on Groq', 'groq-qwen': 'Qwen on Groq',
  cerebras: 'gpt-oss on Cerebras', 'cerebras-qwen': 'Qwen on Cerebras',
  mistral: 'Mistral Small', sambanova: 'DeepSeek on SambaNova', 'zai-flash': 'GLM Flash', vercel: 'gpt-oss on Vercel',
  openrouter: 'Nemotron Super on OpenRouter', 'openrouter-qwen': 'Dots on OpenRouter', hf: 'DeepSeek on Hugging Face',
};

export function modelTitle(id: string): string {
  const [name, key] = id.split('#');
  const said = NAMES[name] ?? (name ? name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]+/g, ' ') : id);
  return key ? `${said} (key ${key})` : said;
}
