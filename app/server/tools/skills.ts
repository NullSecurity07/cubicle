import { bodyOf, type Skills } from '../skills.ts';
import { text, type Tool } from './registry.ts';

// Reading the playbook. The prompt carries one line a skill; this is where a person opens the one that fits and finds
// out how it was done last time. Whatever a skill describes, every step in it still stops at the founder's approval.
export function skillTools(skills: Skills): Tool[] {
  return [{
    name: 'use_skill',
    perTurn: 2,
    description: 'Read one skill from the company playbook in full: the steps, what to watch out for, and how to tell it worked. Use it when a line of the playbook above fits what you are about to do, before you start. Following a skill does not give you permission for anything: every step still asks the founder as it always would.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'The name of the skill, exactly as the playbook lists it' } }, required: ['name'] },
    async run(args) {
      const wanted = text(args, 'name', 120).trim().toLowerCase();
      const all = await skills.list();
      const skill = all.find((one) => one.state !== 'off' && (one.name.toLowerCase() === wanted || one.id === wanted))
        ?? all.find((one) => one.state !== 'off' && one.name.toLowerCase().includes(wanted));
      if (!skill) return { text: `There is no skill called "${wanted}" in the playbook.${all.length ? ` There is: ${all.filter((one) => one.state !== 'off').map((one) => one.name).join(', ')}.` : ''}` };
      await skills.used(skill.id);
      return { text: bodyOf(skill) };
    },
  }];
}
