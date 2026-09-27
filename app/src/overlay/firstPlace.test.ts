import { describe, expect, it } from 'vitest';
import type { DashDay } from '../../shared/dashboard';
import type { TodayItem } from '../../shared/today';
import { firstPlace } from './firstPlace';

const item = (id: string, more: Partial<TodayItem> = {}): TodayItem => ({ id, kind: 'decision', title: id, reason: '', why: '', score: 1, ...more });
const day = (more: Partial<DashDay>): Pick<DashDay, 'needsYou' | 'decisionsPending' | 'tasksDue' | 'tasksRunning'> =>
  ({ needsYou: [], decisionsPending: [], tasksDue: [], tasksRunning: [], ...more });
const need = (id: string, decisionId?: string) => ({ id, kind: 'proposed-decision' as const, title: id, at: 1, ...(decisionId ? { decisionId } : {}) });
const decision = (id: string) => ({ id, title: id, at: 1 });
const task = (id: string) => ({ id, title: id, cardId: 'board', at: 1 });

describe('each thing on the dashboard in the first section it belongs to', () => {
  it('drops from Needs you and Decisions what Today\'s five already shows', () => {
    const shown = firstPlace([item('need-1', { decisionId: 'd1' })], day({ needsYou: [need('need-1', 'd1'), need('need-2', 'd2')], decisionsPending: [decision('d1'), decision('d2'), decision('d3')] }));
    expect(shown.needsYou.map((one) => one.id)).toEqual(['need-2']);
    // d2 is in Needs you, which comes first; only d3 is left for Decisions.
    expect(shown.decisionsPending.map((one) => one.id)).toEqual(['d3']);
  });

  it('matches a decision in Today\'s five by its decision, whatever the row\'s own id', () => {
    const shown = firstPlace([item('decision:d1', { decisionId: 'd1' })], day({ needsYou: [need('n1', 'd1')], decisionsPending: [decision('d1')] }));
    expect(shown.needsYou).toEqual([]);
    expect(shown.decisionsPending).toEqual([]);
  });

  it('drops a task Today\'s five already names, due or running', () => {
    const shown = firstPlace([item('task-due:t1:5', { kind: 'task-due', taskId: 't1' })], day({ tasksDue: [task('t1'), task('t2')], tasksRunning: [task('t1')] }));
    expect(shown.tasksDue.map((one) => one.id)).toEqual(['t2']);
    expect(shown.tasksRunning).toEqual([]);
  });

  it('keeps everything while Today\'s five has not been read', () => {
    const whole = day({ needsYou: [need('n1', 'd1')], decisionsPending: [decision('d1'), decision('d2')] });
    const shown = firstPlace(null, whole);
    expect(shown.needsYou).toEqual(whole.needsYou);
    expect(shown.decisionsPending.map((one) => one.id)).toEqual(['d2']);
  });
});
