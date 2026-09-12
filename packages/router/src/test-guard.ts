/**
 * Repo-wide test isolation for model providers.
 *
 * **Why this exists.** A test that injects a fake `Llm` looks completely cut off from every model server and
 * is not. B1 (root-caused 2026-09-13) found the whole `@cubicle/daemon` suite making a real `qwen2.5:7b`
 * inference call through Ollama on **every run** — against a standing "cloud only, no local-model runs"
 * decision — because the fake replaced the *harness's* model while the constitution guardrail held the
 * daemon's real `Router`. The fix for that one path was to clear the constitution list the guardrail read.
 * This is the general answer: the *transport* refuses, so no future caller can open the same hole by
 * reaching for a `Router` from somewhere the suite's fakes do not cover.
 *
 * **What it does.** Once armed (by a vitest setup file), `assertProviderAllowed` throws before any HTTP
 * client is built for a provider whose base URL the test did not explicitly allow. The message names the
 * test, so the failure says which case reached outside the process rather than appearing as a timeout
 * minutes later somewhere else.
 *
 * **How a test opts in.** Two ways, both deliberate:
 *
 * - `allowProviderBaseUrl(url)` — a test that stands up its **own** stub server on a loopback port and points
 *   a real `Router` at it. That is not a real provider; it is the test's own process answering.
 * - `CUBICLE_TEST_REAL_PROVIDERS=1` in the environment — the handful of live scripts and `CUBICLE_LIVE=1`
 *   cases that exist precisely to talk to a real model. The guard is never armed in that process.
 *
 * Deliberately dependency-free: this module is loaded by every package's vitest setup, including the viewer,
 * which has no `@cubicle/*` dependency at all.
 */

/** Set this to `1` to let a process talk to real providers under test. For live scripts only. */
export const REAL_PROVIDERS_ENV = 'CUBICLE_TEST_REAL_PROVIDERS';

interface Guard {
  /** The name of the test currently running, for the refusal message. */
  currentTest: () => string;
  /** Origins (`https://host:port`) a test has vouched for as its own stub. */
  allowed: Set<string>;
}

let guard: Guard | null = null;

/** `https://host:port`, or the raw string when it does not parse as a URL. */
function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

/**
 * Arm the guard for this process. Called from the vitest setup file, never from product code.
 * `currentTest` is read lazily, at the moment of the refusal, so it names the case that actually reached out.
 */
export function armProviderGuard(currentTest: () => string): void {
  guard = { currentTest, allowed: new Set() };
}

/** Disarm it. For the guard's own tests; a suite has no reason to call this. */
export function disarmProviderGuard(): void {
  guard = null;
}

/** True while the guard is armed — so a test can assert that its own setup file ran. */
export function providerGuardArmed(): boolean {
  return guard !== null;
}

/**
 * Vouch for one base URL as the test's own stub server, and get back an undo. Use it in `beforeAll`, right
 * after the stub is listening, so the allowance names a port this process opened itself.
 */
export function allowProviderBaseUrl(url: string): () => void {
  const origin = originOf(url);
  guard?.allowed.add(origin);
  return () => { guard?.allowed.delete(origin); };
}

/**
 * Refuse, loudly and immediately, if this process is under an armed guard and `baseUrl` is not one the test
 * vouched for. Called from every place a provider connection is opened (`makeClient`, `embedTexts`).
 */
export function assertProviderAllowed(baseUrl: string, providerId: string): void {
  if (!guard) return;
  const origin = originOf(baseUrl);
  if (guard.allowed.has(origin)) return;
  const test = guard.currentTest();
  throw new Error(
    `${test} tried to open a real provider connection (provider "${providerId}" at ${origin}). ` +
    'Tests never reach a model server: a fake Llm does not cover the constitution guardrail, which holds the ' +
    'real Router, and a suite that calls out is slow, non-deterministic and spends the owner\'s quota. ' +
    `Point the Router at a stub in this process and vouch for it with allowProviderBaseUrl(baseUrl), or — for a ` +
    `live script that is meant to call out — run it with ${REAL_PROVIDERS_ENV}=1.`,
  );
}
