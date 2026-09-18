// Raw images in assets/raw become the WebP files the stage loads.
// Rooms: 720x528 is twice the 360x264 card body. Wallpapers: up to 3840 wide, never enlarged.
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const pick = process.argv[2] ?? 'c'; // which wallpaper candidate becomes the default

await mkdir('public/rooms', { recursive: true });
await mkdir('assets/candidates', { recursive: true });

for (const room of ['founder', 'marketing', 'build']) {
  await sharp(`assets/raw/${room}.png`)
    .resize(720, 528, { fit: 'cover', position: 'centre' })
    .webp({ quality: 86 })
    .toFile(`public/rooms/${room}.webp`);
}

for (const letter of ['a', 'b', 'c']) {
  const image = sharp(`assets/raw/wallpaper-${letter}.jpg`)
    .resize({ width: 3840, withoutEnlargement: true })
    .webp({ quality: 82 });
  await image.clone().toFile(`assets/candidates/wallpaper-${letter}.webp`);
  if (letter === pick) await image.clone().toFile('public/wallpaper.webp');
}

console.log(`done; default wallpaper = ${pick}`);
