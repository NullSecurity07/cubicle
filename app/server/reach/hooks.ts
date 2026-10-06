import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { now as clockNow } from '../clock.ts';

// A megabyte is more than any sensible call in, and small enough that a flood costs this machine nothing.
export const BODY_LIMIT = 1_000_000;
// How far a call's own clock may be from this one's. Past that, it is somebody replaying an old one.
export const WINDOW = 300_000;
const DAY = 86_400_000;
export const SIGNATURE = 'x-cubicle-signature';
export const TIMESTAMP = 'x-cubicle-timestamp';
export const DELIVERY = 'x-cubicle-delivery';

export const newSecret = () => randomBytes(32).toString('hex');
// What the sender signs: the moment, a dot, and the body exactly as it was sent. The moment is inside the signature,
// so an old call cannot be replayed with a new clock reading.
export const sign = (secret: string, at: number | string, body: string | Buffer) => createHmac('sha256', secret).update(`${at}.`).update(body).digest('hex');

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';

// The gate on `/api/hooks/:id`, which the app's own guard lets through because this is what stands in its place.
// Everything a caller could get wrong is answered the same way: a short reason, and nothing that says whether the
// hook or the secret was the part that was wrong.
export function createHooks(now: () => number = clockNow) {
  const seen = new Map<string, number>();
  return {
    // Returns why the call is refused, or null when it may go on.
    check(secret: string, body: Buffer, headers: IncomingMessage['headers']): string | null {
      const at = Number(one(headers[TIMESTAMP]));
      if (!Number.isFinite(at) || !at) return 'this call is not stamped with a time';
      // Seconds or milliseconds: a sender that counts in seconds is still telling the truth.
      const moment = at < 1e12 ? at * 1000 : at;
      if (Math.abs(now() - moment) > WINDOW) return 'this call is too old or too far ahead';
      const given = one(headers[SIGNATURE]).trim().replace(/^sha256=/, '');
      if (!given || !same(given, sign(secret, one(headers[TIMESTAMP]).trim(), body))) return 'this call is not signed for this hook';
      const delivery = one(headers[DELIVERY]).trim();
      if (delivery) {
        for (const [id, when] of seen) if (now() - when > DAY) seen.delete(id);
        if (seen.has(delivery)) return 'already done';
        seen.set(delivery, now());
      }
      return null;
    },
    // Only for the tests and for telling the founder how much is remembered.
    remembered: () => seen.size,
  };
}

// The body, read by hand rather than through the app's json helper: a signature covers the bytes that were sent,
// so they are what has to be weighed and hashed.
export async function rawBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('that call is too big');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
