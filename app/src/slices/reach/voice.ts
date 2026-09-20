import { useSyncExternalStore } from 'react';
import type { ReachState } from '../../../shared/reach';
import { LISTEN_RATE } from '../../../shared/reach';
import { getReach, speaking } from './api';

// The microphone, the one voice that is playing, and whether the founder has switched any of this on. All three live
// here rather than in a screen: there is one microphone and one pair of speakers, however many replies are on the
// stage, and leaving a card while something is speaking must not leave a voice running behind it.
export type Recording = { stop: () => Promise<Float32Array>; cancel: () => void };
export const VOICE_SIZE = '310 MB';
export const EARS_SIZE = 'about 150 MB';

const watchers = new Set<() => void>();
const tell = () => { for (const one of watchers) one(); };
const subscribe = (one: () => void) => { watchers.add(one); return () => { watchers.delete(one); }; };

// Asked for once, however many replies are on screen, and told again by the settings screen whenever it changes.
let on: boolean | null = null;
let asking: Promise<void> | null = null;
export const voiceIs = (state: ReachState) => { if (on !== state.voice) { on = state.voice; tell(); } };
export function useVoiceOn(): boolean {
  if (on === null) asking ??= getReach().then(voiceIs).catch(() => { on = false; tell(); });
  return useSyncExternalStore(subscribe, () => on === true, () => false);
}

// Which reply is speaking, so that the one that is stops when another starts and every button tells the truth.
let saying = '';
export const useSaying = () => useSyncExternalStore(subscribe, () => saying, () => '');
// Said once per launch: the models behind this are fetched the first time they are used, and that is worth knowing
// before pressing rather than after.
let spokenBefore = false;
let heardBefore = false;
export const spokenOnce = () => spokenBefore;
export const heardOnce = () => heardBefore;

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
        heardBefore = true;
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

export function quiet() {
  playing?.pause();
  playing = null;
  if (saying) { saying = ''; tell(); }
}

export async function say(key: string, text: string): Promise<void> {
  quiet();
  saying = key;
  tell();
  try {
    let url = said.get(key);
    if (!url) {
      url = URL.createObjectURL(await speaking(text));
      said.set(key, url);
      spokenBefore = true;
    }
    const sound = new Audio(url);
    playing = sound;
    sound.onended = () => { if (playing === sound) quiet(); };
    sound.onerror = () => { if (playing === sound) quiet(); };
    await sound.play();
  } catch (error) {
    quiet();
    throw error;
  }
}
