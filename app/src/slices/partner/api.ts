import type { Bet, BetVerdict, MorningNote } from '../../../shared/partner';
import { request, send } from '../../api';

// The partner's own corner of the api. It is a slice, so it asks for its own paths rather than growing `api.ts`.
export type PartnerView = { partner: { roomId: string; name: string } | null; companyId: string | null; morning: MorningNote | null; bets: Bet[] };

export const getPartner = () => request<PartnerView>('/api/partner');
export const askMorning = () => request<MorningNote>('/api/partner/morning', send('POST', {}));
export const morningDone = () => request<{ ok: true }>('/api/partner/morning/done', send('POST', {}));
export const answerBet = (id: string, accept: boolean) => request<{ ok: true }>(`/api/partner/bets/${encodeURIComponent(id)}`, send('POST', { accept }));
export const closeBet = (id: string, verdict: BetVerdict) => request<Bet>(`/api/partner/bets/${encodeURIComponent(id)}/close`, send('POST', { verdict }));
export const answerPlan = (id: string, accept: boolean) => request<{ ok: true; added?: number }>(`/api/partner/plans/${encodeURIComponent(id)}`, send('POST', { accept }));
