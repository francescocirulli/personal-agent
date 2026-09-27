import { useEffect, useState } from 'react';
import { api } from './api';
import type { ChatTools } from '../server/chat-tools';
import type { Agent } from '../server/store';
import type { McpView } from '../server/mcp';
import type { SkillView } from '../server/skills';

export function ChatToolsPicker({
  agent,
  value,
  onChange,
  disabled,
}: {
  agent: Agent;
  value: ChatTools;
  onChange(value: ChatTools): void;
  disabled: boolean;
}) {
  const [catalog, setCatalog] = useState<{ mcp: McpView[]; skills: SkillView[] }>();
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      try {
        const [mcp, skills] = await Promise.all([
          api<McpView[]>('/mcp'),
          api<SkillView[]>('/skills'),
        ]);
        if (!disposed) {
          setCatalog({ mcp, skills });
          setError('');
        }
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    }
    void refresh();
    window.addEventListener('mcp-change', refresh);
    window.addEventListener('skills-change', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      window.removeEventListener('mcp-change', refresh);
      window.removeEventListener('skills-change', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return (
    <details className="chat-tools-picker">
      <summary>
        MCP e skill per questa chat
        {value.mcp !== null || value.skills !== null ? ' · Personalizzati' : ' · Globali'}
      </summary>
      <p className="settings-note">
        Scegli tra quelli abilitati in Impostazioni. Le disattivazioni globali hanno sempre
        precedenza.
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error} Chiudi e riapri la finestra per riprovare.
        </p>
      )}
      {!catalog && !error && <p role="status">Carico MCP e skill…</p>}
      {(['mcp', 'skills'] as const).map((kind) => {
        const title = kind === 'mcp' ? 'MCP' : 'Skill globali';
        const rows = (catalog?.[kind] || []).map((item) => {
          const reason =
            item.enabled === false
              ? 'Disabilitato globalmente'
              : 'agents' in item && !item.agents.includes(agent)
                ? 'Non abilitata per questo agente'
                : 'status' in item && item.status !== 'connected'
                  ? 'Collegamento da completare'
                  : '';
          return { id: item.id, name: item.name, reason };
        });
        const selected = value[kind];
        return (
          <fieldset key={kind} disabled={disabled || !catalog || !!error}>
            <legend>{title}</legend>
            <label className="tool-choice">
              <input
                type="checkbox"
                checked={selected === null}
                onChange={(e) =>
                  onChange({
                    ...value,
                    [kind]: e.target.checked
                      ? null
                      : rows.filter((r) => !r.reason).map((r) => r.id),
                  })
                }
              />
              Usa disponibilità globali · {title}
            </label>
            {selected === null && <small>Include anche quelli che abiliterai in futuro.</small>}
            {catalog && rows.length === 0 && (
              <p className="settings-note">Nessun elemento configurato.</p>
            )}
            {rows.map((row) => (
              <label className="tool-choice" key={row.id}>
                <input
                  type="checkbox"
                  disabled={selected === null || !!row.reason}
                  checked={!row.reason && (selected === null || selected.includes(row.id))}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      [kind]: e.target.checked
                        ? [...(selected || []), row.id]
                        : (selected || []).filter((id) => id !== row.id),
                    })
                  }
                />
                <span>
                  {row.name}
                  {row.reason && <small>{row.reason}</small>}
                </span>
              </label>
            ))}
            {selected?.length === 0 && (
              <small>
                Nessun {kind === 'mcp' ? 'MCP' : 'elemento globale'} selezionato per questa chat.
              </small>
            )}
          </fieldset>
        );
      })}
      <p className="settings-note">
        Le skill del repository restano disponibili per entrambi gli agenti.
      </p>
    </details>
  );
}
