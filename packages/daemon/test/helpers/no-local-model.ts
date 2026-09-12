import { type Vault } from '@cubicle/core';

/**
 * Why a daemon test that starts a real `Daemon` has to clear `banned_tactics` — the B1 flake, root-caused
 * 2026-09-13.
 *
 * A test injects a fake `Llm` and believes it has cut the daemon off from every model. It has not. The fake
 * replaces the *harness's* model; `constitutionGuardrail` is built with the daemon's real `Router`
 * (`packages/daemon/src/daemon.ts`), and its last check hands any outbound copy to `classifyBannedTactic`,
 * which is `router.chat({ tier: 'local', privacy: 'local' })` — a real HTTP call to whatever local model
 * server the machine happens to be running. Four tools carry that copy (`email.send`, `social.post`,
 * `mock.outbound`, `browser.submit`), so any test that drives one of them through a live daemon leaves the
 * process.
 *
 * That call is the whole of the B1 flake. On this box it is Ollama serving `qwen2.5:7b` from a single slot
 * (`llama-server -np 1`, so concurrent suites queue behind one another), and one round trip measured 2.9 s
 * warm, 10.7 s and 22.7 s on a quiet box, and 29.5 s inside a full daemon-suite run. For every millisecond of
 * it the daemon writes **nothing** into the vault — the await sits between `agent.tool_call` and
 * `proposal.created` with no event in between — and "the daemon wrote something" is exactly how the stall
 * detector in `./load.ts` defines progress. So a perfectly healthy daemon, doing precisely what it was built
 * to do, is indistinguishable from a hung one for the length of that call, and once the call outlasts
 * 20 s × `loadScale()` the wait fails. Under the reported conditions — the suite beside a Chromium screenshot
 * run — it reproduces exactly, and this is the recorded failure verbatim:
 *
 *     waitFor: the daemon wrote nothing for 80094 ms while waiting for the ask-mode call to file its
 *     proposal and block the job (stall budget 80000 ms, 1-min load 26.58)
 *
 * The daemon was never wrong: it filed the proposal, requeued on the approval and executed the stored call
 * exactly once, every time. Neither was the stall detector wrong about what it measured. The test was wrong to
 * reach outside the process at all, for a verdict it never asserts on: no daemon test says anything about
 * banned tactics, and `classifyBannedTactic` is covered in `@cubicle/tools`' own suite against a stub router.
 * So the list goes, the guardrail resolves in-process, and the case measures only its own fakes.
 *
 * Written as `'owner'` because `Memory/constitution.md` is `never_modify` for everyone else, and before the
 * daemon starts, in `beforeEach`, beside `letTheBoardDecide`.
 */
export function noLocalModel(vault: Vault): void {
  const before = vault.readText('Memory/constitution.md');
  vault.writeText('Memory/constitution.md', before.replace(/^banned_tactics:[ \t]*\n(?:[ \t]+-[^\n]*\n)*/m, 'banned_tactics: []\n'), 'owner');
  // A template that renames the key, or writes the list some other way, must fail here and not quietly hand
  // the suite its local-model call back: the whole point of this helper is that nothing leaves the process.
  const left = vault.constitution().banned_tactics;
  if (left.length) throw new Error(`noLocalModel: banned_tactics is still ${JSON.stringify(left)}; the daemon's guardrail will call the local model and the stall detector will read that call as a hung daemon`);
}
