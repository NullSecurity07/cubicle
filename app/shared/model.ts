// The plain model both sides agree on. The client maps it to React Flow; the server stores it.
export type Box = { x: number; y: number; w: number; h: number };
export type Room = Box & { id: string; name: string; role: string; accent: string; brief: string };
export type Doc = Box & { id: string; title: string };
export type Wire = { id: string; from: string; fromHandle: string; to: string; toHandle: string };
export type Stage = { rooms: Room[]; docs: Doc[]; wires: Wire[] };
export type ChatMessage = { role: 'user' | 'assistant'; text: string; at: number; provider?: string };
export type ChatEvent = { token: string } | { done: true; provider: string } | { error: string };

export const STANCE =
  'You work for the founder. You boost the founder; you do not run the company. Be concise. Offer options when '
  + 'there is a real choice. Ask when the request is unclear. Never claim an action outside this chat. '
  + 'You know about the founder, the product, the customers and the numbers only what this chat and the connected '
  + 'documents say. Do not invent such facts; when you need one, ask for it.';

export const seedStage: Stage = {
  rooms: [
    { id: 'marketing', name: 'Maya', role: 'Marketing', accent: '#ee8a72', brief: 'You are the marketing lead: positioning, copy, launch, audience.', x: 0, y: 0, w: 380, h: 440 },
    { id: 'build', name: 'Dev', role: 'Build', accent: '#4e8cff', brief: 'You are the engineering lead: architecture, scope, build order, technical risk.', x: 0, y: 500, w: 380, h: 440 },
  ],
  docs: [{ id: 'brand-doc', title: 'Brand doc', x: 520, y: 40, w: 340, h: 300 }],
  wires: [{ id: 'marketing-brand-doc', from: 'marketing', fromHandle: 'r', to: 'brand-doc', toHandle: 'l' }],
};

export const seedDocs: Record<string, string> = {
  'brand-doc': '# Brand\n\nWhat we are building:\n\nWho it is for:\n\nVoice:\n',
};
