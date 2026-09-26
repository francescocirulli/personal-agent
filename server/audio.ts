import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config';
export class AudioService {
  private pending = new Map<string, Promise<string>>();
  constructor(private config: Config) {}
  get pcm() {
    return this.config.ttsModel.startsWith('google/');
  }
  get mime() {
    return this.pcm ? 'audio/wav' : 'audio/mpeg';
  }
  async transcribe(buffer: Buffer, mime: string, signal: AbortSignal) {
    if (!this.config.audioKey)
      throw new Error('Voce non configurata: aggiungi OPENROUTER_API_KEY sul server.');
    const formats: Record<string, string> = {
      'audio/webm': 'webm',
      'audio/mp4': 'm4a',
      'video/mp4': 'm4a',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
    };
    const format = formats[mime.split(';')[0]];
    if (!format) throw new Error('Formato audio non supportato.');
    const res = await fetch(`${this.config.audioBase}/audio/transcriptions`, {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(65000)]),
      headers: {
        Authorization: `Bearer ${this.config.audioKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.sttModel,
        input_audio: { data: buffer.toString('base64'), format },
        language: 'it',
        response_format: 'json',
      }),
    });
    if (!res.ok)
      throw new Error(
        `Trascrizione non riuscita (${res.status}). Controlla chiave, credito e modello voce.`,
      );
    const result = (await res.json()) as { text?: string };
    if (!result.text?.trim())
      throw new Error('Non ho riconosciuto parole. Prova a parlare di nuovo.');
    return result.text.trim().slice(0, 40000);
  }
  async speech(text: string): Promise<string> {
    if (!this.config.audioKey)
      throw new Error('Voce non configurata: aggiungi OPENROUTER_API_KEY sul server.');
    const key = createHash('sha256')
      .update(
        JSON.stringify([this.config.audioBase, this.config.ttsModel, this.config.voice, text]),
      )
      .digest('hex');
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = this.generate(key, text).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  async read(key: string) {
    return readFile(this.filePath(key));
  }
  filePath(key: string) {
    return path.join(this.config.dataDir, 'audio', `${key}.${this.pcm ? 'wav' : 'mp3'}`);
  }
  private async generate(key: string, text: string) {
    try {
      await this.read(key);
      return key;
    } catch {
      /* Generate on cache miss. */
    }
    const parts = text.match(/[\s\S]{1,3000}(?:\s|$)|[\s\S]{1,3000}/g) || [text];
    const chunks: Buffer[] = [];
    for (const input of parts) {
      const res = await fetch(`${this.config.audioBase}/audio/speech`, {
        method: 'POST',
        signal: AbortSignal.timeout(65000),
        headers: {
          Authorization: `Bearer ${this.config.audioKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.ttsModel,
          input,
          voice: this.config.voice,
          response_format: this.pcm ? 'pcm' : 'mp3',
        }),
      });
      if (!res.ok)
        throw new Error(
          `Sintesi vocale non riuscita (${res.status}). Puoi riprovare senza rieseguire il task.`,
        );
      const data = Buffer.from(await res.arrayBuffer());
      if (!data.length || data.length > 20_000_000) throw new Error('Risposta audio non valida.');
      chunks.push(data);
    }
    const dir = path.join(this.config.dataDir, 'audio');
    await mkdir(dir, { recursive: true });
    const data = Buffer.concat(chunks);
    await writeFile(path.join(dir, `${key}.tmp`), this.pcm ? pcmToWav(data) : data, {
      mode: 0o600,
    });
    await rename(
      path.join(dir, `${key}.tmp`),
      path.join(dir, `${key}.${this.pcm ? 'wav' : 'mp3'}`),
    );
    return key;
  }
}
// Gemini speech output is signed 16-bit little-endian PCM, 24 kHz, mono.
export function pcmToWav(pcm: Buffer) {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
