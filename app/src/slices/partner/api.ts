import type { Bet, BetVerdict, MorningNote } from '../../../shared/partner';
import { request, send } from '../../api';

// The partner's own corner of the api. It is a slice, so it asks for its own paths rather than growing `api.ts`.
export type PartnerView = { partner: { roomId: string; name: string } | null; companyId: string | null; morning: MorningNote | null; bets: Bet[] };

export const getPartner = () => request<PartnerView>('/api/partner');
export const askMorning = () => request<MorningNote & { unchanged?: true }>('/api/partner/morning', send('POST', {}));
export const morningDone = () => request<{ ok: true }>('/api/partner/morning/done', send('POST', {}));
export const answerBet = (id: string, accept: boolean) => request<{ ok: true }>(`/api/partner/bets/${encodeURIComponent(id)}`, send('POST', { accept }));
export const closeBet = (id: string, verdict: BetVerdict) => request<Bet>(`/api/partner/bets/${encodeURIComponent(id)}/close`, send('POST', { verdict }));
export const answerPlan = (id: string, accept: boolean, makeBoard = false) => request<{ ok: true; added?: number }>(`/api/partner/plans/${encodeURIComponent(id)}`, send('POST', { accept, ...(makeBoard ? { makeBoard } : {}) }));
// A colleague's doc the partner flagged: Fix hands back the ask to send in their room, Ignore lets it go.
export const answerReview = (id: string, fix: boolean) => request<{ ok: true; roomId?: string; ask?: string }>(`/api/partner/reviews/${encodeURIComponent(id)}`, send('POST', { fix }));
// A promise the founder made: done, or dropped.
export const closePromise = (id: string, done: boolean) => request<{ status: string }>(`/api/partner/promises/${encodeURIComponent(id)}`, send('POST', { done }));
