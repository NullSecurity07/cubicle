import { wavHeader } from './wav.ts';

// Sound as numbers: how loud a bed is, measured the way broadcasters measure it, WAV in and out, and where its beats
// fall. The bed made here is measured with these, and so is every track found or dropped on a card, which is why
// they live apart from both the synthesiser and the search.

// Every bed the studio makes or hands on is at this rate, and is normalised to about this loudness so the ducking in
// `audio.ts` has room to work.
export const RATE = 44_100;
export const TARGET_LUFS = -23;

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Loudness, measured the way broadcasters measure it (ITU-R BS.1770-4), so "quiet enough to talk over" is a number
// rather than an opinion. K-weighting, four-hundred-millisecond blocks, the absolute gate and then the relative one.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function kWeighted(samples: Float32Array, rate: number): Float32Array {
  const out = Float32Array.from(samples);
  const biquad = (data: Float32Array, b0: number, b1: number, b2: number, a1: number, a2: number) => {
    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
    for (let at = 0; at < data.length; at += 1) {
      const x0 = data[at];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      data[at] = y0;
    }
  };
  // Stage one, the shelf that stands in for a head; stage two, the high-pass that stands in for not hearing the sub.
  const shelfK = Math.tan((Math.PI * 1681.974450955533) / rate);
  const shelfQ = 0.7071752369554196;
  const high = 10 ** (3.999843853973347 / 20);
  const band = high ** 0.4996667741545416;
  const shelf0 = 1 + shelfK / shelfQ + shelfK * shelfK;
  biquad(out,
    (high + (band * shelfK) / shelfQ + shelfK * shelfK) / shelf0,
    (2 * (shelfK * shelfK - high)) / shelf0,
    (high - (band * shelfK) / shelfQ + shelfK * shelfK) / shelf0,
    (2 * (shelfK * shelfK - 1)) / shelf0,
    (1 - shelfK / shelfQ + shelfK * shelfK) / shelf0);
  const passK = Math.tan((Math.PI * 38.13547087602444) / rate);
  const passQ = 0.5003270373238773;
  const pass0 = 1 + passK / passQ + passK * passK;
  biquad(out, 1, -2, 1, (2 * (passK * passK - 1)) / pass0, (1 - passK / passQ + passK * passK) / pass0);
  return out;
}

export function loudness(left: Float32Array, right: Float32Array, rate = RATE): number {
  const block = Math.round(rate * 0.4);
  const hop = Math.round(block / 4);
  if (left.length < block) return -70;
  const channels = [kWeighted(left, rate), kWeighted(right, rate)];
  const powers: number[] = [];
  for (let start = 0; start + block <= left.length; start += hop) {
    let sum = 0;
    for (const channel of channels) {
      let square = 0;
      for (let at = start; at < start + block; at += 1) square += channel[at] * channel[at];
      sum += square / block;
    }
    powers.push(sum);
  }
  if (!powers.length) return -70;
  const loud = (power: number) => -0.691 + 10 * Math.log10(Math.max(power, 1e-20));
  const above = (gate: number) => powers.filter((power) => loud(power) > gate);
  const mean = (list: number[]) => list.reduce((sum, one) => sum + one, 0) / Math.max(1, list.length);
  const first = above(-70);
  if (!first.length) return -70;
  const second = above(loud(mean(first)) - 10);
  return loud(mean(second.length ? second : first));
}

// Bring a bed to the level a narrated film wants: one gain for the whole thing (loudness moves with gain, so one pass
// is enough), then a soft ceiling so a stray peak rounds over instead of squaring off.
export function toLevel(left: Float32Array, right: Float32Array, target = TARGET_LUFS, rate = RATE): number {
  const measured = loudness(left, right, rate);
  if (measured <= -69) return 0;
  const gain = 10 ** ((target - measured) / 20);
  for (let at = 0; at < left.length; at += 1) {
    left[at] = Math.tanh((left[at] * gain) / 0.85) * 0.85;
    right[at] = Math.tanh((right[at] * gain) / 0.85) * 0.85;
  }
  return gain;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// WAV in and out. Sixteen bits, two channels: what ffmpeg, WebKit and every player on earth read without argument.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function wavOf(left: Float32Array, right: Float32Array, rate = RATE): Buffer {
  const body = Buffer.alloc(left.length * 4);
  for (let at = 0; at < left.length; at += 1) {
    body.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[at])) * 32_767), at * 4);
    body.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[at])) * 32_767), at * 4 + 2);
  }
  return Buffer.concat([wavHeader(body.length, rate, 2), body]);
}

// The samples back out of a WAV, both channels. Anything with one channel hands the same array back twice, which is
// what a mono file is.
export function pcmOf(bytes: Buffer): { left: Float32Array; right: Float32Array; rate: number } {
  const nothing = { left: new Float32Array(0), right: new Float32Array(0), rate: RATE };
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') return nothing;
  const rate = bytes.readUInt32LE(24) || RATE;
  const channels = Math.max(1, bytes.readUInt16LE(22));
  const bits = bytes.readUInt16LE(34);
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4);
    if (bytes.toString('ascii', at, at + 4) === 'data') {
      const from = at + 8;
      const bytesPer = bits / 8;
      const frames = Math.floor(Math.min(size, bytes.length - from) / (bytesPer * channels));
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      const read = (cursor: number) => (bits === 16 ? bytes.readInt16LE(cursor) / 32_768 : bits === 32 ? bytes.readFloatLE(cursor) : (bytes[cursor] - 128) / 128);
      for (let frame = 0; frame < frames; frame += 1) {
        const first = from + frame * channels * bytesPer;
        left[frame] = read(first);
        right[frame] = channels > 1 ? read(first + bytesPer) : left[frame];
      }
      return { left, right, rate };
    }
    at += 8 + size + (size % 2);
  }
  return { ...nothing, rate };
}

// One channel out of two — all the beat finder needs.
export function monoOf(bytes: Buffer): { samples: Float32Array; rate: number } {
  const { left, right, rate } = pcmOf(bytes);
  const samples = new Float32Array(left.length);
  for (let at = 0; at < left.length; at += 1) samples[at] = (left[at] + right[at]) / 2;
  return { samples, rate };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Where the beats are. The editor cuts on them, so a bed that cannot say where its beats are is half a bed.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const HOP = 512;
// How much louder each moment is than the one before it, which is as much as an onset is. Rectified: getting quieter
// is not an onset, and counting it as one finds the beat between the beats.
export function onsetsOf(samples: Float32Array): Float32Array {
  const frames = Math.max(0, Math.floor(samples.length / HOP) - 1);
  const strength = new Float32Array(frames);
  let last = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    let square = 0;
    for (let at = frame * HOP; at < (frame + 1) * HOP; at += 1) square += samples[at] * samples[at];
    const level = Math.log1p(Math.sqrt(square / HOP) * 200);
    strength[frame] = Math.max(0, level - last);
    last = level;
  }
  return strength;
}

// The pulse, found by asking the onsets how well they agree with themselves at every spacing between 60 and 180 beats
// a minute, and then asking where in the bar to start. No library: an autocorrelation is eight lines.
export function beatsOf(samples: Float32Array, rate = RATE, seconds = samples.length / rate): { bpm: number; beats: number[] } | null {
  const strength = onsetsOf(samples);
  if (strength.length < 40) return null;
  const perFrame = HOP / rate;
  const lowest = Math.round(60 / 180 / perFrame);
  const highest = Math.round(60 / 60 / perFrame);
  // With its own average taken out. An onset strength is never negative, so leaving the average in makes every lag
  // agree with every other one and the shortest lag wins whatever the music is doing.
  let average = 0;
  for (const one of strength) average += one;
  average /= strength.length;
  const swing = Float32Array.from(strength, (one) => one - average);
  const scores = new Float64Array(highest + 2);
  let best = 0;
  let bestLag = 0;
  for (let lag = lowest; lag <= highest && lag < strength.length / 2; lag += 1) {
    let sum = 0;
    for (let at = 0; at + lag < swing.length; at += 1) sum += swing[at] * swing[at + lag];
    // Longer lags have fewer terms to add up; divide by how many there were, not by how many there could be. Then
    // lean towards the tempo a person would tap: a bed with the beat only implied agrees with itself just as well at
    // half and at double, and without this it picks whichever of the three the arithmetic happened to like.
    const bpm = 60 / (lag * perFrame);
    scores[lag] = (sum / (strength.length - lag)) * Math.exp(-(Math.log2(bpm / 112) ** 2) / 0.6);
    if (scores[lag] > best) { best = scores[lag]; bestLag = lag; }
  }
  if (!bestLag || best <= 0) return null;
  // A spacing measured in whole frames is measured to eleven milliseconds, and eleven milliseconds a beat is half a
  // second by the end of a thirty-second film — so the last beats of the film would be nowhere near the music. The
  // spacing and the first beat are therefore looked for together: lay a grid at each fine spacing and each start, and
  // keep the grid that lands on the most onset. A frame either side counts, because an onset is two frames wide.
  const landsOn = (spacing: number, phase: number) => {
    let sum = 0;
    for (let at = phase; at < strength.length; at += spacing) {
      const near = Math.round(at);
      sum += Math.max(strength[near - 1] ?? 0, strength[near] ?? 0, strength[near + 1] ?? 0);
    }
    return sum;
  };
  let lag = bestLag;
  let bestPhase = 0;
  let bestScore = -1;
  for (let spacing = bestLag - 1; spacing <= bestLag + 1; spacing += 0.02) {
    for (let phase = 0; phase < Math.ceil(spacing); phase += 1) {
      const sum = landsOn(spacing, phase);
      if (sum > bestScore) { bestScore = sum; bestPhase = phase; lag = spacing; }
    }
  }
  const period = lag * perFrame;
  const beats: number[] = [];
  for (let at = bestPhase * perFrame; at < seconds; at += period) beats.push(Math.round(at * 1000) / 1000);
  return { bpm: Math.round((60 / period) * 10) / 10, beats };
}
