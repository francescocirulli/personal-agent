import { z } from 'zod';
import { effortLevels, type Effort } from './agent-effort';

export const experimentsSchema = z
  .object({ enabled: z.boolean(), smartRouting: z.boolean() })
  .strict();
export type Experiments = z.infer<typeof experimentsSchema>;
export const experimentsOff: Experiments = { enabled: false, smartRouting: false };
const pairSchema = z
  .object({
    model: z
      .string()
      .max(160)
      .regex(/^gpt-[a-zA-Z0-9._-]+$/),
    effort: z.enum(effortLevels.codex),
  })
  .strict();
export const routingSchema = z
  .object({
    enabled: z.boolean(),
    preference: z.enum(['balanced', 'speed', 'quality']),
    candidates: z.array(pairSchema).min(1).max(254),
    fallback: pairSchema,
  })
  .strict()
  .refine(
    (value) => new Set(value.candidates.map(pairKey)).size === value.candidates.length,
    'Modelli e livelli di effort duplicati.',
  );
export type RoutingConfig = z.infer<typeof routingSchema>;
export type ModelEffort = { model: string; effort: Effort };
export const pairKey = (pair: ModelEffort) => `${pair.model}/${pair.effort}`;
export interface ExperimentView extends Experiments {
  configured: boolean;
  demo: boolean;
}
export interface RoutingRecord {
  selected: { model: string | null; effort: Effort };
  source: 'jev' | 'fallback' | 'continuity' | 'demo' | 'manual';
  reason?: string;
  latencyMs: number;
  policy: string;
  catalogFetchedAt: string | null;
  candidates: ModelEffort[];
  decisionId?: string;
  decisionModel?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  cost?: number;
  inputTokens?: number;
}
export const routingReasons: Record<string, string> = {
  disabled: 'Routing disattivato: uso il modello di riserva.',
  manual: 'Scelta manuale applicata prima dell’avvio della CLI.',
  unconfigured: 'OpenRouter non configurato: uso il modello di riserva.',
  catalog: 'Catalogo non disponibile o cambiato: uso il modello di riserva.',
  attachments: 'Gli allegati richiedono il modello di riserva.',
  uncertain: 'Scelta incerta: uso il modello di riserva.',
  unavailable: 'JEV non disponibile: uso il modello di riserva.',
  timeout: 'JEV non ha risposto in tempo: uso il modello di riserva.',
  context: 'Contesto non compatibile: uso il modello di riserva.',
  continuity: 'Mantengo il modello precedente per continuità.',
  demo: 'Dimostrazione: nessuna richiesta JEV o CLI reale.',
};
