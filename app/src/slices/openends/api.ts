import type { Skill } from '../../../shared/model';
import type { Backups, Check, Insights, Outside } from '../../../shared/openends';
import { request as ask, send } from '../../api';

// This slice's own paths. It asks for nothing the panels do not show.
const post = (body?: unknown) => send('POST', body);

export const getHealth = () => ask<{ checks: Check[] }>('/api/health').then((held) => held.checks);
export const getBackups = () => ask<Backups>('/api/backups');
export const makeBackup = () => ask<Backups & { dropped: number }>('/api/backups', post());
export const getOutside = () => ask<Outside>('/api/outside');
export const markSafe = (name: string, safe: boolean) => ask<Outside>('/api/outside/safe', post({ name, safe }));
export const getInsights = (days: number) => ask<Insights>(`/api/insights?days=${days}`);
export const bringInSkill = (text: string) => ask<Skill>('/api/skill-files', post({ text }));
export const skillAsFile = (id: string) => ask<{ file: string; text: string }>(`/api/skill-files/${id}`);

// A file the founder picked, and a file the founder takes away. Both stay on this machine.
export const readPicked = (file: File) => file.text();
export function saveAs(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
