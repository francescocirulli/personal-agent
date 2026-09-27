import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { Agent } from './store';
import { effortLevels, type Effort } from './agent-effort';

export interface AgentModel {
  id: string;
  name: string;
  description: string;
  efforts: Effort[];
  defaultEffort?: Effort;
  contextWindow?: number;
  modalities: string[];
}
export interface AgentCatalog {
  models: AgentModel[];
  source: string;
  fetchedAt: string | null;
}

export const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/)
  .nullable();
export async function agentModels(agent: Agent, demo = false): Promise<AgentCatalog> {
  if (agent === 'claude')
    return {
      models: ['opus', 'sonnet', 'haiku'].map((id) => ({
        id,
        name: id,
        description: '',
        efforts: [],
        modalities: [],
      })),
      fetchedAt: null,
      source: 'Alias Claude Code; disponibilità dipendente dalla subscription.',
    };
  if (demo)
    return {
      models: ['Astra', 'Sol', 'Luna'].map((name) => ({
        id: `gpt-6-${name.toLowerCase()}`,
        name: `GPT-6-${name}`,
        description: 'Modello dimostrativo',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        contextWindow: 272000,
        modalities: ['text', 'image'],
      })),
      fetchedAt: null,
      source: 'Catalogo dimostrativo; nessuna richiesta reale.',
    };
  try {
    const home = process.env.AGENT_CODEX_HOME || path.join(homedir(), '.codex');
    const cache = JSON.parse(await readFile(path.join(home, 'models_cache.json'), 'utf8'));
    const models = z
      .array(
        z.object({
          slug: z.string(),
          display_name: z.string(),
          visibility: z.string().optional(),
          description: z.string().optional(),
          supported_reasoning_levels: z.array(z.object({ effort: z.string() })).optional(),
          default_reasoning_level: z.string().optional(),
          context_window: z.number().positive().optional(),
          input_modalities: z.array(z.string()).optional(),
        }),
      )
      .parse(cache.models);
    return {
      models: models
        .filter((m) => m.visibility !== 'hide' && modelSchema.safeParse(m.slug).success)
        .map((m) => ({
          id: m.slug,
          name: m.display_name,
          description: (m.description || '').slice(0, 500),
          efforts: (m.supported_reasoning_levels || [])
            .map((level) => level.effort)
            .filter((effort): effort is Effort => effortLevels.codex.includes(effort as Effort)),
          defaultEffort: effortLevels.codex.includes(m.default_reasoning_level as Effort)
            ? (m.default_reasoning_level as Effort)
            : undefined,
          contextWindow: m.context_window,
          modalities: m.input_modalities || [],
        })),
      fetchedAt: typeof cache.fetched_at === 'string' ? cache.fetched_at : null,
      source:
        'Catalogo locale della CLI Codex, aggiornato dalla CLI. Disponibilità dipendente dalla subscription.',
    };
  } catch {
    return {
      models: [],
      fetchedAt: null,
      source:
        'Catalogo Codex non disponibile: usa il predefinito o inserisci un ID modello supportato dalla tua subscription.',
    };
  }
}
