import type { Hit, Skill } from '../shared/model.ts';
import type { createRecall } from './recall.ts';
import type { Handler } from './seams.ts';
import type { Skills } from './skills.ts';

export type Recall = ReturnType<typeof createRecall>;

// Recall scores a passage between 0 and 1: seven parts what it means, three parts the words it shares. Both numbers
// below were read off three fixture skills on the word embedder, which is the noisier of the two embedders and so the
// harder case. The floor sits above what an unrelated question scores against a skill it has nothing to do with
// (0.25 there) and below the weakest question that really wanted one (0.32).
// The match is what says two skills are the same skill. Reworded copies of a fixture scored 0.63 and 0.66 against
// their original; two skills about quite different work that happen to open the same way ("When the founder asks
// for …") reached 0.53, and one about neighbouring work 0.43. It sits in that gap, nearer the copies, because the
// two mistakes are not the same size: a duplicate is in the panel where the founder can merge or delete it, and a
// lesson thrown away is gone without anybody knowing it was there. The model is shown the three nearest skills
// before it writes, so the usual end of a near-duplicate is a patch and this is only the backstop.
// The word embedder is a stand-in and it counts words: two skills whose names are mostly small common words score
// high against each other whatever they are about. That is the reason for the doctrine's "when" — "When a customer
// has not paid and the due date has passed" scores 0.24 against an unrelated skill, "When the founder asks for
// <the title of the task>" scores 0.61 against the same one. The real embedder reads meaning and does not need it.
export const SKILL_FLOOR = 0.3;
export const SKILL_MATCH = 0.58;
const SHOWN = 4;
const RULE = 'If one fits, read it with use_skill before you start. When the founder asks you to learn how something was done, it is recorded after your reply; confirm in one line.';

// The skills nearest to a piece of text, best first, one entry each however many passages matched.
export async function nearestSkills(recall: Recall, query: string, top: number): Promise<Hit[]> {
  const hits = await recall.search(query, { allow: (piece) => piece.kind === 'skill', top: top * 2 });
  const best = new Map<string, Hit>();
  for (const hit of hits) if (!best.has(hit.id)) best.set(hit.id, hit);
  return [...best.values()].slice(0, top);
}

// The last block of a person's system message: the handful of skills that have something to do with what was just
// asked. Nothing above the floor means no block at all, because a playbook shown when it does not apply teaches
// people to ignore it.
export function createPlaybook(deps: { skills: Skills; recall: Recall }) {
  return {
    before: (async (payload, next) => {
      const hits = (await nearestSkills(deps.recall, payload.query, SHOWN * 2)).filter((hit) => hit.score >= SKILL_FLOOR);
      if (!hits.length) return next(payload);
      const known = new Map((await deps.skills.list()).filter((skill) => skill.state === 'active').map((skill) => [skill.id, skill]));
      const fitting = hits.flatMap((hit) => (known.has(hit.id) ? [known.get(hit.id)!] : [])).slice(0, SHOWN);
      if (!fitting.length) return next(payload);
      const block = `Your company playbook: what the people here learned doing this kind of work before.\n${fitting.map((skill: Skill) => `- ${skill.name}: ${skill.when}`).join('\n')}\n${RULE}`;
      const [system, ...rest] = payload.messages;
      if (system?.role !== 'system') return next(payload);
      return next({ ...payload, messages: [{ ...system, content: `${system.content}\n\n${block}` }, ...rest] });
    }) satisfies Handler<'turn:before'>,
  };
}
