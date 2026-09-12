/**
 * The repo-wide vitest setup file. Every package's vitest config points `setupFiles` at this one path — each
 * package's own `vitest.config.ts`, the viewer's `vite.config.ts`, and the root acceptance config — so there
 * is exactly one copy of the rule and no package can quietly be left out of it.
 *
 * It lives beside the router's `src/` rather than inside it because it imports `vitest`, and nothing that
 * ships in `dist/` should. It is loaded by path, not by package name, so a package that does not depend on
 * `@cubicle/router` (the viewer) can still use it; `src/test-guard.ts` is dependency-free for the same reason.
 *
 * What it enforces, and why, is written down in `src/test-guard.ts`.
 */
import { expect } from 'vitest';
import { armProviderGuard, REAL_PROVIDERS_ENV } from './src/test-guard.js';

if (process.env[REAL_PROVIDERS_ENV] !== '1') {
  // Read lazily: `currentTestName` is whatever is running at the moment of the refusal, which is the case
  // that reached outside the process — not whatever was running when this file loaded.
  armProviderGuard(() => {
    const name = expect.getState().currentTestName;
    return name ? `The test "${name}"` : 'A test file (outside any test case)';
  });
}
