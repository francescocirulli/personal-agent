import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';

export interface ChatFile {
  name: string;
  mime: string;
  data: Buffer;
}
export class FileError extends Error {
  status = 400;
}
export const documentTypes: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
};
export function safeName(name: string) {
  return name.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 160) || 'documento';
}
export function prepareDocuments(files: Express.Multer.File[]): ChatFile[] {
  return files.map((file) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = documentTypes[ext];
    if (!mime) throw new FileError('Usa PDF, DOCX, XLSX, CSV, TXT, Markdown o JSON.');
    if (file.size > 20 * 1024 * 1024)
      throw new FileError('Ogni documento può occupare al massimo 20 MB.');
    if (ext === '.pdf' && !file.buffer.subarray(0, 1024).includes(Buffer.from('%PDF-')))
      throw new FileError('Il PDF non è valido.');
    if (['.docx', '.xlsx'].includes(ext) && file.buffer.subarray(0, 2).toString() !== 'PK')
      throw new FileError('Il documento Office non è valido. Usa DOCX o XLSX.');
    return { name: safeName(file.originalname), mime, data: file.buffer };
  });
}
export async function extractDocument(file: ChatFile, signal?: AbortSignal): Promise<string> {
  const ext = path.extname(file.name).toLowerCase();
  if (!['.pdf', '.docx', '.xlsx'].includes(ext)) return file.data.toString('utf8').slice(0, 200000);
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [
        '--max-old-space-size=256',
        fileURLToPath(new URL('./document-extract.mjs', import.meta.url)),
        ext,
      ],
      { timeout: 20000, maxBuffer: 2 * 1024 * 1024, signal, env: { PATH: process.env.PATH } },
      (error, stdout) => {
        if (error)
          return resolve(
            'Estrazione non disponibile: documento non leggibile, protetto o troppo complesso. Esamina il file originale; non inventare il contenuto.',
          );
        try {
          resolve(
            JSON.parse(stdout).text ||
              'Nessun testo estraibile. Il documento potrebbe contenere scansioni: esamina il file originale.',
          );
        } catch {
          resolve('Estrazione non disponibile. Esamina il file originale.');
        }
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(file.data);
  });
}
export async function stageDocuments(
  root: string,
  files: (ChatFile & { id: string })[],
  signal?: AbortSignal,
) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const entries = [];
  for (const file of files) {
    signal?.throwIfAborted();
    const original = path.join(root, `${file.id}-${safeName(file.name)}`);
    await writeFile(original, file.data, { mode: 0o600 });
    const extracted = original + '.extracted.txt';
    await writeFile(extracted, await extractDocument(file, signal), { mode: 0o600 });
    entries.push({ name: file.name, original, text: extracted });
  }
  return entries;
}
export async function collectExports(
  root: string,
): Promise<{ files: ChatFile[]; warnings: string[] }> {
  const files: ChatFile[] = [],
    warnings: string[] = [];
  let total = 0;
  // Refuse a directory replaced by the agent with a link outside the designated location.
  const actual = await realpath(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!actual) return { files, warnings };
  if (actual !== path.resolve(root))
    return { files, warnings: ['Cartella dei file prodotti non valida.'] };
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile()) {
      warnings.push(`${entry.name}: sono accettati solo file diretti, senza link o sottocartelle.`);
      continue;
    }
    const handle = await open(
      path.join(root, entry.name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size > 20 * 1024 * 1024 ||
        files.length >= 10 ||
        total + stat.size > 80 * 1024 * 1024
      ) {
        warnings.push(
          `${entry.name}: limite di esportazione superato (20 MB per file, 10 file, 80 MB totali).`,
        );
        continue;
      }
      const data = Buffer.alloc(stat.size);
      let read = 0;
      while (read < data.length) {
        const result = await handle.read(data, read, data.length - read, read);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      total += read;
      files.push({
        name: safeName(entry.name),
        mime: documentTypes[path.extname(entry.name).toLowerCase()] || 'application/octet-stream',
        data: data.subarray(0, read),
      });
    } finally {
      await handle.close();
    }
  }
  return { files, warnings };
}
