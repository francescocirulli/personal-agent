export type AgentCommand = '/context' | '/status' | '/usage' | '/compact';

export function agentCommands(agent: 'claude' | 'codex') {
  return [
    agent === 'claude'
      ? { name: '/context' as const, description: 'Mostra come è occupato il contesto' }
      : { name: '/status' as const, description: 'Mostra modello e contesto della sessione' },
    { name: '/usage' as const, description: 'Mostra i consumi disponibili dalla CLI' },
    { name: '/compact' as const, description: 'Compatta la chat per liberare contesto' },
  ];
}

export function parseAgentCommand(agent: 'claude' | 'codex', text: string): AgentCommand | null {
  const value = text.trim();
  if (!value.startsWith('/')) return null;
  const command = agentCommands(agent).find((item) => item.name === value);
  if (!command)
    throw new Error(
      `Comando non supportato. Usa ${agentCommands(agent)
        .map((item) => item.name)
        .join(', ')} senza argomenti o allegati.`,
    );
  return command.name;
}
