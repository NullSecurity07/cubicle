import type { AllowRule, Undone } from '../../../shared/safety';

// The safety extra's own corner of the api. It is a slice, so it asks for its own paths rather than growing `api.ts`.
async function ask<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `${response.status} ${path}`);
  return response.json() as Promise<T>;
}

export const getRules = () => ask<AllowRule[]>('/api/safety/rules');
export const forgetRule = (id: string) => ask<{ ok: true }>(`/api/safety/rules/${id}`, { method: 'DELETE' });
export const undoStep = (id: string) => ask<Undone>(`/api/safety/undo/${encodeURIComponent(id)}`, { method: 'POST' });
