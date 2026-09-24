import { describe, expect, it } from 'vitest';
import { cardLine, holdsTheCard, makeRoom, NEEDS_MB, readCard, whatWentWrong, whoHolds, type Smi } from './gpu-room.ts';

// Room on the graphics card. Nothing here asks the real card or the real Ollama: nvidia-smi and Ollama's API are both
// played by the test, from what they said on the founder's machine on 2026-09-24.

// A card whose memory goes down by what is let go of.
function card(start: { used: number; total?: number }, apps = '') {
  let used = start.used;
  const smi: Smi = async (args) => (args[0].startsWith('--query-gpu') ? `${used}, ${start.total ?? 4096}\n` : apps);
  return { smi, free: (mb: number) => { used -= mb; } };
}

function ollama(models: { name: string; size_vram: number }[], onUnload: (name: string) => void = () => {}) {
  const calls: { url: string; body?: string }[] = [];
  const http = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as string | undefined });
    if (url.endsWith('/api/ps')) return new Response(JSON.stringify({ models }));
    onUnload((JSON.parse(String(init?.body)) as { model: string }).model);
    return new Response('{}');
  }) as unknown as typeof fetch;
  return { http, calls };
}

const quick = { sleep: async () => {}, waitMs: 50 };

describe('making room on the graphics card', () => {
  it('reads the card and who holds it the way nvidia-smi says it', async () => {
    const { smi } = card({ used: 3019 }, '707990, ~/.local/share/dictate/bin/python, 78 MiB\n1234, /usr/bin/ollama, 2500\n');
    expect(await readCard(smi)).toEqual({ used: 3019, total: 4096 });
    expect(await whoHolds(smi)).toEqual([{ pid: 707990, name: 'python', mb: 78 }, { pid: 1234, name: 'ollama', mb: 2500 }]);
    expect(await cardLine(smi)).toBe('the graphics card has 1.1 GB of 4.0 GB free');
  });

  it('says nothing and touches nothing when there is room, or no NVIDIA card to ask', async () => {
    const lines: string[] = [];
    const { http, calls } = ollama([{ name: 'qwen2.5:7b', size_vram: 2.5 * 1024 ** 3 }]);
    await makeRoom(NEEDS_MB.picture, (line) => lines.push(line), { smi: card({ used: 100 }).smi, fetch: http, env: {}, ...quick });
    await makeRoom(NEEDS_MB.picture, (line) => lines.push(line), { smi: async () => null, fetch: http, env: {}, ...quick });
    expect(lines).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('unloads the chat model Ollama is resting on the card, and says so in one line', async () => {
    const gpu = card({ used: 3019 });
    const { http, calls } = ollama([{ name: 'qwen2.5:7b', size_vram: 2.5 * 1024 ** 3 }], () => gpu.free(2560));
    const lines: string[] = [];
    await makeRoom(NEEDS_MB.picture, (line) => lines.push(line), { smi: gpu.smi, fetch: http, env: {}, ...quick });
    expect(lines).toEqual(['Made room on the graphics card: unloaded qwen2.5:7b (2.5 GB)']);
    // Only what /api/ps listed, and only its weights: the server itself stays up.
    expect(calls.map((one) => one.url)).toEqual(['http://127.0.0.1:11434/api/ps', 'http://127.0.0.1:11434/api/generate']);
    expect(JSON.parse(calls[1].body!)).toEqual({ model: 'qwen2.5:7b', keep_alive: 0 });
  });

  it('asks a worker of ours to let go too, and names who holds the card when it is still full', async () => {
    let running = true;
    holdsTheCard({ name: 'OmniVoice', release: () => { const was = running; running = false; return was; }, pids: () => [4242] });
    const gpu = card({ used: 3019 }, '4242, /home/x/app/.cache/omnivoice/.venv/bin/python, 2400\n');
    const lines: string[] = [];
    const trying = makeRoom(NEEDS_MB.picture, (line) => lines.push(line), { smi: gpu.smi, fetch: ollama([]).http, env: {}, ...quick });
    await expect(trying).rejects.toThrow('Not enough room on the graphics card: 1.1 GB free, 2.1 GB needed; python (OmniVoice) holds 2.3 GB');
    expect(lines).toEqual(['Made room on the graphics card: unloaded the OmniVoice worker']);
    expect(running).toBe(false);
  });

  it('leaves Ollama alone when the founder says so, and says that is why', async () => {
    const gpu = card({ used: 3019 }, '1234, /usr/bin/ollama, 2500\n');
    const { http, calls } = ollama([{ name: 'qwen2.5:7b', size_vram: 2.5 * 1024 ** 3 }]);
    const trying = makeRoom(NEEDS_MB.clip, () => {}, { smi: gpu.smi, fetch: http, env: { STAGE_KEEP_OLLAMA: '1' }, ...quick });
    await expect(trying).rejects.toThrow(/; ollama holds 2\.4 GB\. Ollama is kept loaded because STAGE_KEEP_OLLAMA=1/);
    expect(calls).toEqual([]);
  });

  it('only says so, without stopping, for a job that has somewhere else to go', async () => {
    const lines: string[] = [];
    await makeRoom(NEEDS_MB.voice, (line) => lines.push(line), { smi: card({ used: 3900 }).smi, fetch: ollama([]).http, env: {}, soft: true, ...quick });
    expect(lines.at(-1)).toMatch(/^Not enough room on the graphics card: 0\.2 GB free, 2\.4 GB needed/);
  });
});

describe('what the renderer said when it went wrong', () => {
  it('puts the line that names the cause ahead of the generic last one', () => {
    const said = [
      'model manager cannot make enough memory available on Vulkan1: need 2124.76 MB device / 1612.76 MB budget, available 1076.69 MB device',
      'z_image segment 1/36 (z_image.prelude) failed during weight preparation',
      'generate failed',
    ];
    expect(whatWentWrong(said, 400)).toBe(`${said[0]}; generate failed`);
    expect(whatWentWrong(['load failed', 'ErrorDeviceLost', 'generate failed'])).toBe('ErrorDeviceLost; generate failed');
    expect(whatWentWrong(['generate failed'])).toBe('generate failed');
  });
});
