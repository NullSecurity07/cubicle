import type { Skill } from '../../../shared/model';
import type { BackupPlaces } from '../../../shared/keys-file';
import type { ActResult, Backups, Check, Insights, Outside } from '../../../shared/openends';
import { request as ask, send } from '../../api';

// This slice's own paths. It asks for nothing the panels do not show.
const post = (body?: unknown) => send('POST', body);

export const getHealth = () => ask<{ checks: Check[] }>('/api/health').then((held) => held.checks);
// A row's one button (Runs while closed: Turn on): what it came to, and the row as it is now.
export const actOn = (path: string) => ask<ActResult>(path, post());
export const getBackups = () => ask<Backups>('/api/backups');
export const makeBackup = () => ask<Backups & { dropped: number }>('/api/backups', post());
// Where backups go: the places this machine has, and the folder written into .env through the keys route, which makes
// it ready before it is written down. An empty folder is the default again.
export const getBackupPlaces = () => ask<BackupPlaces>('/api/keys-file/places');
export const backUpTo = (folder: string) => ask<unknown>('/api/keys-file/STAGE_BACKUP_DIR', send('PUT', { value: folder }));
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
