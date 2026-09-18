import { projectDir, type Coder } from '../coder.ts';
import { wired } from '../prompt.ts';
import { text, type Tool, type ToolContext } from './registry.ts';

const project = (context: ToolContext) => {
  const cards = (context.stage.cards ?? []).filter((one) => one.kind === 'project');
  const [id] = wired(context.stage, context.roomId, cards.map((one) => one.id));
  return cards.find((one) => one.id === id);
};

// Real development work goes to a coding harness that runs inside the project folder the founder wired to this person.
export function projectTools(coder: Coder, forbidden: string[]): Tool[] {
  return [{
    name: 'delegate_coding',
    perTurn: 1,
    description: 'Hand a coding task to a coding agent that works inside the project folder connected to your room: it reads the code, edits files and runs commands there, then reports. '
      + 'Write the task as a complete brief: the goal, the files or area, how to check it works. It knows nothing of this chat. The founder approves the task before it starts.',
    parameters: { type: 'object', properties: { task: { type: 'string', description: 'The full brief for the coding agent' } }, required: ['task'] },
    ready: () => null,
    async approval(_args, context) {
      const card = project(context);
      return card && card.kind === 'project' ? `Start this coding task in ${card.path || '(no folder set)'}?` : null;
    },
    async run(args, context) {
      const card = project(context);
      if (!card || card.kind !== 'project') throw new Error('no project card is connected to your room. Ask the founder to add one from the dock, set its folder and draw a wire to it.');
      const dir = projectDir(card.path, forbidden);
      const result = await coder({ dir, task: text(args, 'task', 8000), signal: context.signal, onLine: (line) => context.report?.({ kind: 'project-progress', id: card.id, line }) });
      const files = result.changed.length ? `\nChanged: ${result.changed.slice(0, 30).join(', ')}` : '\nNo files changed.';
      if (!result.ok) throw new Error(`${result.summary}${files}`);
      return { text: `${result.summary}${files}`, effect: { kind: 'project-progress', id: card.id, line: `done · ${result.changed.length} file${result.changed.length === 1 ? '' : 's'} changed` } };
    },
  }];
}
