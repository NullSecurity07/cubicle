import type { ProvidersFile } from './config.js';

/** Ollama embeddings via POST /api/embed (verified 2026-09-02, returns { embeddings: number[][] }). */
export async function embedTexts(config: ProvidersFile, texts: string[], fetchImpl: typeof fetch = fetch): Promise<number[][]> {
  const p = config.providers.find((x) => x.enabled && x.embeddings);
  if (!p || !p.embeddings) throw new Error('No embeddings provider configured');
  const base = p.base_url.replace(/\/v1\/?$/, '');
  const url = p.embeddings.endpoint ?? `${base}/api/embed`;
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: p.embeddings.id, input: texts }) });
  if (!res.ok) throw new Error(`embed failed: HTTP ${res.status}`);
  const j = (await res.json()) as { embeddings?: number[][]; error?: string };
  if (!j.embeddings) throw new Error(`embed failed: ${j.error ?? 'no embeddings in response'}`);
  return j.embeddings;
}

export function cosine(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
