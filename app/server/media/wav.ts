// The one WAV header the studio writes and the one way it reads how long a WAV plays. Both used to be written out
// in each file that needed them — the voice, the music and the talking heads — and were identical to the byte.
//
// Reading the samples back is not here, and on purpose: `pcmOf` in music.ts keeps both channels and reads 32-bit
// samples as floats, `readPcm` in film-record.ts mixes to one channel and reads 32-bit samples as floats only when
// the format says so. Folding either into the other would change what a bed or a remade narration sounds like.

// The 44 bytes in front of plain 16-bit PCM samples, `channels` of them interleaved.
export function wavHeader(bodyBytes: number, rate: number, channels: 1 | 2): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + bodyBytes, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2 * channels, 28);
  header.writeUInt16LE(2 * channels, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bodyBytes, 40);
  return header;
}

// How long a WAV plays, read out of the file itself. A video's scenes are as long as the line spoken over them, and
// a talking head is asked for exactly the line it must say.
export function wavSeconds(bytes: Buffer): number {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') return 0;
  const rate = bytes.readUInt32LE(24);
  const perSample = (bytes.readUInt16LE(22) * bytes.readUInt16LE(34)) / 8;
  // The samples are not always the first chunk after the format: walk the chunks until 'data'.
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4);
    if (bytes.toString('ascii', at, at + 4) === 'data') return rate && perSample ? Math.min(size, bytes.length - at - 8) / (rate * perSample) : 0;
    at += 8 + size + (size % 2);
  }
  return 0;
}
