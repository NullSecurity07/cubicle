// The microphone for a whole conversation. The ask box's microphone decodes what it heard in the page, which suits a
// sentence; a call of half an hour is kept as the browser recorded it (Opus in WebM) and sent up whole, and the
// server turns it into what the transcriber reads.
export type Taking = { stop(): Promise<Blob>; cancel(): void; level(): number; name: string };

export async function startRecording(): Promise<Taking> {
  // No echo cancelling: on a call played through the speakers, the other person's voice is the "echo" it would take out.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
  const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((one) => MediaRecorder.isTypeSupported(one)) ?? '';
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : {});
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  // In pieces, so a long call is never one buffer the browser has to hold twice at the end.
  recorder.start(5000);

  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const close = () => { for (const track of stream.getTracks()) track.stop(); void context.close(); };
  const ext = (recorder.mimeType || type).includes('ogg') ? 'ogg' : 'webm';

  return {
    name: `call.${ext}`,
    // How loud it is right now, 0 to 1, on a curve that makes ordinary talking fill about half the meter.
    level() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const one of samples) sum += one * one;
      return Math.min(1, Math.sqrt(sum / samples.length) * 4);
    },
    cancel() { if (recorder.state !== 'inactive') recorder.stop(); close(); },
    stop: () => new Promise<Blob>((done) => {
      recorder.onstop = () => { close(); done(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })); };
      recorder.stop();
    }),
  };
}
