import type { Skills } from './skills.ts';

const DAY = 86_400_000;
export const STALE_DAYS = 30;
export const GONE_DAYS = 120;

// What keeps the playbook worth reading. A skill nobody has reached for in a month goes quiet: out of every prompt,
// still in the panel, still there to switch back on. Three months quiet and it goes to trash, where nothing is lost.
// A skill the founder edited is theirs and never ages, however long it sits unused.
export function createCurator(skills: Skills, now: () => number = Date.now) {
  let swept = 0;

  async function sweep(): Promise<{ stale: string[]; gone: string[] }> {
    const done = { stale: [] as string[], gone: [] as string[] };
    for (const skill of await skills.list()) {
      if (skill.editedByFounder) continue;
      const idle = now() - (skill.usedAt ?? skill.createdAt);
      if (skill.state === 'stale' && idle > GONE_DAYS * DAY) { await skills.remove(skill.id); done.gone.push(skill.id); }
      else if (skill.state === 'active' && idle > STALE_DAYS * DAY) { await skills.setState(skill.id, 'stale'); done.stale.push(skill.id); }
    }
    swept = now();
    return done;
  }

  return {
    sweep,
    // Called from the same half-minute tick as the runs; it does the work once a day and costs nothing the rest of the time.
    async tick() { return now() - swept < DAY ? null : sweep(); },
  };
}
