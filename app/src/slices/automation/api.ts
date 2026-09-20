import type { Skill, Task } from '../../../shared/model';

// This slice's own way of asking the server. A task's automation is set the way its title is — one PATCH — but these
// fields are new here, so the request for them lives beside the panel that sends it.
export type AutomationPatch = {
  repeat?: Task['repeat'] | null; script?: Task['script'] | null; skill?: string; onMissed?: 'once' | 'skip'; after?: string;
};

async function ask<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `${response.status} ${path}`);
  return response.json() as Promise<T>;
}

export const setAutomation = (boardId: string, taskId: string, patch: AutomationPatch) =>
  ask<Task>(`/api/boards/${boardId}/tasks/${taskId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
export const listSkills = () => ask<Skill[]>('/api/skills');
