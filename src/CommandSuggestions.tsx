import { agentCommands } from './agentCommands';

export function CommandSuggestions({
  agent,
  draft,
  disabled,
  onSelect,
}: {
  agent: 'claude' | 'codex';
  draft: string;
  disabled: boolean;
  onSelect(value: string): void;
}) {
  if (!/^\s*\/\w*$/.test(draft)) return null;
  const commands = agentCommands(agent).filter((command) => command.name.startsWith(draft.trim()));
  return (
    <div className="command-suggestions" role="region" aria-label="Comandi della chat">
      <small>Comandi {agent === 'claude' ? 'Claude Code' : 'Codex'}</small>
      {commands.length ? (
        commands.map((command) => (
          <button
            type="button"
            key={command.name}
            disabled={disabled}
            onClick={() => onSelect(command.name)}
          >
            <strong>{command.name}</strong>
            <span>{command.description}</span>
          </button>
        ))
      ) : (
        <p>Comando non disponibile. Scrivi / per vedere quelli supportati.</p>
      )}
      <small>Seleziona un comando, poi invia. Durante un lavoro verrà messo in coda.</small>
    </div>
  );
}
