/**
 * The repo-wide test isolation guard (`src/test-guard.ts`), and the proof that it is actually armed in this
 * process — which is the half that matters, because a guard nobody installed looks exactly like a guard
 * nothing tripped.
 */
import { describe, it, expect } from 'vitest';
import { openMemoryDb } from '@cubicle/core';
import { parseProvidersConfig } from '../src/config.js';
import { QuotaTracker } from '../src/quota.js';
import { Router } from '../src/router.js';
import { makeClient } from '../src/client.js';
import { embedTexts } from '../src/embeddings.js';
import { allowProviderBaseUrl, providerGuardArmed, assertProviderAllowed, REAL_PROVIDERS_ENV } from '../src/test-guard.js';

/** The shipped local floor's real address — what a suite reaches when nothing stops it. */
const OLLAMA = parseProvidersConfig(`
cascade: [ollama]
providers:
  - id: ollama
    base_url: http://localhost:11434/v1
    privacy: local
    timeout_ms: 300000
    embeddings: { id: nomic-embed-text }
    models:
      - { id: qwen2.5:7b, tier: local, tools: json }
`);

describe('the repo-wide provider guard', () => {
  it('is armed in this process — the setup file really did run', () => {
    expect(providerGuardArmed()).toBe(true);
  });

  it('refuses an unvouched provider and names the test that reached out', () => {
    let err: Error | null = null;
    try { makeClient(OLLAMA.providers[0], {}); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    // The name of *this* case, so a failure says which one left the process.
    expect(err!.message).toContain('names the test that reached out');
    expect(err!.message).toContain('localhost:11434');
    expect(err!.message).toContain('ollama');
    // And it says how to get past it deliberately, in both of the two legitimate ways.
    expect(err!.message).toContain('allowProviderBaseUrl');
    expect(err!.message).toContain(REAL_PROVIDERS_ENV);
  });

  it('stops a real Router before a single byte leaves — the hole B1 found', async () => {
    const db = openMemoryDb();
    const router = new Router(OLLAMA, new QuotaTracker(db), { env: {} });
    // The exact request the constitution guardrail's classifier used to make: keyless local provider, so the
    // cascade has a candidate and nothing else would have stopped it.
    await expect(router.chat({ tier: 'local', needsTools: false, privacy: 'local' }, { messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/tried to open a real provider connection/);
    db.close();
  });

  it('closes the embeddings door too', async () => {
    await expect(embedTexts(OLLAMA, ['hello'])).rejects.toThrow(/tried to open a real provider connection/);
  });

  it('lets a test vouch for its own stub, by origin, and take the allowance back', () => {
    const undo = allowProviderBaseUrl('http://127.0.0.1:59999/v1');
    // Vouching is per origin, so every path under that host and port is covered by the one allowance.
    expect(() => assertProviderAllowed('http://127.0.0.1:59999/v1/chat/completions', 'stub')).not.toThrow();
    expect(() => assertProviderAllowed('http://127.0.0.1:59998/v1', 'stub')).toThrow();  // a different port is not
    undo();
    expect(() => assertProviderAllowed('http://127.0.0.1:59999/v1', 'stub')).toThrow();
  });
});
