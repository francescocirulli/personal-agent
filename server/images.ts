import sharp from 'sharp';

export interface ChatImage {
  name: string;
  mime: 'image/jpeg';
  data: Buffer;
}
export class ImageError extends Error {
  status = 400;
}
export async function prepareImages(files: Express.Multer.File[]): Promise<ChatImage[]> {
  if (files.length > 4) throw new ImageError('Puoi allegare al massimo 4 immagini.');
  const images: ChatImage[] = [];
  for (const file of files) {
    if (file.size > 5 * 1024 * 1024)
      throw new ImageError('Ogni immagine può occupare al massimo 5 MB.');
    try {
      const image = sharp(file.buffer, { limitInputPixels: 40_000_000, failOn: 'warning' });
      const metadata = await image.metadata();
      if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format || '')) throw new Error();
      const data = await image
        .rotate()
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 90 })
        .toBuffer();
      images.push({
        name: file.originalname.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 160) || 'Immagine',
        mime: 'image/jpeg',
        data,
      });
    } catch {
      throw new ImageError(
        'Immagine non valida. Usa PNG, JPEG, WebP o GIF (primo fotogramma), fino a 40 megapixel.',
      );
    }
  }
  return images;
}
