// A website a person proposed as a source. It waits for the founder in Needs you until they add it or drop it.
export type Proposed = { id: string; url: string; about: string; why: string; by: string; at: number };
export type Sources = {
  propose(input: Omit<Proposed, 'id' | 'at'>, existingHosts: string[]): Promise<Proposed>;
  list(): Promise<Proposed[]>;
  drop(id: string): Promise<void>;
  onChange(fn: () => void): void;
};
