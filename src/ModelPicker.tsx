import { defaultEffort, effortLevels, type Effort } from '../server/agent-effort';
import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { api, type Chat } from './api';
import { AgentLogo } from './AgentLogo';
import type { ExperimentView } from '../server/experiments';

export function ModelPicker({ chat, onSaved }: { chat: Chat; onSaved(): Promise<void> }) {
  const [experiments, setExperiments] = useState<ExperimentView>();
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      try {
        const next = await api<ExperimentView>('/settings/experiments');
        if (!disposed) setExperiments(next);
      } catch {
        if (!disposed) setExperiments(undefined);
      }
    }
    if (chat.routing?.enabled) void refresh();
    window.addEventListener('experiments-change', refresh);
    return () => {
      disposed = true;
      window.removeEventListener('experiments-change', refresh);
    };
  }, [chat.routing?.enabled]);
  const automatic =
    chat.routing?.enabled &&
    experiments?.enabled &&
    experiments.smartRouting &&
    (experiments.configured || experiments.demo);
  const [catalog, setCatalog] = useState<{
    models: { id: string; name: string }[];
    source: string;
  }>({ models: [], source: '' });
  const [custom, setCustom] = useState(false),
    [value, setValue] = useState('');
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    api<typeof catalog>(`/conversations/${chat.id}/models`)
      .then((c) => {
        if (!disposed) setCatalog(c);
      })
      .catch(() => {
        if (!disposed) setError('Catalogo non disponibile. Puoi inserire un ID modello.');
      });
    return () => {
      disposed = true;
    };
  }, [chat.id]);
  async function saveEffort(effort: Effort) {
    setPending(true);
    setError('');
    try {
      await api(`/conversations/${chat.id}/effort`, { effort });
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function save(model: string | null) {
    setPending(true);
    setError('');
    try {
      await api(`/conversations/${chat.id}/model`, { model });
      await onSaved();
      setCustom(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  const modelName = chat.model
    ? catalog.models.find((model) => model.id === chat.model)?.name || chat.model
    : 'Modello predefinito';
  const actual = chat.actualModel;
  const displayedModel = chat.modelPending
    ? 'Rilevamento modello…'
    : actual?.state === 'running' || (!chat.model && actual)
      ? actual!.id
      : modelName;
  const modelStatus = actual
    ? `${actual.state === 'running' ? 'In uso' : 'Ultimo modello usato'}: ${actual.id}`
    : chat.modelPending
      ? 'In attesa del modello comunicato dalla CLI.'
      : 'Modello effettivo non ancora rilevato.';
  const contextUsage = chat.contextUsage;
  const contextCount = contextUsage
    ? new Intl.NumberFormat('it-IT', { notation: 'compact', maximumFractionDigits: 1 }).format(
        contextUsage.inputTokens,
      )
    : '';
  const contextPercentage =
    contextUsage?.contextWindow && contextUsage.contextWindow > 0
      ? Math.min(100, (contextUsage.inputTokens / contextUsage.contextWindow) * 100)
      : null;
  const contextLabel = contextUsage
    ? `Ultimo contesto rilevato dalla CLI: ${contextUsage.inputTokens.toLocaleString('it-IT')} token${
        contextUsage.contextWindow
          ? ` su ${contextUsage.contextWindow.toLocaleString('it-IT')} (${contextPercentage!.toLocaleString('it-IT', { maximumFractionDigits: 1 })}%)`
          : ''
      }${contextUsage.state === 'running' ? ' · aggiornato durante il lavoro' : ' · ultima rilevazione'}`
    : 'Contesto non ancora comunicato dalla CLI.';
  return (
    <details className="model-picker">
      <summary>
        <AgentLogo agent={chat.agent} />
        <span className="model-picker-current">
          <span className="model-picker-agent">
            {chat.agent === 'claude' ? 'Claude Code' : 'Codex'}
          </span>
          <span className="model-picker-name" title={modelStatus}>
            {automatic
              ? `Automatico · JEV${actual ? ` · ${actual.id}` : ''}`
              : chat.routing?.enabled
                ? `JEV sospeso · ${displayedModel}`
                : displayedModel}
          </span>
          <span className="model-picker-effort">
            {automatic ? 'effort auto' : (chat.effort ?? defaultEffort)}
          </span>
          {contextUsage && (
            <span className="model-picker-context" title={contextLabel}>
              {contextCount}
              {contextPercentage !== null
                ? ` · ${contextPercentage.toLocaleString('it-IT', { maximumFractionDigits: 0 })}%`
                : ' token'}
            </span>
          )}
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <div className="model-picker-panel">
        <div className="model-picker-observed" role="status">
          <p>{modelStatus}</p>
          <p>{contextLabel}</p>
        </div>
        <p className="settings-note">
          {chat.routing?.enabled
            ? `Riserva: ${modelName} · ${chat.effort}. Una scelta manuale disattiva JEV.`
            : 'Le modifiche si applicano dal prossimo messaggio.'}
        </p>
        <label>
          Modello
          <select
            aria-label="Modello della chat"
            value={custom ? '__custom' : chat.model || ''}
            disabled={pending}
            onChange={(e) => {
              if (e.target.value === '__custom') {
                setCustom(true);
                setValue(chat.model || '');
              } else void save(e.target.value || null);
            }}
          >
            <option value="">
              Predefinito CLI / sessione{!chat.model && actual ? ` · ${actual.id}` : ''}
            </option>
            {chat.model && !catalog.models.some((m) => m.id === chat.model) && (
              <option value={chat.model}>{chat.model}</option>
            )}
            {catalog.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            <option value="__custom">Altro modello…</option>
          </select>
        </label>
        <label>
          Effort
          <select
            aria-label="Effort della chat"
            value={chat.effort ?? defaultEffort}
            disabled={pending}
            onChange={(e) => void saveEffort(e.target.value as Effort)}
          >
            {effortLevels[chat.agent].map((effort) => (
              <option key={effort} value={effort}>
                {effort}
                {effort === defaultEffort ? ' (predefinito)' : ''}
              </option>
            ))}
          </select>
        </label>
        {custom && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save(value.trim());
            }}
          >
            <input
              aria-label="ID modello"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={160}
              required
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="ID modello della CLI"
            />
            <button disabled={pending || !value.trim()}>Salva modello</button>
            <button type="button" onClick={() => setCustom(false)}>
              Annulla
            </button>
          </form>
        )}
        <small>
          Dal prossimo messaggio. {catalog.source} I livelli di effort supportati dipendono dal
          modello.
        </small>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
