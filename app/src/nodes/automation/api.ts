import type { Task } from '../../../shared/model';
import { request, send } from '../../api';

// The automation panel's own way of asking the server. A task's automation is set the way its title is — one PATCH — but these
// fields are new here, so the request for them lives beside the panel that sends it.
export type AutomationPatch = {
  repeat?: Task['repeat'] | null; script?: Task['script'] | null; skill?: string; onMissed?: 'once' | 'skip'; after?: string;
};

export const setAutomation = (boardId: string, taskId: string, patch: AutomationPatch) =>
  request<Task>(`/api/boards/${boardId}/tasks/${taskId}`, send('PATCH', patch));
