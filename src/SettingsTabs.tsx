export type SettingsTab = 'voice' | 'mcp' | 'skills' | 'terminal' | 'experiments';
const tabs: [SettingsTab, string][] = [
  ['voice', 'Voce'],
  ['mcp', 'MCP'],
  ['skills', 'Skill'],
  ['terminal', 'Terminale'],
  ['experiments', 'Sperimentali'],
];
export function SettingsTabs({
  current,
  onTab,
  disabled = false,
}: {
  current: SettingsTab;
  onTab(tab: SettingsTab): void;
  disabled?: boolean;
}) {
  return (
    <nav className="settings-tabs" aria-label="Sezioni impostazioni">
      {tabs.map(([id, name]) => (
        <button
          key={id}
          type="button"
          disabled={disabled}
          aria-current={current === id ? 'page' : undefined}
          onClick={() => onTab(id)}
        >
          {name}
        </button>
      ))}
    </nav>
  );
}
