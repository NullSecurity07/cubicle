import { createHash } from 'node:crypto';

// The one way the studio names a thing by what it is: a SHA-256 cut to `length` hex characters. Every key it makes
// — a picture in the cache, a kept storyboard, a line or a picture in a film's record — stays exactly the string it
// was before this was shared, because a changed key is a cache that forgets everything it holds.
export const digestOf = (text: string, length: number): string => createHash('sha256').update(text).digest('hex').slice(0, length);

// Several parts at once, as JSON, so ["a b", "c"] and ["a", "b c"] are never the same thing.
export const hashOf = (length: number, ...parts: unknown[]): string => digestOf(JSON.stringify(parts), length);
