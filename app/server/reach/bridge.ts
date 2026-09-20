import type { ChatEvent } from '../../shared/model.ts';

export type Bridge = ReturnType<typeof createBridge>;

// A message from the phone is a message from the founder, so it takes the founder's own road: the app asks itself,
// over this machine's loopback, exactly as the window does. Nothing about a turn is rebuilt here — the person is
// busy or free, the seams fire, the reply is stored in their conversation, an outward step still asks — because
// this is that same route, holding this launch's token the way any script must.
export function createBridge(deps: { port: number; token: string; http?: typeof fetch }) {
  const http = deps.http ?? fetch;
  return async function ask(roomId: string, text: string, signal?: AbortSignal): Promise<string> {
    const response = await http(`http://127.0.0.1:${deps.port}/api/rooms/${encodeURIComponent(roomId)}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-stage-token': deps.token }, body: JSON.stringify({ text, via: 'phone' }), signal,
    });
    // A refusal (unknown room, this person is still replying) comes back as plain json, not as a stream.
    if (!response.ok || !response.body) throw new Error((await response.json().catch(() => null) as { error?: string } | null)?.error ?? `the app answered ${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let said = '';
    let problem = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        if (!frame.startsWith('data: ')) continue;
        const event = JSON.parse(frame.slice(6)) as ChatEvent;
        if ('token' in event) said += event.token;
        if ('error' in event) problem = event.error;
        // The stored message is the whole truth of what was said, tokens and all.
        if ('done' in event) said = event.message.text || said;
      }
    }
    if (problem && !said.trim()) throw new Error(problem);
    return said;
  };
}
