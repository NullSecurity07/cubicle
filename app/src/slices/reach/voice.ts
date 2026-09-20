import { LISTEN_RATE } from '../../../shared/reach';
import { speaking } from './api';

// The microphone, and the one voice that is playing. Both live here rather than in a screen, so that leaving a view
// while something is speaking cannot leave a voice running behind it.
export type Recording = { stop: () => Promise<Float32Array>; cancel: () => void };

// Recorded in whatever the browser likes, then turned into what the model here expects: one channel at 16 kHz.
export async function record(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  recorder.start();
  const close = () => { for (const track of stream.getTracks()) track.stop(); };
  return {
    cancel: () => { if (recorder.state !== 'inactive') recorder.stop(); close(); },
    stop: () => new Promise<Float32Array>((done, fail) => {
      recorder.onstop = async () => {
        close();
        try { done(await samplesOf(new Blob(chunks, { type: recorder.mimeType }))); } catch (error) { fail(error as Error); }
      };
      recorder.stop();
    }),
  };
}

// The browser already knows how to read every format its own microphone writes, and how to resample: this asks it to.
async function samplesOf(clip: Blob): Promise<Float32Array> {
  const context = new AudioContext();
  try {
    const sound = await context.decodeAudioData(await clip.arrayBuffer());
    const room = new OfflineAudioContext(1, Math.max(1, Math.ceil(sound.duration * LISTEN_RATE)), LISTEN_RATE);
    const source = room.createBufferSource();
    source.buffer = sound;
    source.connect(room.destination);
    source.start();
    return (await room.startRendering()).getChannelData(0);
  } finally {
    void context.close();
  }
}

// One voice at a time, and the same words are only ever made once.
const said = new Map<string, string>();
let playing: HTMLAudioElement | null = null;

export const quiet = () => { playing?.pause(); playing = null; };

export async function say(key: string, text: string, onEnd: () => void): Promise<void> {
  quiet();
  let url = said.get(key);
  if (!url) {
    url = URL.createObjectURL(await speaking(text));
    said.set(key, url);
  }
  const sound = new Audio(url);
  playing = sound;
  sound.onended = () => { if (playing === sound) playing = null; onEnd(); };
  sound.onerror = () => { if (playing === sound) playing = null; onEnd(); };
  await sound.play();
}
