import type { BackupPlaces, KeysView } from '../../../shared/keys-file';
import { request as ask, send } from '../../api';

// This slice's own paths. A value goes out once, when the founder saves it, and never comes back.
export const getKeys = () => ask<KeysView>('/api/keys-file');
export const setKey = (name: string, value: string) => ask<KeysView>(`/api/keys-file/${name}`, send('PUT', { value }));
export const checkKeys = () => ask<KeysView>('/api/keys-file/check', send('POST'));
export const getPlaces = () => ask<BackupPlaces>('/api/keys-file/places');
