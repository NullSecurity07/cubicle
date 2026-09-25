import type { AllowRule, Undone } from '../../../shared/safety';
import { request as ask } from '../../api';

// The safety extra's own corner of the api. It is a slice, so it asks for its own paths rather than growing `api.ts`.

export const getRules = () => ask<AllowRule[]>('/api/safety/rules');
export const forgetRule = (id: string) => ask<{ ok: true }>(`/api/safety/rules/${id}`, { method: 'DELETE' });
export const undoStep = (id: string) => ask<Undone>(`/api/safety/undo/${encodeURIComponent(id)}`, { method: 'POST' });
