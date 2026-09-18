// Raw images in assets/raw become the WebP files the stage loads.
// Rooms: 720x528 is twice the 360x264 card body. Wallpapers: up to 3840 wide, never enlarged.
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const pick = process.argv[2] ?? 'b'; // which wallpaper candidate becomes the default

await mkdir('public/rooms', { recursive: true });
await mkdir('assets/candidates', { recursive: true });

for (const room of ['founder', 'marketing', 'build']) {
  await sharp(`assets/raw/${room}.png`)
    .resize(720, 528, { fit: 'cover', position: 'centre' })
    .webp({ quality: 86 })
    .toFile(`public/rooms/${room}.webp`);
}

for (const letter of ['a', 'b', 'c']) {
  const source = `assets/raw/wallpaper-${letter}.jpg`;
  const { width, height } = await sharp(source).metadata();
  const trim = 0.02; // museum scans keep a sliver of the picture frame at the edges
  const image = sharp(source)
    .extract({ left: Math.round(width * trim), top: Math.round(height * trim), width: Math.round(width * (1 - 2 * trim)), height: Math.round(height * (1 - 2 * trim)) })
    .resize({ width: 3840, withoutEnlargement: true })
    .webp({ quality: 82 });
  await image.clone().toFile(`assets/candidates/wallpaper-${letter}.webp`);
  if (letter === pick) await image.clone().toFile('public/wallpaper.webp');
}

console.log(`done; default wallpaper = ${pick}`);
