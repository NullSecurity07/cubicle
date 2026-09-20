import { createAutomation, fillAutomation } from '../automation/run.ts';
import type { Slice } from '../install.ts';

// A board that gets on with things by itself: schedules the founder types in words, work that is a script rather than
// a person, one task starting the next, a skill in front of the work, and a look at all of it before anything is spent.
// The run path holds all of that; this is where it is handed the playbook, the models and the shared files folder.
export default {
  name: 'automation',
  install(deps) {
    fillAutomation(createAutomation({
      boards: deps.boards, filesDir: deps.store.filesDir, skills: deps.skills, clients: deps.clients, notify: deps.notify, runs: deps.runs,
    }));
    return { async close() { fillAutomation(null); } };
  },
} satisfies Slice;
