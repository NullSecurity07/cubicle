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
// And the third: when one skill is plainly the one for this piece of work, it is written out in full rather than
// offered. A small free model told to go and read something first does not go and read it — live, with a skill
// scoring 0.59 against the question and the rule in front of it, the person answered without ever calling use_skill.
// So the floor decides what is worth naming and this decides what is worth putting in front of them. It sits above
// the fixture questions that only half wanted a skill (0.33 and 0.38) and below the ones that plainly did (0.59
// live, 0.73 and 0.75 on the fixtures), so a person is handed a procedure only when it is really theirs to follow.
export const SKILL_FLOOR = 0.3;
export const SKILL_MATCH = 0.58;
export const SKILL_INLINE = 0.45;
const SHOWN = 4;
// A prompt is not a panel: past this the block is taking room from the founder's own documents, so the one-line
// mentions are dropped from the end until it fits. The skill written out in full is never cut.
const MOST_CHARS = 2000;
const HEAD = 'Your company playbook: what the people here learned doing this kind of work before.';
const FOLLOW = 'Follow this one; it is how this kind of work was done well before. You do not need to look it up, it is written out above.';
const OTHERS = 'Others that may fit — read one with use_skill before you start:';
const LEARN = 'When the founder asks you to learn how something was done, it is recorded after your reply; confirm in one line.';

// One skill as the founder reads it in the panel, under the same four headings.
const written = (skill: Skill) => [
  skill.name, `When: ${skill.when}`, `What to do:\n${skill.procedure.map((step, at) => `${at + 1}. ${step}`).join('\n')}`,
  skill.pitfalls.length ? `Watch out for:\n${skill.pitfalls.map((one) => `- ${one}`).join('\n')}` : '', `Done when: ${skill.verify}`, FOLLOW,
].filter(Boolean).join('\n');

// The skills nearest to a piece of text, best first, one entry each however many passages matched.
export async function nearestSkills(recall: Recall, query: string, top: number): Promise<Hit[]> {
  const hits = await recall.search(query, { kinds: ['skill'], top: top * 2 });
  const best = new Map<string, Hit>();
  for (const hit of hits) if (!best.has(hit.id)) best.set(hit.id, hit);
  return [...best.values()].slice(0, top);
}

// The last block of a person's system message: the handful of skills that have something to do with what was just
// asked, and the one that plainly is, written out. Nothing above the floor means no block at all, because a playbook
// shown when it does not apply teaches people to ignore it.
// A skill whose steps call for a tool this person was not offered this turn is a procedure they cannot follow:
// putting it in front of them only teaches them to pretend. `tools` is every tool name the app has, so a word in a
// step is only taken for a tool when it really is one; the turn says what it offered as `offered` on its payload.
// A turn that says nothing about what it offered is shown every skill, as before.
export type Offered = { offered?: string[] };
const followable = (skill: Skill, all: Set<string>, offered?: string[]) => {
  if (!offered) return true;
  const mine = new Set(offered);
  return !skill.procedure.some((step) => (step.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []).some((word) => all.has(word) && !mine.has(word)));
};

export function createPlaybook(deps: { skills: Skills; recall: Recall; tools?: () => string[] }) {
  return {
    before: (async (payload, next) => {
      const offered = (payload as Offered).offered;
      const all = new Set(deps.tools?.() ?? []);
      const [system, ...rest] = payload.messages;
      if (system?.role !== 'system') return next(payload);
      const hits = (await nearestSkills(deps.recall, payload.query, SHOWN * 2)).filter((hit) => hit.score >= SKILL_FLOOR);
      if (!hits.length) return next(payload);
      const known = new Map((await deps.skills.list()).filter((skill) => skill.state === 'active' && followable(skill, all, offered)).map((skill) => [skill.id, skill]));
      const fitting = hits.flatMap((hit) => { const skill = known.get(hit.id); return skill ? [{ skill, score: hit.score }] : []; }).slice(0, SHOWN);
      if (!fitting.length) return next(payload);
      const inlined = fitting[0].score >= SKILL_INLINE ? fitting[0].skill : null;
      const named = (inlined ? fitting.slice(1) : fitting).map((one) => `- ${one.skill.name}: ${one.skill.when}`);
      let block = '';
      for (let keep = named.length; ; keep -= 1) {
        block = [HEAD, inlined ? `\n${written(inlined)}` : '', keep ? `\n${OTHERS}\n${named.slice(0, keep).join('\n')}` : '', `\n${LEARN}`].join('\n');
        if (block.length <= MOST_CHARS || !keep) break;
      }
      // Put in front of them is used: they did not have to go and find it, and the curator should not set aside
      // what is earning its place in every prompt.
      if (inlined) await deps.skills.used(inlined.id).catch(() => {});
      return next({ ...payload, messages: [{ ...system, content: `${system.content}\n\n${block}` }, ...rest] });
    }) satisfies Handler<'turn:before'>,
  };
}
