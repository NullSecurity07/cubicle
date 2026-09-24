import { createCompaction } from '../context/compact.ts';
import { offered } from '../context/offer.ts';
import { createShrinking } from '../context/shrink.ts';
import type { Slice } from '../install.ts';

// Long work that does not fall over. Two halves of the same thing: a person is offered only the tools their own room
// can use, and a piece of work that outgrows the smallest model is shortened inside the turn instead of failing.
export default {
  name: 'context',
  // First of the extras: every slice after this one narrows a shorter list.
  order: 10,
  install(deps) {
    // A check script hands round stub deps with no seams in them. The offering half still holds without them, and
    // half a feature is better than a slice that refuses to install.
    if (deps.seams) {
      const compaction = createCompaction(deps);
      // Every tool result is made smaller at the door first; compaction then only has what is left to fit.
      deps.seams.on('step:before', createShrinking(deps));
      deps.seams.on('step:before', compaction.before);
      deps.seams.on('step:error', compaction.error);
    }
    return { offer: offered };
  },
} satisfies Slice;
