// What a colleague hands back when a whole piece of work was given to them. Only this comes back to whoever asked:
// `summary` in their own words, `changed` naming what really moved (a document, a file, a task), and `blocked` saying
// what stopped them when they did not finish.
export type Handover = { done: boolean; summary: string; changed: string[]; blocked?: string };
