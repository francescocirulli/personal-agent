import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { Agent } from './store';

export const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/)
  .nullable();
export async function agentModels(agent: Agent) {
  if (agent === 'claude')
    return {
      models: ['opus', 'sonnet', 'haiku'].map((id) => ({ id, name: id })),
      source: 'Alias Claude Code; disponibilità dipendente dalla subscription.',
    };
  try {
    const home = process.env.AGENT_CODEX_HOME || path.join(homedir(), '.codex');
    const cache = JSON.parse(await readFile(path.join(home, 'models_cache.json'), 'utf8'));
    const models = z
      .array(
        z.object({ slug: z.string(), display_name: z.string(), visibility: z.string().optional() }),
      )
      .parse(cache.models);
    return {
      models: models
        .filter((m) => m.visibility !== 'hide' && modelSchema.safeParse(m.slug).success)
        .map((m) => ({ id: m.slug, name: m.display_name })),
      source:
        'Catalogo locale della CLI Codex, aggiornato dalla CLI. Disponibilità dipendente dalla subscription.',
    };
  } catch {
    return {
      models: [],
      source:
        'Catalogo Codex non disponibile: usa il predefinito o inserisci un ID modello supportato dalla tua subscription.',
    };
  }
}
