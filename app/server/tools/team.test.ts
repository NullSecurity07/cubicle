import { describe, expect, it } from 'vitest';
import { seedStage, type Stage } from '../../shared/model.ts';
import type { Store } from '../store.ts';
import { runTool } from './registry.ts';
import { proseCall, teamTools, type Consult } from './team.ts';

// Maya and Dev wired to each other; the colleague's answer is whatever the script says next.
function setup(...answers: string[]) {
  const stage: Stage = structuredClone(seedStage);
  stage.wires.push({ id: 'marketing-build', from: 'marketing', fromHandle: 'b', to: 'build', toHandle: 't' });
  const asked: string[] = [];
  const consult: Consult = async ({ question }) => { asked.push(question); return answers.shift() ?? ''; };
  const context = { stage, roomId: 'marketing', store: {} as Store, granted: new Map<string, string>() };
  const ask = () => runTool(teamTools(consult), 'ask_person', JSON.stringify({ name: 'Dev', question: 'Is the stage ready?' }), context);
  return { asked, ask };
}

const CALLED = '<tool_call>\n<function=ask_founder>\n<parameter=question>What did you build before?</parameter>\n</function>\n</tool_call>';

describe('asking a colleague', () => {
  it('knows a tool call written out as words from an answer', () => {
    for (const said of [CALLED, '<function=ask_founder>{"question": "why?"}</function>', '{"name": "ask_founder", "arguments": {"question": "why?"}}',
      '```json\n{"name": "read_doc", "parameters": {"doc": "Evaluation"}}\n```', '**ask_founder**{"question": "why?"}']) {
      expect(proseCall(said), said).toBe(true);
    }
    for (const said of ['Yes, the stage is ready.', 'Small models sometimes print <tool_call> tags instead of calling; ignore those.', 'The JSON {"name": "x"} is in the doc.', 'Use a function= style flag.', '{"price": 19}']) expect(proseCall(said), said).toBe(false);
  });

  it('passes a plain answer through', async () => {
    const { asked, ask } = setup('Yes, it shipped on Friday.');
    expect(await ask()).toMatchObject({ ok: true, text: 'Dev answered:\nYes, it shipped on Friday.' });
    expect(asked).toHaveLength(1);
  });

  it('asks again once when the colleague wrote a tool call instead of answering, and uses the second answer', async () => {
    const { asked, ask } = setup(CALLED, 'Yes, it shipped on Friday.');
    expect(await ask()).toMatchObject({ ok: true, text: 'Dev answered:\nYes, it shipped on Friday.' });
    expect(asked).toHaveLength(2);
  });

  it('says the colleague did not answer, rather than passing a written tool call on as their answer', async () => {
    const { asked, ask } = setup(CALLED, '{"name": "ask_founder", "arguments": {"question": "x"}}');
    const out = await ask();
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/Dev did not answer/);
    expect(out.text).not.toContain('ask_founder');
    expect(asked).toHaveLength(2);
  });
});
