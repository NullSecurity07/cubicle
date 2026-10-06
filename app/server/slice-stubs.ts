import { createApprovals } from './approvals.ts';
import { createAttention } from './attention.ts';
import { createBoards } from './boards.ts';
import { createDecisions } from './decisions.ts';
import { createFounder } from './founder.ts';
import { lateRuns, type Deps } from './install.ts';
import { createMemory } from './memory.ts';
import { createRecall, wordEmbedder } from './recall.ts';
import { createSeams } from './seams.ts';
import { createSkills } from './skills.ts';
import { createStore } from './store.ts';
import { createUnasked, createUsage } from './usage.ts';

// Everything a slice may reach for, real but small and empty, on a throwaway workspace: what `pnpm check:providers`
// and the unit test that installs the whole `server/slices` folder both hand round. A slice only installs when it is
// given the real things it listens to, and stubs that were too thin once left the dashboard out without anybody
// noticing, so this is one list both of them share. `fake` keeps every slice away from the outside world.
export function stubDeps(workspace: string, root: string): Deps {
  const store = createStore(workspace);
  const usage = createUsage(null);
  return {
    workspace, root, fake: true, store, seams: createSeams(), clients: [], usage, unasked: createUnasked({ path: null, usage, clients: () => [] }),
    approvals: createApprovals(), attention: createAttention(workspace), boards: createBoards(workspace),
    recall: createRecall({ dir: workspace, embed: wordEmbedder, gather: async () => [] }),
    skills: createSkills(workspace), founder: createFounder(workspace), memory: createMemory(store, async () => ''), decisions: createDecisions(workspace),
    busy: new Set(), notify: () => {}, promptFor: async () => [], json: () => {}, body: async () => ({}),
    own: { ports: [], token: '' }, runs: lateRuns().runs, toolsFor: () => [],
  };
}
