import { FOUNDER_BRIEF, PRESSURE_TEST_SECTION, type Vault } from '@cubicle/core';

/**
 * An adopted founder brief, written exactly the way the dispatcher's `founder_brief` case writes one: the
 * eight sections, every one of them *written* rather than left as the template's prompt, at `FOUNDER_BRIEF`,
 * by `daemon`.
 *
 * Ruling S-1 made this a precondition of planning at all, so every fixture whose subject is the plan — the
 * board, the verdict, the division fan-out, the first stream, the money step — needs one. Writing it here
 * rather than in each file keeps the shape in one place: the point of the helper is that a test which plans
 * looks like a company whose owner has signed the brief, and not like a company that found a way round the gate.
 */
export const ADOPTED_BRIEF = [
  '## What the company is', 'A meal-kit service for nurseries.',
  '## Who it is for', 'Nursery managers who cook for forty children a day.',
  '## What already exists', 'Two nurseries buying weekly, and nothing else.',
  '## What success looks like', 'Ten nurseries on a weekly order by the end of the quarter.',
  '## Constraints', 'No money beyond the owner\'s own, and no kitchen of our own.',
  '## Candidate ideas', '- [[Ideas/meal-kits]]',
  '## What we do not know', 'Whether a nursery would pay more for an allergen-checked menu.',
  PRESSURE_TEST_SECTION, 'Core Assumption: nurseries will pay per child rather than per delivery. Brutal Verdict: WEAK — the two customers we have were both introductions.',
].join('\n\n') + '\n';

/**
 * Adopt the brief in a scaffolded vault. Call it before the daemon starts, alongside `letTheBoardDecide`.
 *
 * `'daemon'` is the actor on purpose: that is who the dispatcher writes as when the owner approves the
 * proposal, and writing it as the owner would leave an `owner.edited` event that the re-planning gate reads as
 * "the owner asked for something".
 */
export function adoptFounderBrief(vault: Vault, brief = ADOPTED_BRIEF): void {
  vault.writeText(FOUNDER_BRIEF, brief, 'daemon');
}
