import type { DashProvider } from '../../shared/dashboard';
import { compact } from '../numbers';

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const grouped = (value: number) => Math.round(value).toLocaleString('en-GB');

// One model's day under its meter. A model on Cloudflare's free pool also says the account's neurons of the 9,000 the
// turns may spend, pictures included, because that pool, not its own count, is what usually runs out first.
export function providerLine(one: DashProvider): string {
  const replies = one.neurons && one.limits.rpd ? `${one.usedToday.requests} of ${plural(one.limits.rpd, 'reply', 'replies')}` : plural(one.usedToday.requests, 'reply', 'replies');
  const tokens = `${compact(one.usedToday.tokens)} tokens${one.limits.tpd ? ` of ${compact(one.limits.tpd)}` : ''}`;
  const neurons = one.neurons
    ? `${grouped(one.neurons.used)} of ${grouped(one.neurons.of)} neurons${one.neurons.drawn ? `, ${grouped(one.neurons.pictures)} of them on ${plural(one.neurons.drawn, 'picture')}` : ''}`
    : '';
  return [replies, tokens, neurons, one.window].filter(Boolean).join(' · ');
}
