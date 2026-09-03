import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode 8-bit RGBA pixels as a PNG (one IDAT, filter type 0 on every row).
 * Deliberately dependency-free: the vault only ever needs a generated placeholder image.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) throw new Error(`encodePng: expected ${width * height * 4} bytes of RGBA, got ${rgba.length}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** A solid square of `outer` with a centred half-size square of `inner`; both are `#rrggbb`. */
export function placeholderSquare(size: number, outer: string, inner: string): Buffer {
  const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const [or, og, ob] = rgb(outer);
  const [ir, ig, ib] = rgb(inner);
  const px = new Uint8Array(size * size * 4);
  const lo = Math.floor(size / 4);
  const hi = size - lo;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const isInner = x >= lo && x < hi && y >= lo && y < hi;
      const o = (y * size + x) * 4;
      px[o] = isInner ? ir : or;
      px[o + 1] = isInner ? ig : og;
      px[o + 2] = isInner ? ib : ob;
      px[o + 3] = 255;
    }
  }
  return encodePng(size, size, px);
}
