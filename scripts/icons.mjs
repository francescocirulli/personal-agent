// Rasterize the existing code-native app mark without external image services.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([length, t, data, crc]);
}
for (const [size, name] of [
  [192, 'icon-192.png'],
  [512, 'icon-512.png'],
  [180, 'apple-touch-icon.png'],
]) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = (x / size) * 192,
        py = (y / size) * 192;
      const bars = [
        [52, 84, 108],
        [74, 61, 131],
        [96, 44, 148],
        [118, 65, 127],
        [140, 83, 109],
      ];
      const on = bars.some(
        ([cx, lo, hi]) => Math.hypot(px - cx, py - Math.max(lo, Math.min(hi, py))) <= 6,
      );
      const pos = y * (size * 4 + 1) + 1 + x * 4;
      pixels.set(on ? [236, 236, 236, 255] : [33, 33, 33, 255], pos);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  writeFileSync(
    `public/${name}`,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
