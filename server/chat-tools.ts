import { z } from 'zod';
import type { McpView } from './mcp';
import type { SkillView } from './skills';
import type { Agent } from './store';

// null follows global availability; [] explicitly selects nothing.
const selection = (max: number) =>
  z
    .array(z.string().uuid())
    .max(max)
    .transform((ids) => [...new Set(ids)])
    .nullable();
export const chatToolsInput = z
  .object({
    mcp: selection(20).default(null),
    skills: selection(100).default([]),
  })
  .strict();
export type ChatTools = z.infer<typeof chatToolsInput>;

export function mcpAvailability(
  item: Pick<McpView, 'id' | 'enabled' | 'status'>,
  selected?: string[] | null,
) {
  const included = selected == null || selected.includes(item.id);
  const reason = !included
    ? 'Escluso da questa chat'
    : item.enabled === false
      ? 'Disabilitato globalmente'
      : item.status === 'authorization_required'
        ? 'Accesso richiesto'
        : item.status === 'error'
          ? 'Collegamento da verificare'
          : item.status !== 'connected'
            ? 'Collegamento in corso'
            : null;
  return { selected: included, available: reason === null, reason };
}

export function skillAvailability(item: SkillView, agent: Agent, selected?: string[] | null) {
  const included = selected == null || selected.includes(item.id);
  const reason = !included
    ? 'Esclusa da questa chat'
    : item.enabled === false
      ? 'Disabilitata globalmente'
      : !item.agents.includes(agent)
        ? 'Non abilitata per questo agente'
        : null;
  return { selected: included, available: reason === null, reason };
}

export interface ChatToolsView {
  conversationId: string;
  selection: ChatTools;
  mcp: (McpView & ReturnType<typeof mcpAvailability>)[];
  skills: (SkillView & ReturnType<typeof skillAvailability>)[];
  project: { skills: SkillView[]; warnings: string[]; ready: boolean };
}
