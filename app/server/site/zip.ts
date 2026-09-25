import { crc32, deflateRawSync } from 'node:zlib';

// A zip writer of our own, because a founder downloading a website expects a .zip that opens with a double click on
// any machine, and nothing in the app wrote one. It is the plain form: one local header and the data for each file,
// then the central directory, then its end record. Text is deflated; pictures and fonts, already compressed, are
// stored as they are. Names are UTF-8 and flagged so. No zip64: a one-page site is nowhere near four gigabytes.
export type Entry = { name: string; bytes: Buffer; at?: number };

const STORED = /\.(png|jpe?g|webp|gif|woff2?|zip|gz|mp4|webm)$/i;

// The MS-DOS date and time a zip keeps, in local time as the format has always had it.
function dosTime(at: number): { time: number; date: number } {
  const day = new Date(at);
  const year = Math.max(1980, day.getFullYear());
  return {
    time: (day.getHours() << 11) | (day.getMinutes() << 5) | Math.floor(day.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((day.getMonth() + 1) << 5) | day.getDate(),
  };
}

export function zip(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/^\/+/, ''), 'utf8');
    if (!name.length || entry.name.includes('..')) throw new Error(`bad name in a zip: ${entry.name}`);
    const store = STORED.test(entry.name) || entry.bytes.length < 64;
    const body = store ? entry.bytes : deflateRawSync(entry.bytes, { level: 9 });
    const sum = crc32(entry.bytes) >>> 0;
    const { time, date } = dosTime(entry.at ?? Date.now());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(0x0314, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(store ? 0 : 8, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(date, 14);
    head.writeUInt32LE(sum, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(entry.bytes.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
