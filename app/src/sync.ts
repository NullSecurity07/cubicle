import { createContext, useContext } from 'react';

// Cards call this before anything that needs the server to know the stage as it is right now
// (a new person, a fresh wire): it saves at once instead of waiting for the quiet-period save.
export const SyncContext = createContext<() => Promise<void>>(async () => {});
export const useFlushStage = () => useContext(SyncContext);
