// The keys the app knows, as the Keys panel shows them. A value never comes back from the server: only whether there
// is one and, for a long one, its last four characters.
export type KeyState = 'set' | 'missing' | 'failing';
export type KeyRow = {
  name: string; group: string; label: string; where?: string; state: KeyState;
  // The last four characters, for a value long enough that four give nothing away.
  tail?: string;
  // More keys for the same provider (NAME_2, NAME_3): each is another day of free answers.
  spares: number;
  // Read only when the app starts; `pending` when what is in .env now is not what the app started with.
  restart: boolean; pending: boolean;
  // Set in the environment the app was started from. That value wins over .env, so writing .env changes nothing.
  shell: boolean;
  // Why the last check with this key failed.
  problem?: string;
};
export type KeysView = { file: string; rows: KeyRow[]; checkedAt: number | null };

// Where backups could go: the folder they go to now, the one they go to when nothing is chosen, and the drives and
// synced folders this machine has that a founder would most likely pick.
export type BackupPlaces = { current: string; custom: boolean; fallback: string; places: { label: string; path: string }[] };
