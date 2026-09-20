import type React from 'react';
import type { ChatMessage, ToolEvent } from '../../shared/model';
import type { Command } from '../overlay/commands';

// The same idea as the server's slices, lighter: a feature the founder can see is a folder in here with a
// `slice.tsx` in it, default-exporting this. Nothing in a slice edits `Overlay.tsx` or `commands.ts` — both of them
// read this list instead. A slice imports its own stylesheet from its own files.
// `overlay` is mounted once, above the canvas, for as long as the window is open: it shows and hides itself.
// `receipt` is drawn at the foot of every opened tool receipt, so a slice can offer what to do about one step (put it
// back, say it again); it decides for itself which calls it has anything to say about, and draws nothing otherwise.
// `reply` is drawn quietly at the foot of every finished reply, beside the message's own actions; `compose` inside the
// ask box, beside the paper clip, where it may put words into the draft the founder is about to send. Both are for
// what belongs in the conversation itself rather than in a view of its own. Each draws nothing when it has nothing
// to offer, so a slice that is switched off costs the founder no pixel at all.
export type UiSlice = {
  name: string; commands?: Command[]; overlay?: React.ComponentType; receipt?: React.ComponentType<{ tool: ToolEvent }>;
  reply?: React.ComponentType<{ message: ChatMessage; roomId: string }>;
  compose?: React.ComponentType<{ roomId: string; insert(text: string): void; busy: boolean }>;
};

// Vite reads the folder while it builds, so a slice that is not there costs nothing at all, and an empty folder is
// an empty object. It has to be written out in full, exactly like this: Vite and vitest both replace the whole
// `import.meta.glob(...)` call while they transform the file, and a guard around it (`import.meta.glob?.(…)`) leaves
// the name behind for them to trip over. Anything that runs this file outside them would need its own build step.
const found = import.meta.glob('./*/slice.tsx', { eager: true }) as Record<string, { default?: UiSlice }>;

// By path, so the order on screen is the order in the folder rather than whatever the bundler felt like.
export const SLICES: UiSlice[] = Object.keys(found).sort().flatMap((path) => (found[path].default ? [found[path].default] : []));
export const sliceCommands = (): Command[] => SLICES.flatMap((one) => one.commands ?? []);
