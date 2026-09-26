import { z } from 'zod';

const model = z
  .string()
  .trim()
  .min(3)
  .max(180)
  .regex(/^[\w.:-]+\/[\w.:-]+$/);
export const audioSettingsSchema = z
  .object({
    sttModel: model,
    ttsModel: model,
    voice: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[\w.: -]+$/),
  })
  .strict();
export type AudioSettings = z.infer<typeof audioSettingsSchema>;
export interface AudioModel {
  id: string;
  name: string;
}
export interface AudioCatalog {
  stt: AudioModel[];
  tts: AudioModel[];
}
export class AudioModels {
  private cached?: { at: number; value: AudioCatalog };
  constructor(
    private base: string,
    private demo: boolean,
  ) {}
  async list(): Promise<AudioCatalog> {
    if (this.demo)
      return {
        stt: [{ id: 'openai/gpt-4o-transcribe', name: 'GPT-4o Transcribe' }],
        tts: [{ id: 'google/gemini-3.8-flash-lite-tts', name: 'Gemini Flash Lite TTS' }],
      };
    if (this.cached && Date.now() - this.cached.at < 300000) return this.cached.value;
    const read = async (modality: string) => {
      const response = await fetch(`${this.base}/models?output_modalities=${modality}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Catalogo OpenRouter non disponibile. Riprova tra poco.');
      const body = (await response.json()) as {
        data: { id: string; name: string; architecture?: { output_modalities?: string[] } }[];
      };
      return body.data
        .filter((m) => m.architecture?.output_modalities?.includes(modality))
        .map((m) => ({ id: m.id, name: m.name }));
    };
    const [stt, tts] = await Promise.all([read('transcription'), read('speech')]);
    const value = { stt, tts };
    this.cached = { at: Date.now(), value };
    return value;
  }
}
